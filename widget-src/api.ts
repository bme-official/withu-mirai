export type ApiClient = {
  baseUrl: string;
  siteId: string;
  sessionId: string | null;
  sessionToken: string | null;
  userId: string | null;
  getConfig(): Promise<{ displayName: string; avatarUrl: string | null; ttsVoiceHint: string | null }>;
  createSession(userId?: string | null): Promise<{ sessionId: string; sessionToken: string; userId: string; intimacy: { level: number; xp: number } }>;
  log(type: string, meta?: unknown): Promise<void>;
  asr(audio: Blob): Promise<{ text: string }>;
  chat(userText: string, inputMode: "voice" | "text"): Promise<{ assistantText: string; intimacy: { level: number; xp: number; nextXp: number | null; delta: number } | null }>;
  ttsAudio(text: string): Promise<Blob>;
};

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createApiClient(baseUrl: string, siteId: string): ApiClient {
  const state: { sessionId: string | null; sessionToken: string | null; userId: string | null } = {
    sessionId: null,
    sessionToken: null,
    userId: null,
  };

  async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      const maybe = safeJsonParse(text);
      throw new Error(`HTTP ${res.status} ${path} ${typeof maybe === "object" ? JSON.stringify(maybe) : text}`);
    }
    return (text ? (JSON.parse(text) as T) : ({} as T));
  }

  return {
    baseUrl,
    siteId,
    get sessionId() {
      return state.sessionId;
    },
    get sessionToken() {
      return state.sessionToken;
    },
    get userId() {
      return state.userId;
    },
    async getConfig() {
      const res = await fetch(`${baseUrl}/api/config?siteId=${encodeURIComponent(siteId)}`, { method: "GET" });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} /api/config ${text}`);
      const j = JSON.parse(text) as { displayName: string; avatarUrl: string | null; ttsVoiceHint: string | null };
      return j;
    },
    async createSession(userId) {
      const data = await requestJson<{ sessionId: string; sessionToken: string; userId: string; intimacy: { level: number; xp: number } }>("/api/session", {
        method: "POST",
        body: JSON.stringify({ siteId, userId: userId ?? state.userId ?? undefined }),
      });
      state.sessionId = data.sessionId;
      state.sessionToken = data.sessionToken;
      state.userId = data.userId;
      return data;
    },
    async log(type: string, meta?: unknown) {
      if (!state.sessionId || !state.sessionToken) return;
      try {
        await requestJson("/api/logs", {
          method: "POST",
          body: JSON.stringify({
            sessionId: state.sessionId,
            sessionToken: state.sessionToken,
            events: [{ type, meta: meta ?? null }],
          }),
        });
      } catch {
        // Logging failures must never break UX
      }
    },
    async asr(audio: Blob) {
      if (!state.sessionId || !state.sessionToken) throw new Error("missing session");
      const t = String((audio as any)?.type ?? "").toLowerCase();
      const ext = t.includes("ogg") || t.includes("oga") ? "ogg" : t.includes("wav") ? "wav" : "webm";
      const fd = new FormData();
      fd.append("sessionId", state.sessionId);
      fd.append("sessionToken", state.sessionToken);
      fd.append("audio", audio, `audio.${ext}`);
      const res = await fetch(`${baseUrl}/api/asr`, { method: "POST", body: fd });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} /api/asr ${text}`);
      return JSON.parse(text) as { text: string };
    },
    async chat(userText: string, inputMode) {
      if (!state.sessionId || !state.sessionToken) throw new Error("missing session");
      return await requestJson<{ assistantText: string; intimacy: { level: number; xp: number; nextXp: number | null; delta: number } | null }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ sessionId: state.sessionId, sessionToken: state.sessionToken, userText, inputMode }),
      });
    },
    async ttsAudio(text: string) {
      if (!state.sessionId || !state.sessionToken) throw new Error("missing session");
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, sessionToken: state.sessionToken, text }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status} /api/tts ${t}`);
      }
      return await res.blob();
    },
  };
}


