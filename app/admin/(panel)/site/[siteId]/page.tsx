export const runtime = "nodejs";

import Link from "next/link";
import { getSiteProfile } from "@/lib/server/db";

function prettyJson(v: unknown): string {
  try {
    if (v == null) return "{}";
    return JSON.stringify(v, null, 2);
  } catch {
    return "{}";
  }
}

export default async function AdminSitePage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { siteId } = await params;
  const sp = (await searchParams) ?? {};
  const saved = sp.saved === "1";
  const error = typeof sp.error === "string" ? sp.error : "";

  let prof: Awaited<ReturnType<typeof getSiteProfile>> = null;
  let loadError = "";
  try {
    prof = await getSiteProfile(siteId);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error("[admin] failed to load site profile", { siteId, error: loadError });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-xs text-zinc-500">
            <Link href="/admin" className="underline">
              Admin
            </Link>{" "}
            / {siteId}
          </div>
          <h1 className="text-2xl font-semibold">Site settings</h1>
        </div>
        <form action="/admin/logout" method="post">
          <button className="rounded-lg border px-3 py-2 text-sm font-semibold" type="submit">
            Sign out
          </button>
        </form>
      </div>

      {saved ? <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">Saved.</div> : null}
      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
      {loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-semibold">Failed to load site profile</div>
          <div className="mt-1 break-words font-mono text-xs">{loadError}</div>
          <div className="mt-2 text-xs text-red-900/80">
            Check Vercel env vars (<code className="rounded bg-white/60 px-1">SUPABASE_URL</code>,{" "}
            <code className="rounded bg-white/60 px-1">SUPABASE_SERVICE_ROLE_KEY</code>) and that Supabase has the expected{" "}
            <code className="rounded bg-white/60 px-1">site_profiles</code> columns.
          </div>
        </div>
      ) : null}

      <form className="flex flex-col gap-6" action={`/admin/api/site/${encodeURIComponent(siteId)}`} method="post">
        <div className="rounded-xl border bg-white p-4 text-zinc-900">
          <div className="mb-3 text-sm font-semibold">Profile</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-sm">
              Display name
              <input
                className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-zinc-900 placeholder:text-zinc-400"
                name="displayName"
                defaultValue={prof?.display_name ?? ""}
              />
            </label>
            <label className="text-sm">
              Avatar URL
              <input
                className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-zinc-900 placeholder:text-zinc-400"
                name="avatarUrl"
                defaultValue={prof?.avatar_url ?? ""}
              />
            </label>
            <label className="text-sm md:col-span-2">
              TTS hint (optional)
              <input
                className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-zinc-900 placeholder:text-zinc-400"
                name="ttsVoiceHint"
                defaultValue={prof?.tts_voice_hint ?? ""}
              />
              <div className="mt-1 text-xs text-zinc-500">
                For OpenAI TTS override, you can set: <code className="rounded bg-zinc-100 px-1">voice=shimmer</code>,{" "}
                <code className="rounded bg-zinc-100 px-1">model=tts-1-hd</code>, etc.
              </div>
            </label>
          </div>
        </div>

        <div className="rounded-xl border bg-white p-4 text-zinc-900">
          <div className="mb-2 text-sm font-semibold">Persona prompt (server-only)</div>
          <div className="text-xs text-zinc-500">
            This is appended to the system prompt. Use it to control profile, tone, rules (e.g. no emojis), and boundaries.
          </div>
          <textarea
            className="mt-2 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs text-zinc-900 placeholder:text-zinc-400"
            name="personaPrompt"
            rows={10}
            defaultValue={prof?.persona_prompt ?? ""}
          />
        </div>

        <div className="rounded-xl border bg-white p-4 text-zinc-900">
          <div className="mb-2 text-sm font-semibold">Greeting templates (JSON)</div>
          <div className="text-xs text-zinc-500">
            Example:
            <code className="ml-2 rounded bg-zinc-100 px-1">{"{\"1\":[\"Hi...\"],\"2\":[\"Welcome back...\"]}"}</code>
          </div>
          <textarea
            className="mt-2 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs text-zinc-900 placeholder:text-zinc-400"
            name="greetingTemplates"
            rows={10}
            defaultValue={prettyJson((prof as any)?.greeting_templates)}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="rounded-xl border bg-white p-4 text-zinc-900">
            <div className="mb-2 text-sm font-semibold">Chat config (JSON)</div>
            <div className="text-xs text-zinc-500">For example: max reply length, style toggles, etc.</div>
            <textarea
              className="mt-2 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs text-zinc-900 placeholder:text-zinc-400"
              name="chatConfig"
              rows={10}
              defaultValue={prettyJson((prof as any)?.chat_config)}
            />
          </div>
          <div className="rounded-xl border bg-white p-4 text-zinc-900">
            <div className="mb-2 text-sm font-semibold">CTA / external services (JSON)</div>
            <div className="text-xs text-zinc-500">For example: Patreon links, when to mention, etc.</div>
            <textarea
              className="mt-2 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs text-zinc-900 placeholder:text-zinc-400"
              name="ctaConfig"
              rows={10}
              defaultValue={prettyJson((prof as any)?.cta_config)}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white" type="submit">
            Save
          </button>
          <Link className="text-sm underline" href="/admin">
            Back
          </Link>
        </div>
      </form>
    </main>
  );
}


