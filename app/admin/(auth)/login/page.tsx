import { isAdminEnabled } from "@/lib/server/adminAuth";

export const runtime = "nodejs";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const error = typeof sp.error === "string" ? sp.error : "";

  if (!isAdminEnabled()) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-6 px-6 py-10">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-zinc-600">
          Admin is disabled. Set <code className="rounded bg-zinc-100 px-1">ADMIN_PASSWORD</code> and{" "}
          <code className="rounded bg-zinc-100 px-1">ADMIN_SESSION_SECRET</code> in Vercel environment variables.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold">Admin login</h1>
      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
      <form className="flex flex-col gap-3" action="/admin/api/login" method="post">
        <label className="text-sm font-medium">
          Password
          <input
            className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-zinc-900 placeholder:text-zinc-400"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white" type="submit">
          Sign in
        </button>
      </form>
    </main>
  );
}


