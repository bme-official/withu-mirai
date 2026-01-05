import { STORAGE_KEYS, VAD_CONFIG } from "./constants";
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
  ut.lang = document.documentElement.lang || "ja-JP";
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
  // Requirement: always use server-side TTS for reliable playback.
  const ttsMode: "server" = "server";

  let state: WidgetState = "idle";
  let inFlight = false;
  let vad: ReturnType<typeof createVad> | null = null;
  let stream: MediaStream | null = null;
  let recorder: ReturnType<typeof createRecorder> | null = null;
  let mode: "voice" | "text" = "voice";
  let ttsVoiceHint: string | null = null;
  let layoutMode: "bubble" | "page" = layout;
  let muted = false;

  async function speakWithServerTts(text: string): Promise<{ ttsMs: number } | null> {
    try {
      const t0 = performance.now();
      const blob = await api.ttsAudio(text);
      const url = URL.createObjectURL(blob);
      try {
        const audio = new Audio(url);
        audio.preload = "auto";
        audio.volume = 1.0;
        const playPromise = audio.play();
        if (playPromise && typeof (playPromise as any).catch === "function") {
          await playPromise;
        }
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      return { ttsMs: msSince(t0) };
    } catch {
      return null;
    }
  }

  function setState(next: WidgetState) {
    state = next;
    ui.setState(next);
    ui.setTextFallbackEnabled(next === "idle" && mode === "text");
  }

  function hasConsent() {
    return localStorage.getItem(STORAGE_KEYS.consent) === "accepted";
  }

  function ensureConsentUi() {
    ui.setConsentVisible(!hasConsent());
  }

  function stopVoicePipeline() {
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
      window.speechSynthesis?.cancel?.();
    } catch {}
    inFlight = false;
    setState("idle");
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
      window.speechSynthesis?.cancel?.();
    } catch {}
    inFlight = false;
    setState("idle");
    if (message) ui.setError(message);
    void api.log("error", { phase, message: message ?? null });
  }

  async function speak(text: string) {
    // speaking中はVADが絶対に動かないよう、state遷移とstopが先
    if (muted) {
      void api.log("tts_muted", { len: text.length });
      return null;
    }
    return await speakWithServerTts(text);
  }

  async function ensureVoiceListening(reason: string) {
    if (mode !== "voice") return;
    if (!hasConsent()) return;
    if (inFlight) return;
    if (state !== "idle") return;

    // ensure mic stream
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        // Don't force-switch; user may need a gesture or permission.
        setState("idle");
        ui.setError("マイクが利用できません。ブラウザの許可を確認し、画面をタップして再試行してください。");
        void api.log("mic_permission", { message: safeErr(e) });
        return;
      }
    }

    if (!recorder) recorder = createRecorder(stream);
    vad = createVad(stream, recorder, {
      onSpeechStart() {
        void api.log("vad_speech_start");
      },
      async onSpeechEnd({ durationMs, sizeBytes, blob }) {
        if (mode !== "voice") return;
        if (state !== "listening" || inFlight) return;
        inFlight = true;

        setState(reduceState(state, { type: "VAD_DONE" }));

        // pause VAD during ASR/LLM/TTS but KEEP stream for continuous conversation
        try {
          vad?.stop({ stopStream: false });
        } catch {}
        vad = null;

        void api.log("vad_speech_end", { durationMs: Math.round(durationMs), sizeBytes });

        try {
          const asrT0 = performance.now();
          const { text } = await api.asr(blob);
          void api.log("asr_done", { asrMs: msSince(asrT0) });

          const userText = (text || "").trim();
          if (!userText) {
            stopAll("asr_empty", "音声の認識に失敗しました。テキストモードで入力してください。");
            mode = "text";
            ui.setMode("text");
            return;
          }

          ui.appendMessage("user", userText);

          const llmT0 = performance.now();
          const { assistantText, intimacy } = await api.chat(userText, "voice");
          void api.log("llm_done", { llmMs: msSince(llmT0) });

          ui.appendMessage("assistant", assistantText);
          ui.setIntimacy(intimacy?.level ?? null);
          setState(reduceState(state, { type: "LLM_DONE" }));

          const ttsT0 = performance.now();
          void api.log("tts_start");
          await speak(assistantText);
          void api.log("tts_end", { ttsMs: msSince(ttsT0) });

          setState(reduceState(state, { type: "TTS_END" }));
          inFlight = false;
          // auto continue listening
          setState("idle");
          void ensureVoiceListening("auto_continue");
        } catch (e) {
          stopAll("pipeline", `処理に失敗しました: ${safeErr(e)}`);
        }
      },
      onError(err) {
        stopAll("vad", `VADエラー: ${err.message}`);
      },
    });

    setState("listening");
    void api.log("listening_start", { reason, layout: layoutMode });
    await vad.start();
  }

  const ui = createUi(
    {
    onToggleOpen(open) {
      if (open) void api.log("widget_open");
      ensureConsentUi();
        if (open) void ensureVoiceListening("open");
    },
    onSelectMode(nextMode) {
      mode = nextMode;
      ui.setMode(mode);
      ui.setError(null);
      if (mode === "text") {
        // safety: switching mode stops voice pipeline
        stopVoicePipeline();
      } else {
        // voice mode: keep idle; start is enabled only after consent
        setState("idle");
          void ensureVoiceListening("mode_switch");
      }
      ensureConsentUi();
    },
    onToggleMute(next) {
      muted = next;
      ui.setMuted(muted);
      if (muted) {
        try {
          window.speechSynthesis?.cancel?.();
        } catch {}
      }
      void api.log("tts_mute_toggle", { muted });
    },
    onAcceptConsent() {
      localStorage.setItem(STORAGE_KEYS.consent, "accepted");
      void api.log("consent_accept");
      ensureConsentUi();
        void ensureVoiceListening("consent_accept");
    },
    onRejectConsent() {
      localStorage.setItem(STORAGE_KEYS.consent, "rejected");
      void api.log("consent_reject");
      ensureConsentUi();
    },
    async onSendText(text) {
      ui.setError(null);
      if (mode !== "text") {
        ui.setError("テキストモードに切り替えて送信してください。");
        return;
      }
      if (inFlight) return;
      if (!api.sessionId) {
        ui.setError("セッション初期化中です。少し待ってからもう一度お試しください。");
        return;
      }

      // ANY -> idle safety: if currently listening, stop it
      try {
          vad?.stop({ stopStream: false });
      } catch {}
      vad = null;

      inFlight = true;
      setState("thinking");

      try {
        ui.appendMessage("user", text);
        const llmT0 = performance.now();
        const { assistantText, intimacy } = await api.chat(text, "text");
        void api.log("llm_done", { llmMs: msSince(llmT0) });
        ui.appendMessage("assistant", assistantText);
        ui.setIntimacy(intimacy?.level ?? null);
        setState("speaking");

        void api.log("tts_start");
        const res = await speak(assistantText);
        void api.log("tts_end", { ttsMs: res?.ttsMs ?? 0 });
      } catch (e) {
        stopAll("chat_text", `チャットに失敗しました: ${safeErr(e)}`);
      } finally {
        inFlight = false;
        setState("idle");
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
    ui.setIntimacy(sess.intimacy?.level ?? null);
  } catch (e) {
    ui.setError("セッション初期化に失敗しました。ページを再読み込みしてください。");
  }

  // Helpful first message
  ui.appendMessage("assistant", `こんにちは、Mirai Aizawaです。音声/テキストどちらでも会話できます。`);
  ui.appendMessage("assistant", `（VAD: ${VAD_CONFIG.minSpeechMs}ms/${VAD_CONFIG.silenceMs}ms/${VAD_CONFIG.maxSpeechMs}ms）`);

  // Auto-start voice listening when possible (no Start button).
  void ensureVoiceListening("boot");
}

void main();


