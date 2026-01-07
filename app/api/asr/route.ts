export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { json, errorJson } from "@/lib/server/http";
import { rateLimitOrThrow } from "@/lib/server/rateLimit";
import { getClientIp } from "@/lib/server/request";
import { assertSessionToken, insertEvents } from "@/lib/server/db";
import { getOpenAI } from "@/lib/server/openai";
import { toFile } from "openai/uploads";
import { corsHeaders } from "@/lib/server/cors";

function msSince(t0: number) {
  return Math.round(performance.now() - t0);
}

function normalizeAudio(input: { filename: string; mimeType: string | null }): { filename: string; mimeType: string } {
  const name = input.filename || "audio.webm";
  const rawType = (input.mimeType || "").toLowerCase();
  const baseType = rawType.split(";")[0].trim();
  const ext = name.split(".").pop()?.toLowerCase() || "";

  // Prefer known safe types.
  if (baseType === "audio/webm" || ext === "webm") return { filename: "audio.webm", mimeType: "audio/webm" };
  if (baseType === "audio/ogg" || baseType === "audio/oga" || ext === "ogg" || ext === "oga")
    return { filename: "audio.ogg", mimeType: "audio/ogg" };
  if (baseType === "audio/wav" || ext === "wav") return { filename: "audio.wav", mimeType: "audio/wav" };

  // Fallback: keep webm (supported by Whisper) and hope container matches.
  return { filename: "audio.webm", mimeType: "audio/webm" };
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const cors = corsHeaders(req);
  try {
    rateLimitOrThrow(`asr:${ip}`, 40, 60_000);

    const fd = await req.formData();
    const sessionId = String(fd.get("sessionId") || "");
    const sessionToken = String(fd.get("sessionToken") || "");
    const audio = fd.get("audio");

    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return json({ ok: false, error: "invalid_sessionId" }, { status: 400, headers: cors });
    if (!sessionToken || sessionToken.length < 16) return json({ ok: false, error: "invalid_sessionToken" }, { status: 400, headers: cors });
    if (!(audio instanceof File)) return json({ ok: false, error: "missing_audio" }, { status: 400, headers: cors });

    // very rough DoS protection
    if (audio.size > 15 * 1024 * 1024) return json({ ok: false, error: "file_too_large" }, { status: 413, headers: cors });
    // Prevent sending tiny/empty audio blobs to Whisper (often causes invalid format errors)
    if (audio.size < 1200) return json({ ok: false, error: "audio_too_small" }, { status: 400, headers: cors });

    rateLimitOrThrow(`asr_session:${sessionId}`, 25, 60_000);
    await assertSessionToken(sessionId, sessionToken);

    const norm = normalizeAudio({ filename: audio.name || "audio.webm", mimeType: audio.type || null });
    const buf = Buffer.from(await audio.arrayBuffer());
    const file = await toFile(buf, norm.filename, { type: norm.mimeType });

    const t0 = performance.now();
    let tr: { text?: string } | null = null;
    try {
      tr = await getOpenAI().audio.transcriptions.create({
        model: "whisper-1",
        file,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/invalid file format/i.test(msg)) {
        return json(
          { ok: false, error: "invalid_audio_format", message: msg, mimeType: norm.mimeType, filename: norm.filename },
          { status: 400, headers: cors },
        );
      }
      throw e;
    }
    const asrMs = msSince(t0);

    const text = (tr?.text || "").trim();
    await insertEvents(sessionId, [{ type: "asr_done", meta: { asrMs } }]);

    return json({ ok: true, text }, { status: 200, headers: cors });
  } catch (e) {
    // @ts-expect-error: from rateLimitOrThrow
    const status = e?.status ?? 500;
    if (status === 429) return json({ ok: false, error: "rate_limited" }, { status: 429, headers: cors });
    return json(
      { ok: false, error: "internal_error", message: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: cors },
    );
  }
}

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}


