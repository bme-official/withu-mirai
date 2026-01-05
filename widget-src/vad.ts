import { VAD_CONFIG } from "./constants";

export type VadCallbacks = {
  onSpeechStart(): void;
  onSpeechEnd(result: { durationMs: number; sizeBytes: number; blob: Blob }): void;
  onDebug?(info: { rms: number }): void;
  onError(err: Error): void;
};

export type VadController = {
  start(): Promise<void>;
  stop(opts?: { stopStream?: boolean }): void;
  isRunning(): boolean;
  getStream(): MediaStream;
};

export type RecorderLike = {
  start(): void;
  stop(): Promise<{ blob: Blob; sizeBytes: number }>;
  isRecording(): boolean;
};

type Internal = {
  stream: MediaStream;
  audioCtx: AudioContext | null;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  rafId: number | null;
  running: boolean;

  inSpeech: boolean;
  speechStartAt: number;
  lastVoiceAt: number;
};

function nowMs() {
  return performance.now();
}

function computeRmsFromAnalyser(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

export function createVad(stream: MediaStream, recorder: RecorderLike, cb: VadCallbacks): VadController {
  const st: Internal = {
    stream,
    audioCtx: null,
    analyser: null,
    source: null,
    rafId: null,
    running: false,
    inSpeech: false,
    speechStartAt: 0,
    lastVoiceAt: 0,
  };

  let buf: Float32Array<ArrayBuffer> | null = null;

  async function ensureAudioGraph() {
    if (st.audioCtx && st.analyser && st.source) return;
    st.audioCtx = new AudioContext();
    st.source = st.audioCtx.createMediaStreamSource(st.stream);
    st.analyser = st.audioCtx.createAnalyser();
    st.analyser.fftSize = 2048;
    st.source.connect(st.analyser);
    // TS 5.9+ typed arrays default to ArrayBufferLike; getFloatTimeDomainData expects ArrayBuffer-backed Float32Array
    buf = new Float32Array(new ArrayBuffer(st.analyser.fftSize * 4));
  }

  function cleanupGraph() {
    if (st.rafId) cancelAnimationFrame(st.rafId);
    st.rafId = null;
    st.running = false;
    st.inSpeech = false;

    try {
      st.source?.disconnect();
    } catch {}
    st.source = null;
    st.analyser = null;

    if (st.audioCtx) {
      try {
        st.audioCtx.close();
      } catch {}
    }
    st.audioCtx = null;

    // keep stream allocated unless explicitly stopped by caller? (we stop on controller.stop)
  }

  function stopStreamTracks() {
    try {
      st.stream.getTracks().forEach((t) => t.stop());
    } catch {}
  }

  async function endSpeech(reason: "silence" | "max") {
    try {
      const durationMs = Math.max(0, nowMs() - st.speechStartAt);
      const { blob, sizeBytes } = await recorder.stop();
      st.inSpeech = false;

      if (durationMs < VAD_CONFIG.minSpeechMs) return;
      cb.onSpeechEnd({ durationMs, sizeBytes, blob });
    } catch (e) {
      cb.onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  function tick() {
    if (!st.running || !st.analyser || !buf) return;

    const rms = computeRmsFromAnalyser(st.analyser, buf);
    cb.onDebug?.({ rms });

    const t = nowMs();
    const isVoice = rms >= VAD_CONFIG.rmsThreshold;

    if (!st.inSpeech) {
      if (isVoice) {
        st.inSpeech = true;
        st.speechStartAt = t;
        st.lastVoiceAt = t;
        try {
          recorder.start();
        } catch (e) {
          cb.onError(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        cb.onSpeechStart();
      }
    } else {
      if (isVoice) st.lastVoiceAt = t;
      const speechMs = t - st.speechStartAt;
      const silenceMs = t - st.lastVoiceAt;
      if (speechMs >= VAD_CONFIG.maxSpeechMs) {
        void endSpeech("max");
      } else if (silenceMs >= VAD_CONFIG.silenceMs) {
        void endSpeech("silence");
      }
    }

    st.rafId = requestAnimationFrame(tick);
  }

  return {
    async start() {
      if (st.running) return;
      try {
        await ensureAudioGraph();
        // iOS: resume audio context after user gesture
        if (st.audioCtx?.state === "suspended") await st.audioCtx.resume();
        st.running = true;
        st.rafId = requestAnimationFrame(tick);
      } catch (e) {
        cb.onError(e instanceof Error ? e : new Error(String(e)));
      }
    },
    stop(opts) {
      const stopStream = opts?.stopStream !== false;
      // Allow stopping even if not running (e.g. after a speech segment),
      // to ensure recorder/audio graph are cleaned up.
      st.running = false;
      if (st.rafId) cancelAnimationFrame(st.rafId);
      st.rafId = null;
      // stop any ongoing recording
      if (recorder.isRecording()) {
        void recorder.stop();
      }
      cleanupGraph();
      if (stopStream) stopStreamTracks();
    },
    isRunning() {
      return st.running;
    },
    getStream() {
      return st.stream;
    },
  };
}
