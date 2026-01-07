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
  let gotUserGesture = false;
  let bootGreeted = false;
  let intimacyLevel: number | null = null;

  function stripEmojis(text: string): string {
    try {
      return text.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s{2,}/g, " ").trim();
    } catch {
      return text.replace(/[\u2600-\u27BF]/g, "").replace(/\s{2,}/g, " ").trim();
    }
  }

  function pickBootGreeting(level: number): string {
    const lv = Math.max(1, Math.min(5, Math.round(level)));
    const byLv: Record<number, string[]> = {
      1: [
        "Hi, I'm Mirai Aizawa. Want to chat for a minute?",
        "Hey, it's Mirai. What would you like to talk about today?",
        "Hi there. I'm Mirai Aizawa. Tell me what's on your mind.",
      ],
      2: [
        "Hi again. I'm Mirai. How's your day going so far?",
        "Hey, welcome back. Want to tell me what you're up to right now?",
        "Hi. I'm here. What should we talk about first?",
      ],
      3: [
        "Hey. It's good to see you again. What kind of mood are you in today?",
        "Hi. I'm happy you're here. What are you thinking about?",
        "Hey. Let's catch up. Anything fun or stressful happening today?",
      ],
      4: [
        "Hi. I missed talking with you. How are you, honestly?",
        "Hey. I'm here with you. Want to tell me what you need right now?",
        "Hi. Let's do a quick check-in. What's been on your mind lately?",
      ],
      5: [
        "Hey. I'm really happy you're here. Tell me how you're feeling today.",
        "Hi. Let's talk. I want to hear what you've been going through.",
        "Hey. I'm with you. What do you want to share first?",
      ],
    };
    const arr = byLv[lv] ?? byLv[1];
    const picked = arr[Math.floor(Math.random() * arr.length)] ?? arr[0]!;
    return stripEmojis(picked);
  }

  async function speakWithServerTts(text: string): Promise<{ ttsMs: number } | null> {
    if (speakerMuted) return null;
    try {
      const t0 = performance.now();
      const blob = await api.ttsAudio(text);
      const url = URL.createObjectURL(blob);
      try {
        const audio = new Audio(url);
        currentAudio = audio;
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
        currentAudio = null;
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
      currentAudio?.pause?.();
      currentAudio = null;
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
      currentAudio?.pause?.();
      currentAudio = null;
    } catch {}
    inFlight = false;
    setState("idle");
    if (message) ui.setError(message);
    void api.log("error", { phase, message: message ?? null });
  }

  async function speak(text: string) {
    // Ensure VAD is never running while speaking (stop first, then proceed).
    if (speakerMuted) {
      void api.log("tts_muted", { len: text.length });
      return null;
    }
    return await speakWithServerTts(text);
  }

  async function ensureVoiceListening(reason: string) {
    if (mode !== "voice") return;
    if (micMuted) return;
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
            stopAll("asr_empty", "I couldn't transcribe that. Please switch to Text mode and type your message.");
            mode = "text";
            ui.setMode("text");
            return;
          }

          ui.appendMessage("user", userText);

          const llmT0 = performance.now();
          const { assistantText, intimacy } = await api.chat(userText, "voice");
          void api.log("llm_done", { llmMs: msSince(llmT0) });

          ui.appendMessage("assistant", assistantText);
          intimacyLevel = intimacy?.level ?? intimacyLevel;
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

  async function maybeBootGreet(reason: string) {
    if (bootGreeted) return;
    if (!gotUserGesture) return;
    if (!api.sessionId) return;
    if (speakerMuted) return;

    bootGreeted = true;
    // Stop listening while greeting to avoid feedback.
    try {
      vad?.stop({ stopStream: false });
    } catch {}
    vad = null;

    setState("speaking");
    void api.log("boot_greet_start", { reason, intimacyLevel: intimacyLevel ?? null });
    await speak(pickBootGreeting(intimacyLevel ?? 1));
    void api.log("boot_greet_end", { reason });
    setState("idle");
    void ensureVoiceListening("boot_greet_done");
  }

  const ui = createUi(
    {
    onToggleOpen(open) {
      if (open) void api.log("widget_open");
      ensureConsentUi();
        if (open) void ensureVoiceListening("open");
    },
    onUserGesture() {
      gotUserGesture = true;
      void maybeBootGreet("user_gesture");
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
    onToggleMicMuted(next) {
      micMuted = next;
      ui.setMicMuted(micMuted);
      localStorage.setItem(`${STORAGE_KEYS.micMutedPrefix}${siteId}`, micMuted ? "1" : "0");
      void api.log("mic_mute_toggle", { muted: micMuted });
      if (micMuted) {
        stopVoicePipeline();
      } else {
        setState("idle");
        void ensureVoiceListening("mic_unmute");
      }
    },
    onToggleSpeakerMuted(next) {
      speakerMuted = next;
      ui.setSpeakerMuted(speakerMuted);
      localStorage.setItem(`${STORAGE_KEYS.ttsMutedPrefix}${siteId}`, speakerMuted ? "1" : "0");
      void api.log("speaker_mute_toggle", { muted: speakerMuted });
      if (speakerMuted) {
        try {
          currentAudio?.pause?.();
          currentAudio = null;
        } catch {}
      } else {
        void maybeBootGreet("speaker_unmute");
      }
    },
    onAcceptConsent() {
      localStorage.setItem(STORAGE_KEYS.consent, "accepted");
      void api.log("consent_accept");
      ensureConsentUi();
        void ensureVoiceListening("consent_accept");
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
      if (inFlight) return;
      if (!api.sessionId) {
        ui.setError("Initializing session… Please wait a moment and try again.");
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
        intimacyLevel = intimacy?.level ?? intimacyLevel;
        ui.setIntimacy(intimacy?.level ?? null);
        setState("speaking");

        void api.log("tts_start");
        const res = await speak(assistantText);
        void api.log("tts_end", { ttsMs: res?.ttsMs ?? 0 });
      } catch (e) {
        stopAll("chat_text", `Chat failed: ${safeErr(e)}`);
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
  // Try greeting once we have both: user gesture + session
  void maybeBootGreet("boot");

  // Auto-start voice listening when possible (no Start button).
  void ensureVoiceListening("boot");
}

void main();


