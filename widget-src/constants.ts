export const WIDGET_VERSION = "0.1.0";

// VAD spec (fixed)
export const VAD_CONFIG = {
  minSpeechMs: 300,
  silenceMs: 700,
  maxSpeechMs: 15000,
  // RMS threshold: tune later, single source of truth.
  rmsThreshold: 0.02,
} as const;

export const STORAGE_KEYS = {
  consent: "withu_voice_consent_v1",
  userIdPrefix: "withu_user_id_v1:",
  ttsMutedPrefix: "withu_tts_muted_v1:",
} as const;

export const UI_TEXT = {
  // All widget UI copy should be English (conversation UX is designed for English by default).
  title: "Chat",
  voice: "Voice",
  text: "Text",
  send: "Send",
  placeholder: "Type a message…",
  heroPrompt: "Talk to me",
  modeVoice: "Voice mode",
  modeText: "Text mode",
  consentTitle: "Microphone & logging consent",
  consentBody:
    "To enable voice chat, we will send your microphone audio for transcription and store conversation/event logs. " +
    "If you do not agree, you can still use text chat.",
  consentAccept: "I agree",
  consentReject: "No thanks",
  intimacyLabel: "Intimacy",
} as const;


