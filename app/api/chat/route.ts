export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { json, errorJson } from "@/lib/server/http";
import { rateLimitOrThrow } from "@/lib/server/rateLimit";
import { getClientIp } from "@/lib/server/request";
import { ChatSchema } from "@/lib/server/validators";
import {
  applyIntimacy,
  applyIntimacyDelta,
  assertSessionToken,
  computeIntimacyDelta,
  getSiteProfile,
  insertEvents,
  insertMessage,
  listRecentMessages,
  listRecentMessagesForUser,
} from "@/lib/server/db";
import { getIntimacyModel, getOpenAI, getChatModel } from "@/lib/server/openai";
import { SYSTEM_PROMPT } from "@/lib/server/systemPrompt";
import { z } from "zod";
import { corsHeaders } from "@/lib/server/cors";

function msSince(t0: number) {
  return Math.round(performance.now() - t0);
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function detectNegativeSignals(text: string): { spam: boolean; rude: boolean; harassment: boolean } {
  const t = text.trim();
  const lower = t.toLowerCase();
  const spam = t.length <= 2 || /(.)\1{6,}/.test(t) || /(https?:\/\/|www\.)/.test(lower);
  const rude = ["ばか", "バカ", "死ね", "うざ", "きも", "消えろ", "fuck", "shit"].some((k) => lower.includes(k.toLowerCase()));
  const harassment = ["殺す", "ころす", "脅", "暴力", "レイプ", "rape"].some((k) => lower.includes(k.toLowerCase()));
  return { spam, rude, harassment };
}

function computeFallbackDelta(userText: string, inputMode?: "voice" | "text", isRepeat?: boolean): { delta: number; reasons: string[] } {
  const base = computeIntimacyDelta(userText, inputMode);
  // convert XP-ish score to smaller delta range (stability)
  let delta = clampInt(base.xp - 5, -20, 20); // 0..15 typical
  const reasons = [...base.reasons.map((r) => `h_${r}`)];

  const neg = detectNegativeSignals(userText);
  if (isRepeat) {
    delta = Math.min(delta, -2);
    reasons.push("h_repeat");
  }
  if (neg.spam) {
    delta = Math.min(delta, -4);
    reasons.push("h_spam");
  }
  if (neg.harassment) {
    delta = Math.min(delta, -10);
    reasons.push("h_harassment");
  } else if (neg.rude) {
    delta = Math.min(delta, -6);
    reasons.push("h_rude");
  }

  return { delta, reasons };
}

function stabilizeDelta(input: {
  aiDelta: number;
  confidence: number;
  aiReasons: string[];
  fallbackDelta: number;
  userText: string;
  isRepeat: boolean;
}): { delta: number; notes: string[] } {
  const notes: string[] = [];
  const severeNeg = new Set(["harassment", "threat", "spam", "sexual", "hate"]);
  const severePos = new Set(["deep_trust", "support", "long_term"]);

  const aiReasons = (input.aiReasons ?? []).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  const hasSevereNeg = aiReasons.some((r) => severeNeg.has(r));
  const hasSeverePos = aiReasons.some((r) => severePos.has(r));

  let d = clampInt(input.aiDelta, -20, 20);

  // confidence shrink: low confidence -> closer to 0 (reduces wobble)
  const c = Math.max(0, Math.min(1, input.confidence));
  if (c < 0.75) notes.push(`conf_shrink:${c.toFixed(2)}`);
  d = clampInt(d * c, -20, 20);

  // hard cap typical range unless severe reasons
  const cap = hasSevereNeg ? 20 : hasSeverePos ? 15 : 8;
  if (Math.abs(d) > cap) notes.push(`cap:${cap}`);
  d = clampInt(d, -cap, cap);

  // repeat/spam/rude guardrails (deterministic)
  const neg = detectNegativeSignals(input.userText);
  if (input.isRepeat) {
    d = Math.min(d, -2);
    notes.push("repeat_guard");
  }
  if (neg.spam) {
    d = Math.min(d, -4);
    notes.push("spam_guard");
  }
  if (neg.harassment) {
    d = Math.min(d, -10);
    notes.push("harassment_guard");
  } else if (neg.rude) {
    d = Math.min(d, -6);
    notes.push("rude_guard");
  }

  // smoothing with fallback (prevents random spikes)
  d = clampInt(d * 0.7 + input.fallbackDelta * 0.3, -20, 20);
  notes.push("smooth:0.7ai+0.3fallback");

  return { delta: d, notes };
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const cors = corsHeaders(req);
  try {
    rateLimitOrThrow(`chat:${ip}`, 60, 60_000);

    const body = await req.json().catch(() => null);
    const parsed = ChatSchema.safeParse(body);
    if (!parsed.success) return errorJson(400, "invalid_body");

    const { sessionId, sessionToken, userText, inputMode } = parsed.data;
    rateLimitOrThrow(`chat_session:${sessionId}`, 30, 60_000);

    const { siteId, userId } = await assertSessionToken(sessionId, sessionToken);
    // Persist the user's message first so the model always sees it in history.
    await insertMessage({ sessionId, role: "user", content: userText });

    const history = userId ? await listRecentMessagesForUser(userId, 30) : await listRecentMessages(sessionId, 30);
    const model = getChatModel();
    const intimacyModel = getIntimacyModel();

    const siteProfile = siteId ? await getSiteProfile(siteId).catch(() => null) : null;
    const persona = (siteProfile?.persona_prompt ?? "").trim();

    // Detect repeat (compare to previous user message, excluding the current one)
    const prevUser = [...history].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
    const isRepeat = prevUser.length > 0 && prevUser === userText.trim();

    // 1) Generate assistant response (normal text; no JSON constraints)
    const chatMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      {
        role: "system",
        content: [
          SYSTEM_PROMPT,
          persona ? `\n\n# Persona\n${persona}` : "",
        ]
          .filter(Boolean)
          .join(""),
      },
      ...history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const t0 = performance.now();
    const chatResp = await getOpenAI().chat.completions.create({
      model,
      messages: chatMessages,
      temperature: 0.2,
    });
    const assistantText = (chatResp.choices?.[0]?.message?.content ?? "").trim();
    const llmMs = msSince(t0);

    if (!assistantText) return errorJson(502, "llm_empty");
    await insertMessage({ sessionId, role: "assistant", content: assistantText });

    // 2) AI intimacy delta scoring (stable JSON, temperature 0)
    const IntimacyRespSchema = z.object({
      intimacyDelta: z.number().int().min(-20).max(20),
      confidence: z.number().min(0).max(1),
      reasons: z.array(z.string().min(1)).max(8).optional(),
    });

    let intimacyDelta: number | null = null;
    let aiConfidence = 0;
    let aiReasons: string[] = [];
    let intimacySource: "ai" | "fallback" = "fallback";

    if (userId) {
      const t1 = performance.now();
      try {
        const scoreResp = await getOpenAI().chat.completions.create({
          model: intimacyModel,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "あなたは会話ログから「親密度の増減」を安定して判定する採点器です。\n" +
                "ブレを抑えるため、通常は -2..+2 の範囲に収め、強い根拠がある時だけ大きく動かします。\n" +
                "不快/攻撃/スパム/露骨な性的発言/迷惑行為/ハラスメントは減点し、必要なら大きく下げます。\n" +
                "出力はJSONのみ。\n" +
                '形式: {"intimacyDelta": integer(-20..20), "confidence": number(0..1), "reasons": string[]}\n' +
                "reasonsは短い英数字キー。例: gratitude, self_disclosure, respectful, rude, spam, harassment, boundary_violation",
            },
            {
              role: "user",
              content: JSON.stringify({
                inputMode: inputMode ?? null,
                userText,
                assistantText,
                isRepeat,
              }),
            },
          ],
        });
        const raw = (scoreResp.choices?.[0]?.message?.content ?? "").trim();
        const j = IntimacyRespSchema.parse(JSON.parse(raw));
        intimacyDelta = j.intimacyDelta;
        aiConfidence = j.confidence;
        aiReasons = j.reasons ?? [];
        intimacySource = "ai";
      } catch {
        // ignore -> fallback below
      }
      const scoreMs = msSince(t1);
      // (optional) we include as metadata later
      void scoreMs;
    }

    let intimacy: { level: number; xp: number; nextXp: number | null; delta: number } | null = null;
    let intimacyMeta: any = null;
    if (userId) {
      if (typeof intimacyDelta === "number") {
        const fb = computeFallbackDelta(userText, inputMode, isRepeat);
        const st = stabilizeDelta({
          aiDelta: intimacyDelta,
          confidence: aiConfidence,
          aiReasons,
          fallbackDelta: fb.delta,
          userText,
          isRepeat,
        });
        const applied = await applyIntimacyDelta(userId, st.delta);
        intimacy = { level: applied.level, xp: applied.xp, nextXp: applied.nextXp, delta: applied.delta };
        intimacyMeta = {
          ...applied,
          source: intimacySource,
          inputMode: inputMode ?? null,
          ai: { rawDelta: intimacyDelta, confidence: aiConfidence, reasons: aiReasons },
          fallback: fb,
          stabilized: { delta: st.delta, notes: st.notes },
        };
      } else {
        const fb = computeFallbackDelta(userText, inputMode, isRepeat);
        const applied = await applyIntimacyDelta(userId, fb.delta);
        intimacy = { level: applied.level, xp: applied.xp, nextXp: applied.nextXp, delta: applied.delta };
        intimacyMeta = { ...applied, source: "fallback", inputMode: inputMode ?? null, fallback: fb };
      }
    }

    await insertEvents(sessionId, [
      { type: "llm_done", meta: { llmMs, model } },
      ...(intimacyMeta ? [{ type: "intimacy_update", meta: intimacyMeta }] : []),
    ]);

    return json({ ok: true, assistantText, intimacy }, { status: 200, headers: cors });
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


