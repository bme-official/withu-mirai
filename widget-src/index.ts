import { STORAGE_KEYS } from "./constants";
import { createApiClient } from "./api";
import { createRecorder } from "./recorder";
import { reduceState, type WidgetState } from "./stateMachine";
import { createUi } from "./ui";
import { createVad } from "./vad";

declare global {
  interface Window {
    __WITHU_VOICE_WIDGET__?: boolean;
  }
}

function getEmbedScript(): HTMLScriptElement | null {
  const cur = document.currentScript as HTMLScriptElement | null;
  if (cur && cur.tagName === "SCRIPT") return cur;
  const scripts = Array.from(document.querySelectorAll("script[src]")) as HTMLScriptElement[];
  return scripts[scripts.length - 1] ?? null;
}

function msSince(t0: number) {
  return Math.round(performance.now() - t0);
}

function safeErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function speakWithWebSpeech(text: string, voiceHint: string | null): Promise<{ ttsMs: number } | null> {
  if (typeof window === "undefined") return null;
  if (!("speechSynthesis" in window)) return null;
  async function getVoicesStable(timeoutMs = 800): Promise<SpeechSynthesisVoice[]> {
    try {
      const v0 = window.speechSynthesis.getVoices?.() ?? [];
      if (v0.length > 0) return v0;
      return await new Promise((resolve) => {
        let done = false;
        const timer = window.setTimeout(() => {
          if (done) return;
          done = true;
          resolve(window.speechSynthesis.getVoices?.() ?? []);
        }, timeoutMs);
        window.speechSynthesis.onvoiceschanged = () => {
          if (done) return;
          done = true;
          window.clearTimeout(timer);
          resolve(window.speechSynthesis.getVoices?.() ?? []);
        };
        // trigger
        window.speechSynthesis.getVoices?.();
      });
    } catch {
      return [];
    }
  }
  // Prepare voice selection BEFORE calling speak() to avoid "no sound" on some browsers.
  const ut = new SpeechSynthesisUtterance(text);
  ut.lang = document.documentElement.lang || "en-US";
  ut.rate = 1.0;
  ut.pitch = 1.0;
  ut.volume = 1.0;
  if (voiceHint) {
    const voices = await getVoicesStable();
    const v =
      voices.find((vv) => vv.name === voiceHint) ??
      voices.find((vv) => vv.lang === voiceHint) ??
      voices.find((vv) => vv.name.includes(voiceHint) || vv.lang.includes(voiceHint));
    if (v) {
      ut.voice = v;
      ut.lang = v.lang || ut.lang;
    } else {
      if (/^[a-z]{2}(-[A-Z]{2})?$/.test(voiceHint)) ut.lang = voiceHint;
    }
  }

  return await new Promise((resolve) => {
    const t0 = performance.now();
    ut.onend = () => resolve({ ttsMs: msSince(t0) });
    ut.onerror = () => resolve({ ttsMs: msSince(t0) });
    try {
      window.speechSynthesis.cancel();
      // Some browsers can be paused; resume best-effort.
      try {
        (window.speechSynthesis as any).resume?.();
      } catch {}
      window.speechSynthesis.speak(ut);
    } catch {
      resolve(null);
    }
  });
}

