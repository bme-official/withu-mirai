export const runtime = "nodejs";

import Link from "next/link";
import { listSiteProfiles } from "@/lib/server/db";

export default async function AdminHome() {
  let sites: any[] = [];
  let loadError = "";
  try {
    sites = await listSiteProfiles(200);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error("[admin] failed to list site profiles", { error: loadError });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <form action="/admin/logout" method="post">
          <button className="rounded-lg border px-3 py-2 text-sm font-semibold" type="submit">
            Sign out
          </button>
        </form>
      </div>

      <div className="rounded-xl border bg-white p-4 text-zinc-900">
        <div className="mb-2 text-sm font-semibold">Create / open a site</div>
        <form className="flex flex-col gap-2 sm:flex-row" action="/admin/api/site/new" method="post">
          <input
            className="w-full rounded-lg border bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400"
            name="siteId"
            placeholder="site_id (e.g. mirai-aizawa-com)"
            required
          />
          <button className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white" type="submit">
            Open
          </button>
        </form>
        <div className="mt-2 text-xs text-zinc-500">This will create the row if it does not exist.</div>
      </div>

      <div className="rounded-xl border bg-white text-zinc-900">
        <div className="border-b p-4 text-sm font-semibold">Sites</div>
        {loadError ? (
          <div className="border-b bg-red-50 p-4 text-sm text-red-800">
            <div className="font-semibold">Failed to load sites</div>
            <div className="mt-1 break-words font-mono text-xs">{loadError}</div>
          </div>
        ) : null}
        <div className="divide-y">
          {sites.length === 0 ? (
            <div className="p-4 text-sm text-zinc-600">No sites found.</div>
          ) : (
            sites.map((s: any) => (
              <div key={s.site_id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{s.display_name ?? s.site_id}</div>
                  <div className="truncate text-xs text-zinc-500">{s.site_id}</div>
                </div>
                <Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href={`/admin/site/${s.site_id}`}>
                  Edit
                </Link>
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}


