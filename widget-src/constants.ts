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
  title: "音声チャット",
} as const;