async function main() {
  if (window.__WITHU_VOICE_WIDGET__) return;
  window.__WITHU_VOICE_WIDGET__ = true;

  const script = getEmbedScript();
  if (!script?.src) return;

  const baseUrl = new URL(script.src).origin;
  const siteId = script.dataset.siteId || "unknown";
  const api = createApiClient(baseUrl, siteId);
  const overrideDisplayName = script.dataset.displayName || null;
  const overrideAvatarUrl = script.dataset.avatarUrl || null;
  const userIdStorageKey = `${STORAGE_KEYS.userIdPrefix}${siteId}`;
  const layout = (script.dataset.layout || script.dataset.mode || "bubble") === "page" ? "page" : "bubble";
  let state: WidgetState = "idle";
  let inFlight = false;
  let vad: ReturnType<typeof createVad> | null = null;
  let stream: MediaStream | null = null;
  let recorder: ReturnType<typeof createRecorder> | null = null;
  let mode: "voice" | "text" = "voice";
  let ttsVoiceHint: string | null = null;
  let layoutMode: "bubble" | "page" = layout;
  let micMuted = false;
  let speakerMuted = false;
  let currentAudio: HTMLAudioElement | null = null;
  let currentAudioStop: (() => void) | null = null;
  let pendingListenAfterSpeak = false;
  let ttsCache: Map<string, Blob> | null = null;
  let ttsInflight: Map<string, Promise<Blob>> | null = null;
  let ttsCacheOrder: string[] | null = null;
  let gotUserGesture = false;
  let audioUnlocked = false;
  let lastAudioHintAt = 0;
  let bootGreetingText: string | null = null;
  let bootGreetingDisplayed = false;
  let bootGreetingSpoken = false;
  let bootGreetingInFlight: Promise<void> | null = null;
  let pendingStopVoiceAfterTurn = false;
  let intimacyLevel: number | null = null;

  async function unlockAudioOnce(reason: string) {
    if (audioUnlocked) return;
    try {
      // iOS Safari: HTMLMediaElement often needs a user-gesture play() at least once.
      // Play an almost-silent WAV to unlock media playback.
      try {
        const silentWav =
          "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==";
        const a = new Audio(silentWav);
        a.preload = "auto";
        a.muted = false;
        // Use a tiny non-zero volume; some iOS versions are picky about 0.
        a.volume = 0.001;
        (a as any).playsInline = true;
        const p = a.play();
        if (p && typeof (p as any).catch === "function") {
          await p;
        }
        try {
          a.pause();
        } catch {}
      } catch (e) {
        void api.log("audio_unlock_media_failed", { reason, message: safeErr(e) });
      }

      // This must run in or right after a user gesture to unlock audio playback on iOS Safari.
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      try {
        if (ctx.state === "suspended") await ctx.resume();
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        src.stop(0);
        // tiny delay to ensure the graph starts
        await new Promise((r) => window.setTimeout(r, 12));
      } finally {
        try {
          await ctx.close();
        } catch {}
      }
      audioUnlocked = true;
      void api.log("audio_unlocked", { reason });
    } catch (e) {
      void api.log("audio_unlock_failed", { reason, message: safeErr(e) });
    }
  }

  function shouldRetryTts(err: unknown): boolean {
    const m = safeErr(err);
    return /HTTP\s+(429|500|502|503)\b/.test(m) || /rate_limited|timeout/i.test(m);
  }

  async function playTestBeep(): Promise<{ ok: true } | { ok: false; err: string }> {
    try {
      // Short beep (WAV) for device audio verification.
      const b64 =
        "UklGRiQKAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAKAAAAAC8AkQDCAG0Ajv+L/gD+bP7W/7EBEgMhA5gB//6B/Gf7bvxa/+8CegWgBQ0Dwv6t+s34O/qL/uIDxAc4CMkE2P4S+Tr22Pds/YkE5wnhCsUGQv+497fzTfX/++AE3AuUDf8IAACj9krxoPJG+uUEng1JEG8LEQHY9fzu2O9G+JUEJQ/4EhEOdAJa9dTs/ewD9vADbBCZFd0QKAQu9dnqF+qo8+MCzBD+FqQSuwUx9ifrr+l18nIBxQ/cFnQTHweF98/rXulQ8QAAsA6iFjEUewjh+IzsJOk78I7+iw1RFtkUzwlF+lztAuk07x39WAzpFWwVGQuv+z/u9ug/7q/7GQtsFekVWAwd/TTvAulc7UX6zwnZFFEWiw2O/jvwJOmM7OH4ewgxFKIWsA4AAFDxXunP64X3Hwd0E9wWxQ9yAXXyr+kn6zH2uwWkEv4WzBDjAqjzF+qU6uf0UQTBEQoXwRFRBOf0lOoX6qjz4wLMEP4WpBK7BTH2J+uv6XXycgHFD9wWdBMfB4X3z+te6VDxAACwDqIWMRR7COH4jOwk6Tvwjv6LDVEW2RTPCUX6XO0C6TTvHf1YDOkVbBUZC6/7P+726D/ur/sZC2wV6RVYDB39NO8C6VztRfrPCdkUURaLDY7+O/Ak6Yzs4fh7CDEUohawDgAAUPFe6c/rhfcfB3QT3BbFD3IBdfKv6SfrMfa7BaQS/hbMEOMCqPMX6pTq5/RRBMERChfBEVEE5/SU6hfqqPPjAswQ/hakErsFMfYn66/pdfJyAcUP3BZ0Ex8HhffP617pUPEAALAOohYxFHsI4fiM7CTpO/CO/osNURbZFM8JRfpc7QLpNO8d/VgM6RVsFRkLr/s/7vboP+6v+xkLbBXpFVgMHf007wLpXO1F+s8J2RRRFosNjv478CTpjOzh+HsIMRSiFrAOAABQ8V7pz+uF9x8HdBPcFsUPcgF18q/pJ+sx9rsFpBL+FswQ4wKo8xfqlOrn9FEEwREKF8ERUQTn9JTqF+qo8+MCzBD+FqQSuwUx9ifrr+l18nIBxQ/cFnQTHweF98/rXulQ8QAAsA6iFjEUewjh+IzsJOk78I7+iw1RFtkUzwlF+lztAuk07x39WAzpFWwVGQuv+z/u9ug/7q/7GQtsFekVWAwd/TTvAulc7UX6zwnZFFEWiw2O/jvwJOmM7OH4ewgxFKIWsA4AAFDxXunP64X3Hwd0E9wWxQ9yAXXyr+kn6zH2uwWkEv4WzBDjAqjzF+qU6uf0UQTBEQoXwRFRBOf0lOoX6qjz4wLMEP4WpBK7BTH2J+uv6XXycgHFD9wWdBMfB4X3z+te6VDxAACwDqIWMRR7COH4jOwk6Tvwjv6LDVEW2RTPCUX6XO0C6TTvHf1YDMYVJxXkCsr7ze7T6Qbv5vt6ChUUaBRrC1n9rfAp6zrv4fq1CF8ShxPEC8H+f/KS7JbvCvoNB6gQiBLvCwAAQPQJ7hrwYPmFBfQObhHtCxYB7vWL78Lw4/geBEgNPRDCCwECg/cT8YrxlPjcAqYL+g5uC8EC/vid8nHycPjAARQKpw3zClUDXPol9HPzePjMAJMISQxWCr0Dmvun9Yv0qPgAACkH5AqXCfoDtfwg97f1APle/9cFfAm7CAwErP2L+PL2fvnm/qEEFAjEB/QDff7m+Tn4H/qZ/ooDsga2BrQDJ/8s+4j54Pp2/pMCWAWUBU0DqP9a/Nv6v/t9/sABCgRjBMECAABu/S78uPyt/hEBzAIlAxICLgBk/n39yf0F/4oAogHeAUIBMwA6/8T+7v6E/ykAjgCTAFUADgDu/wAA";
      const a = new Audio(`data:audio/wav;base64,${b64}`);
      a.preload = "auto";
      a.muted = false;
      a.volume = 1.0;
      (a as any).playsInline = true;
      a.setAttribute?.("playsinline", "");
      a.setAttribute?.("webkit-playsinline", "");
      const p = a.play();
      if (p && typeof (p as any).catch === "function") await p;
      return { ok: true };
    } catch (e) {
      const err = safeErr(e);
      void api.log("test_audio_failed", { message: err });
      return { ok: false, err };
    }
  }

  function stripEmojis(text: string): string {
    try {
      return text.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s{2,}/g, " ").trim();
    } catch {
      return text.replace(/[\u2600-\u27BF]/g, "").replace(/\s{2,}/g, " ").trim();
    }
  }

  async function getBootGreeting(reason: string): Promise<string> {
    try {
      const res = await api.greet(reason);
      const t = stripEmojis(String(res.greeting || "")).trim();
      if (t) return t;
      throw new Error("empty_greet");
    } catch {
      // fallback if greet API is unavailable
      return stripEmojis("Hi, I'm Mirai Aizawa. Want to chat for a minute?");
    }
  }

  async function speakWithServerTts(
    text: string,
    stream?: { setProgress(ratio: number): void; finish(): void },
  ): Promise<{ ttsMs: number } | null> {
    // If muted, don't generate/play audio, but still complete the "speaking" turn and reveal text.
    if (speakerMuted) {
      try {
        stream?.finish();
      } catch {}
      return { ttsMs: 0 };
    }
    try {
      const t0 = performance.now();
      // Small in-memory cache to avoid re-generating identical audio (e.g., repeated greetings).
      // Key is text only (siteId/provider are handled server-side); good enough for UX.
      const key = text.trim();
      if (!ttsCacheOrder) ttsCacheOrder = [];
      if (!ttsCache) ttsCache = new Map();
      if (!ttsInflight) ttsInflight = new Map();
      let blob = ttsCache.get(key) || null;
      if (!blob) {
        const existing = ttsInflight.get(key) || null;
        if (existing) {
          blob = await existing;
        } else {
          const p = (async () => {
            try {
              return await api.ttsAudio(text);
            } catch (e) {
              void api.log("tts_fetch_error", { message: safeErr(e) });
              if (shouldRetryTts(e)) {
                await new Promise((r) => window.setTimeout(r, 220));
                return await api.ttsAudio(text);
              }
              throw e;
            }
          })().finally(() => ttsInflight?.delete(key));
          ttsInflight.set(key, p);
          blob = await p;
        }
        // cap cache size
        ttsCache.set(key, blob);
        ttsCacheOrder.push(key);
        while (ttsCacheOrder.length > 20) {
          const k = ttsCacheOrder.shift();
          if (k) ttsCache.delete(k);
        }
      }
      const url = URL.createObjectURL(blob);
      try {
        const audio = new Audio(url);
        currentAudio = audio;
        let done = false;
        let raf: number | null = null;
        audio.preload = "auto";
        // iOS Safari: hints to avoid fullscreen playback / improve reliability.
        try {
          (audio as any).playsInline = true;
          audio.setAttribute?.("playsinline", "");
          audio.setAttribute?.("webkit-playsinline", "");
        } catch {}
        // Speaker mute should silence output but keep playback progressing.
        audio.muted = speakerMuted;
        audio.volume = speakerMuted ? 0.0 : 1.0;
        try {
          const playPromise = audio.play();
          if (playPromise && typeof (playPromise as any).catch === "function") {
            await playPromise;
          }
        } catch (e) {
          void api.log("audio_play_failed", { message: safeErr(e) });
          throw e;
        }
        // Stream text display along with playback progress (best-effort).
        if (stream) {
          const estDur = Math.max(1.2, text.length / 14); // ~14 chars/sec baseline
          const tick = () => {
            if (done) return;
            const d = Number(audio.duration);
            const dur = Number.isFinite(d) && d > 0 ? d : estDur;
            const ratio = dur > 0 ? Math.max(0, Math.min(1, audio.currentTime / dur)) : 0;
            stream.setProgress(ratio);
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        }
        // Enable barge-in while speaking (voice mode only).
        startBargeInMonitor();
        await new Promise<void>((resolve) => {
          const finish = () => {
            if (done) return;
            done = true;
            if (raf) cancelAnimationFrame(raf);
            raf = null;
            try {
              stream?.finish();
            } catch {}
            resolve();
          };
          // allow external interruption (barge-in)
          currentAudioStop = () => {
            try {
              audio.pause();
            } catch {}
            finish();
          };
          audio.onended = () => finish();
          audio.onerror = () => finish();
        });
      } finally {
        stopBargeInMonitor();
        currentAudio = null;
        currentAudioStop = null;
        URL.revokeObjectURL(url);
      }
      return { ttsMs: msSince(t0) };
    } catch {
      // If TTS fails (network/provider/autoplay), still show the full text.
      try {
        stream?.finish();
      } catch {}
      return null;
    }
  }

  function setState(next: WidgetState) {
    state = next;
    ui.setState(next);
    ui.setTextFallbackEnabled(next === "idle" && mode === "text" && !inFlight);
  }

  function setInFlight(next: boolean) {
    inFlight = next;
    ui.setTextFallbackEnabled(state === "idle" && mode === "text" && !inFlight);
  }

  function hasConsent() {
    return localStorage.getItem(STORAGE_KEYS.consent) === "accepted";
  }

  function ensureConsentUi() {
    ui.setConsentVisible(!hasConsent());
  }

  function stopVoicePipeline(opts?: { keepTts?: boolean; keepState?: boolean; keepInFlight?: boolean }) {
    try {
      vad?.stop({ stopStream: true });
    } catch {}
    vad = null;
    try {
      recorder?.dispose();
    } catch {}
    recorder = null;
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    stream = null;
    try {
      if (!opts?.keepTts) {
        currentAudio?.pause?.();
        currentAudio = null;
      }
    } catch {}
    const keepInFlight = opts?.keepInFlight ?? true;
    if (!keepInFlight) setInFlight(false);
    if (!opts?.keepState) setState("idle");
  }

  function stopAll(phase: string, message?: string) {
    try {
      vad?.stop({ stopStream: true });
    } catch {}
    vad = null;
    try {
      recorder?.dispose();
    } catch {}
    recorder = null;
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    stream = null;
    try {
      currentAudio?.pause?.();
      currentAudio = null;
    } catch {}
    setInFlight(false);
    setState("idle");
    if (message) ui.setError(message);
    void api.log("error", { phase, message: message ?? null });
  }

  async function speak(text: string, stream?: { setProgress(ratio: number): void; finish(): void }) {
    // Ensure VAD is never running while speaking (stop first, then proceed).
    if (speakerMuted) {
      void api.log("tts_muted", { len: text.length });
      // Inform user once in a while (mobile often looks like "no reply").
      const now = Date.now();
      if (now - lastAudioHintAt > 3500) {
        lastAudioHintAt = now;
        ui.setError("Speaker is muted.");
        window.setTimeout(() => ui.setError(null), 2000);
      }
      // Silent completion (text still finishes).
      return await speakWithServerTts(text, stream);
    }
    const res = await speakWithServerTts(text, stream);
    if (res) return res;
    // Fallback: if server TTS fails, try Web Speech so the user still hears something.
    try {
      const ws = await speakWithWebSpeech(text, ttsVoiceHint);
      void api.log("tts_fallback_webspeech", { ok: Boolean(ws) });
      if (ws) return ws;
    } catch (e) {
      void api.log("tts_fallback_webspeech_error", { message: safeErr(e) });
    }
    // If both fail, show a short hint (do not spam).
    const now = Date.now();
    if (now - lastAudioHintAt > 6000) {
      lastAudioHintAt = now;
      ui.setError("Audio couldn't play. Tap once to enable audio.");
      window.setTimeout(() => ui.setError(null), 3500);
    }
    return null;
  }

  async function ensureVoiceListening(reason: string) {
    if (mode !== "voice") return;
    if (micMuted) return;
    if (!hasConsent()) return;
    if (inFlight) return;
    if (state !== "idle") return;
    // Don't block voice chat if greeting audio can't play (e.g. speaker muted / autoplay blocked).
    // We still try to greet, but we allow listening once the greeting is at least displayed.
    if (!bootGreetingDisplayed && !bootGreetingSpoken) return;
    // If currently playing audio, do not start listening (wait until it finishes).
    if (currentAudio) return;
    if (pendingStopVoiceAfterTurn) return;

    // ensure mic stream
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        // Don't force-switch; user may need a gesture or permission.
        setState("idle");
        ui.setError("Microphone is unavailable. Check browser permissions and tap the page to try again.");
        void api.log("mic_permission", { message: safeErr(e) });
        return;
      }
    }

    if (!recorder) recorder = createRecorder(stream);
    vad = createVad(stream, recorder, {
      onSpeechStart() {
        void api.log("vad_speech_start");
      },
      onDebug({ rms }) {
        // Visualize mic input so users know we are hearing them.
        if (state === "listening") ui.setListeningRms(rms);
      },
      async onSpeechEnd({ durationMs, sizeBytes, blob }) {
        // Even if user switches to Text mid-utterance, finish the current voice turn.
        if (state !== "listening" || inFlight) return;
        setInFlight(true);

        setState(reduceState(state, { type: "VAD_DONE" }));

        // pause VAD during ASR/LLM/TTS but KEEP stream for continuous conversation
        try {
          vad?.stop({ stopStream: false });
        } catch {}
        vad = null;

        void api.log("vad_speech_end", { durationMs: Math.round(durationMs), sizeBytes });

        try {
          // Guard: ignore tiny blobs (can cause Whisper "invalid file format")
          if (sizeBytes < 1200) {
            void api.log("asr_skip_small_blob", { sizeBytes, durationMs: Math.round(durationMs), type: (blob as any)?.type ?? null });
            setInFlight(false);
            setState("idle");
            void ensureVoiceListening("small_blob_skip");
            return;
          }
          const asrT0 = performance.now();
          const { text } = await api.asr(blob);
          void api.log("asr_done", { asrMs: msSince(asrT0) });

          const userText = (text || "").trim();
          if (!userText) {
            stopAll("asr_empty", "I couldn't transcribe that. Please switch to Text mode and type your message.");
            mode = "text";
            ui.setMode("text");
            return;
          }

          ui.appendMessage("user", userText);

          const llmT0 = performance.now();
          const { assistantText, intimacy } = await api.chat(userText, "voice");
          void api.log("llm_done", { llmMs: msSince(llmT0) });

          const streamMsg = ui.appendAssistantStreaming(assistantText);
          intimacyLevel = intimacy?.level ?? intimacyLevel;
          ui.setIntimacy(intimacy?.level ?? null);
          setState(reduceState(state, { type: "LLM_DONE" }));

          const ttsT0 = performance.now();
          void api.log("tts_start");
          await speak(assistantText, streamMsg);
          void api.log("tts_end", { ttsMs: msSince(ttsT0) });

          setState(reduceState(state, { type: "TTS_END" }));
          setInFlight(false);
          // auto continue listening
          setState("idle");
          if (pendingStopVoiceAfterTurn || mode === "text") {
            pendingStopVoiceAfterTurn = false;
            stopVoicePipeline({ keepTts: true, keepState: false, keepInFlight: false });
          } else {
            void ensureVoiceListening("auto_continue");
          }
        } catch (e) {
          stopAll("pipeline", `Something went wrong: ${safeErr(e)}`);
        }
      },
      onError(err) {
        stopAll("vad", `VAD error: ${err.message}`);
      },
    });

    setState("listening");
    void api.log("listening_start", { reason, layout: layoutMode });
    await vad.start();
  }

  // Barge-in: if user starts speaking while TTS is playing, interrupt playback and go to listening.
  let bargeRaf: number | null = null;
  let bargeCtx: AudioContext | null = null;
  let bargeAnalyser: AnalyserNode | null = null;
  let bargeSrc: MediaStreamAudioSourceNode | null = null;
  let bargeBuf: Float32Array<ArrayBuffer> | null = null;

  function stopBargeInMonitor() {
    if (bargeRaf) cancelAnimationFrame(bargeRaf);
    bargeRaf = null;
    try {
      bargeSrc?.disconnect();
    } catch {}
    bargeSrc = null;
    bargeAnalyser = null;
    if (bargeCtx) {
      try {
        void bargeCtx.close();
      } catch {}
    }
    bargeCtx = null;
    bargeBuf = null;
  }

  function startBargeInMonitor() {
    stopBargeInMonitor();
    if (mode !== "voice") return;
    if (micMuted) return;
    if (!hasConsent()) return;
    if (!stream) return; // no mic available yet
    if (!currentAudio) return;
    // If output is muted, don't barge-in (avoid false positives while silent playback continues).
    if (speakerMuted || currentAudio.muted || currentAudio.volume === 0) return;

    try {
      bargeCtx = new AudioContext();
      bargeSrc = bargeCtx.createMediaStreamSource(stream);
      bargeAnalyser = bargeCtx.createAnalyser();
      bargeAnalyser.fftSize = 2048;
      bargeSrc.connect(bargeAnalyser);
      bargeBuf = new Float32Array(new ArrayBuffer(bargeAnalyser.fftSize * 4));
    } catch {
      stopBargeInMonitor();
      return;
    }

    const threshold = 0.09; // more conservative to avoid false positives from small noises
    const minHoldMs = 260;
    let aboveSince: number | null = null;

    const tick = () => {
      if (!bargeAnalyser || !bargeBuf) return;
      if (!currentAudio || mode !== "voice" || micMuted || speakerMuted || currentAudio.muted || currentAudio.volume === 0) {
        stopBargeInMonitor();
        return;
      }
      bargeAnalyser.getFloatTimeDomainData(bargeBuf);
      let sum = 0;
      for (let i = 0; i < bargeBuf.length; i++) {
        const v = bargeBuf[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / bargeBuf.length);
      const now = performance.now();
      if (rms >= threshold) {
        if (aboveSince == null) aboveSince = now;
        if (now - aboveSince >= minHoldMs) {
          // Interrupt TTS and start listening immediately.
          pendingListenAfterSpeak = false;
          void api.log("barge_in", { rms, threshold, holdMs: Math.round(now - aboveSince) });
          try {
            currentAudioStop?.();
          } catch {}
          stopBargeInMonitor();
          setState("idle");
          void ensureVoiceListening("barge_in");
          return;
        }
      } else {
        aboveSince = null;
      }
      bargeRaf = requestAnimationFrame(tick);
    };
    bargeRaf = requestAnimationFrame(tick);
  }

  async function maybeBootGreet(reason: string) {
    if (bootGreetingSpoken) return;
    if (!api.sessionId) return;
    // Prevent double playback when multiple triggers fire close together.
    if (bootGreetingInFlight) return await bootGreetingInFlight;

    bootGreetingInFlight = (async () => {
      if (!bootGreetingText) bootGreetingText = await getBootGreeting(reason);
      if (!bootGreetingDisplayed) {
        bootGreetingDisplayed = true;
        // Requirement: keep the greeting in the chat log.
        ui.appendMessage("assistant", bootGreetingText);
      }

      // If speaker is muted, treat greeting as "done" (no audio), and allow conversation to proceed.
      if (speakerMuted) {
        bootGreetingSpoken = true;
        setState("idle");
        void ensureVoiceListening("boot_greet_muted");
        return;
      }

      // Stop listening while greeting to avoid feedback.
      try {
        vad?.stop({ stopStream: false });
      } catch {}
      vad = null;

      setState("speaking");
      void api.log("boot_greet_start", { reason, intimacyLevel: intimacyLevel ?? null });
      const res = await speak(bootGreetingText);
      void api.log("boot_greet_end", { reason, ok: Boolean(res) });
      // If autoplay is blocked (no user gesture yet), res can be null; we'll retry on gesture.
      if (!res) {
        setState("idle");
        return;
      }
      bootGreetingSpoken = true;
      setState("idle");
      void ensureVoiceListening("boot_greet_done");
    })()
      .finally(() => {
        bootGreetingInFlight = null;
      });

    return await bootGreetingInFlight;
  }

  const ui = createUi(
    {
    onToggleOpen(open) {
      if (open) void api.log("widget_open");
      ensureConsentUi();
      if (open) {
        void maybeBootGreet("open");
        void ensureVoiceListening("open");
      }
    },
    onUserGesture() {
      gotUserGesture = true;
      void unlockAudioOnce("user_gesture");
      void maybeBootGreet("user_gesture");
    },
    onSelectMode(nextMode) {
      mode = nextMode;
      ui.setMode(mode);
      ui.setError(null);
      if (mode === "text") {
        // If we're mid voice turn (recording/ASR/LLM/TTS), don't drop it. Stop after turn completes.
        if (state === "listening" || inFlight || recorder?.isRecording?.()) {
          pendingStopVoiceAfterTurn = true;
          return;
        }
        // Otherwise stop mic pipeline immediately, but keep any ongoing TTS playback.
        stopVoicePipeline({ keepTts: true, keepState: state === "speaking", keepInFlight: true });
      } else {
        // Voice mode: never interrupt ongoing TTS; also don't start listening until TTS ends.
        if (state === "speaking" || currentAudio) {
          pendingListenAfterSpeak = true;
          // keep UI in speaking state if audio is playing
          if (state !== "speaking") setState("speaking");
          void maybeBootGreet("mode_switch");
          return;
        }
        setState("idle");
        void maybeBootGreet("mode_switch");
        void ensureVoiceListening("mode_switch");
      }
      ensureConsentUi();
    },
    onToggleMicMuted(next) {
      micMuted = next;
      ui.setMicMuted(micMuted);
      localStorage.setItem(`${STORAGE_KEYS.micMutedPrefix}${siteId}`, micMuted ? "1" : "0");
      void api.log("mic_mute_toggle", { muted: micMuted });
      if (micMuted) {
        stopVoicePipeline({ keepTts: true, keepState: state === "speaking", keepInFlight: true });
      } else {
        setState("idle");
        void maybeBootGreet("mic_unmute");
        void ensureVoiceListening("mic_unmute");
      }
    },
    onToggleSpeakerMuted(next) {
      speakerMuted = next;
      ui.setSpeakerMuted(speakerMuted);
      localStorage.setItem(`${STORAGE_KEYS.ttsMutedPrefix}${siteId}`, speakerMuted ? "1" : "0");
      void api.log("speaker_mute_toggle", { muted: speakerMuted });
      // Do NOT pause/stop current playback; just silence it.
      try {
        if (currentAudio) {
          currentAudio.muted = speakerMuted;
          currentAudio.volume = speakerMuted ? 0.0 : 1.0;
        }
      } catch {}
      if (!speakerMuted) void maybeBootGreet("speaker_unmute");
    },
    onTestAudio() {
      // iOS Safari: keep play() inside the user-gesture call stack (avoid await before play()).
      ui.setError(null);
      void unlockAudioOnce("test_audio");
      void playTestBeep().then((res) => {
        if (res.ok) {
          ui.setError("Test sound played.");
        } else {
          // Show the real iOS error (e.g., NotAllowedError) to speed up debugging.
          const short = res.err.length > 140 ? `${res.err.slice(0, 140)}…` : res.err;
          ui.setError(`Test sound failed: ${short}`);
        }
        window.setTimeout(() => ui.setError(null), 3500);
      });
    },
    onAcceptConsent() {
      localStorage.setItem(STORAGE_KEYS.consent, "accepted");
      void api.log("consent_accept");
      ensureConsentUi();
      void unlockAudioOnce("consent_accept");
      void maybeBootGreet("consent_accept");
    },
    onRejectConsent() {
      localStorage.setItem(STORAGE_KEYS.consent, "rejected");
      void api.log("consent_reject");
      ensureConsentUi();
    },
    async onSendText(text) {
      ui.setError(null);
      if (mode !== "text") {
        ui.setError("Switch to Text mode to send a message.");
        return;
      }
      if (inFlight) {
        ui.setError("Please wait for the current reply to finish.");
        return;
      }
      if (!api.sessionId) {
        ui.setError("Initializing session… Please wait a moment and try again.");
        return;
      }

      // ANY -> idle safety: if currently listening, stop it
      try {
          vad?.stop({ stopStream: false });
      } catch {}
      vad = null;

      setInFlight(true);
      setState("thinking");

      try {
        ui.appendMessage("user", text);
        const llmT0 = performance.now();
        const { assistantText, intimacy } = await api.chat(text, "text");
        void api.log("llm_done", { llmMs: msSince(llmT0) });
        const streamMsg = ui.appendAssistantStreaming(assistantText);
        intimacyLevel = intimacy?.level ?? intimacyLevel;
        ui.setIntimacy(intimacy?.level ?? null);
        setState("speaking");

        void api.log("tts_start");
        const res = await speak(assistantText, streamMsg);
        void api.log("tts_end", { ttsMs: res?.ttsMs ?? 0 });
      } catch (e) {
        stopAll("chat_text", `Chat failed: ${safeErr(e)}`);
      } finally {
        setInFlight(false);
        setState("idle");
        // If the user switched to Voice during playback, begin listening after speaking ends.
        const modeNow = mode as "voice" | "text";
        if (pendingListenAfterSpeak && modeNow === "voice") {
          pendingListenAfterSpeak = false;
          void ensureVoiceListening("after_text_speak");
        }
      }
    },
    },
    { layout },
  );

  ui.mount();
  ui.setMode(mode);
  if (layout === "page") {
    ui.setOpen(true);
    void api.log("widget_open", { layout: "page" });
  }
  setState("idle");
  ensureConsentUi();

  // Load safe per-site UI config (name/avatar/tts hint)
  try {
    const cfg = await api.getConfig();
    ttsVoiceHint = cfg.ttsVoiceHint ?? null;
    ui.setProfile({
      displayName: overrideDisplayName ?? cfg.displayName ?? "Mirai Aizawa",
      avatarUrl: overrideAvatarUrl ?? cfg.avatarUrl ?? null,
    });
  } catch {
    ui.setProfile({ displayName: overrideDisplayName ?? "Mirai Aizawa", avatarUrl: overrideAvatarUrl });
  }

  // Create session (server stores UA/IP); keep UX resilient if it fails.
  try {
    const storedUserId = localStorage.getItem(userIdStorageKey);
    const sess = await api.createSession(storedUserId);
    localStorage.setItem(userIdStorageKey, sess.userId);
    intimacyLevel = sess.intimacy?.level ?? null;
    ui.setIntimacy(sess.intimacy?.level ?? null);
  } catch (e) {
    ui.setError("Failed to initialize session. Please reload the page.");
  }

  // Load persisted mute states (per site)
  micMuted = localStorage.getItem(`${STORAGE_KEYS.micMutedPrefix}${siteId}`) === "1";
  speakerMuted = localStorage.getItem(`${STORAGE_KEYS.ttsMutedPrefix}${siteId}`) === "1";
  ui.setMicMuted(micMuted);
  ui.setSpeakerMuted(speakerMuted);
  // Start with a short greeting immediately (also appended to log).
  // Voice playback may require a user gesture; we retry on first gesture.
  void maybeBootGreet("boot");
}

void main();


