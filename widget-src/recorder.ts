export type Recorder = {
  start(): void;
  stop(): Promise<{ blob: Blob; sizeBytes: number }>;
  isRecording(): boolean;
  dispose(): void;
};

function pickMimeType(): string | undefined {
  const candidates = [
    "audio/webm",
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
  ];
  for (const mt of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(mt)) return mt;
  }
  return undefined;
}

export function createRecorder(stream: MediaStream): Recorder {
  const chunks: BlobPart[] = [];
  let mr: MediaRecorder | null = null;
  let recording = false;

  const mimeType = pickMimeType();
  const blobType = (mimeType ?? "audio/webm").split(";")[0] || "audio/webm";

  function ensureMr() {
    if (mr) return mr;
    mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    mr.onerror = () => {
      // swallow; caller handles via state machine error recovery
    };
    return mr;
  }

  return {
    start() {
      if (recording) return;
      chunks.length = 0;
      recording = true;
      const r = ensureMr();
      r.start(200);
    },
    async stop() {
      if (!recording) {
        const empty = new Blob([], { type: blobType });
        return { blob: empty, sizeBytes: 0 };
      }
      recording = false;
      const r = ensureMr();
      if (r.state === "inactive") {
        const blob = new Blob(chunks, { type: blobType });
        return { blob, sizeBytes: blob.size };
      }
      await new Promise<void>((resolve) => {
        r.onstop = () => resolve();
        try {
          r.stop();
        } catch {
          resolve();
        }
      });
      const blob = new Blob(chunks, { type: blobType });
      return { blob, sizeBytes: blob.size };
    },
    isRecording() {
      return recording;
    },
    dispose() {
      try {
        mr?.stop();
      } catch {}
      mr = null;
      chunks.length = 0;
      recording = false;
    },
  };
}


