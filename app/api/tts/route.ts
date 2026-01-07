export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { json, errorJson } from "@/lib/server/http";
import { rateLimitOrThrow } from "@/lib/server/rateLimit";
import { getClientIp } from "@/lib/server/request";
import { TtsSchema } from "@/lib/server/validators";
import { assertSessionToken, getSiteProfile, insertEvents } from "@/lib/server/db";
import { corsHeaders } from "@/lib/server/cors";
import { getOpenAI, getTtsModel, getTtsVoice, type OpenAiTtsVoice } from "@/lib/server/openai";
import { getServerEnv } from "@/lib/server/env";

type OpenAiTtsModel = "tts-1" | "tts-1-hd";

function pickElevenVoiceSettings(prof: any): any {
  const cfg = prof?.chat_config;
  const vs = cfg?.tts?.elevenlabs?.voice_settings;
  if (vs && typeof vs === "object") return vs;
  // Default tuned for natural, softer delivery (good for Japanese voices).
  return { stability: 0.3, similarity_boost: 0.85, style: 0.45, use_speaker_boost: true };
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const cors = corsHeaders(req);
  try {
    rateLimitOrThrow(`tts:${ip}`, 60, 60_000);

    const body = await req.json().catch(() => null);
    const parsed = TtsSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400, headers: cors });

    const { sessionId, sessionToken, text } = parsed.data;
    const auth = await assertSessionToken(sessionId, sessionToken);
    rateLimitOrThrow(`tts_session:${sessionId}`, 40, 60_000);

    const env = getServerEnv();
    const prof = auth.siteId ? await getSiteProfile(auth.siteId).catch(() => null) : null;
    const provider = String((prof as any)?.tts_provider ?? "openai").toLowerCase();

    // Latency tuning: keep TTS input short by default.
    // Can be overridden via site_profiles.chat_config.tts.max_chars.
    const maxChars =
      Math.max(
        80,
        Math.min(
          1200,
          Number((prof as any)?.chat_config?.tts?.max_chars ?? 520),
        ),
      ) || 520;
    const input = String(text || "").slice(0, maxChars);
    if (!input.trim()) return json({ ok: false, error: "empty_text" }, { status: 400, headers: cors });

    const t0 = performance.now();
    let buf: Buffer;
    let meta: any = { ttsMs: 0, bytes: 0 };

    if (provider === "elevenlabs") {
      const apiKey = (env.ELEVENLABS_API_KEY || "").trim();
      const voiceId = String((prof as any)?.eleven_voice_id ?? "").trim();
      const modelId = String((prof as any)?.eleven_model_id ?? env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2").trim();
      if (!apiKey) throw new Error("missing_ELEVENLABS_API_KEY");
      if (!voiceId) throw new Error("missing_eleven_voice_id");

      // optimize_streaming_latency improves time-to-first-audio
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?optimize_streaming_latency=2`;
      const voice_settings = pickElevenVoiceSettings(prof as any);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          accept: "audio/mpeg",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: input,
          model_id: modelId || undefined,
          voice_settings,
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`elevenlabs_tts_failed_http_${res.status}: ${t.slice(0, 300)}`);
      }
      buf = Buffer.from(await res.arrayBuffer());
      const ttsMs = Math.round(performance.now() - t0);
      meta = { mode: "server_elevenlabs", voiceId, modelId, ttsMs, bytes: buf.length };
    } else {
      let model: OpenAiTtsModel = getTtsModel() as OpenAiTtsModel;
      let voice: OpenAiTtsVoice = getTtsVoice();
      let voiceSource: "env" | "site_profile" = "env";
      // Optional per-site override via site_profiles.tts_voice_hint (e.g. "voice=shimmer, model=tts-1")
      try {
        const hint = (prof?.tts_voice_hint ?? "").trim().toLowerCase();
        const voiceMatch = hint.match(/voice\s*[:=]\s*([a-z]+)/i);
        const modelMatch = hint.match(/model\s*[:=]\s*(tts-1-hd|tts-1)/i);
        const voiceCandidate = (voiceMatch?.[1] ?? hint).trim().toLowerCase();
        const modelCandidate = (modelMatch?.[1] ?? "").trim().toLowerCase();

        if (modelCandidate && (modelCandidate === "tts-1" || modelCandidate === "tts-1-hd")) {
          model = modelCandidate as OpenAiTtsModel;
          voiceSource = "site_profile";
        }
        if (["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(voiceCandidate)) {
          voice = voiceCandidate as OpenAiTtsVoice;
          voiceSource = "site_profile";
        }
      } catch {
        // ignore: keep env voice
      }

      const speech = await getOpenAI().audio.speech.create({
        model,
        voice,
        input,
        response_format: "mp3",
      });
      buf = Buffer.from(await (speech as any).arrayBuffer());
      const ttsMs = Math.round(performance.now() - t0);
      meta = { mode: "server_openai", model, voice, voiceSource, ttsMs, bytes: buf.length };
    }

    await insertEvents(sessionId, [{ type: "tts_done", meta }]);

    // Next.js/DOM Response typing doesn't accept Node Buffer directly; return as Uint8Array.
    const audioBody = new Uint8Array(buf);
    return new Response(audioBody, {
      status: 200,
      headers: {
        ...cors,
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    // @ts-expect-error: from rateLimitOrThrow
    const status = e?.status ?? 500;
    if (status === 429) return json({ ok: false, error: "rate_limited" }, { status: 429, headers: cors });
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "missing_ELEVENLABS_API_KEY") {
      return json({ ok: false, error: "missing_elevenlabs_api_key" }, { status: 400, headers: cors });
    }
    if (msg === "missing_eleven_voice_id") {
      return json({ ok: false, error: "missing_eleven_voice_id" }, { status: 400, headers: cors });
    }
    if (msg.startsWith("elevenlabs_tts_failed_http_")) {
      // e.g. invalid API key (401) / quota etc.
      return json({ ok: false, error: "elevenlabs_tts_failed", message: msg }, { status: 502, headers: cors });
    }
    return json({ ok: false, error: "internal_error", message: msg }, { status: 500, headers: cors });
  }
}

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}


