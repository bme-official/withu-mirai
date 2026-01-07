export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { createAdminSessionCookie, adminPasswordMatches, isAdminEnabled } from "@/lib/server/adminAuth";

export async function GET(req: NextRequest) {
  return Response.redirect(new URL("/admin/login", req.url), 303);
}

export async function POST(req: NextRequest) {
  if (!isAdminEnabled()) {
    return Response.redirect(new URL("/admin/login?error=admin_disabled", req.url), 303);
  }
  const fd = await req.formData();
  const password = String(fd.get("password") || "");
  if (!password || !adminPasswordMatches(password)) {
    return Response.redirect(new URL("/admin/login?error=invalid_password", req.url), 303);
  }
  const cookie = createAdminSessionCookie();
  const res = Response.redirect(new URL("/admin", req.url), 303);
  res.headers.append(
    "Set-Cookie",
    `${cookie.name}=${cookie.value}; Path=${cookie.options.path}; HttpOnly; SameSite=${cookie.options.sameSite}; Max-Age=${cookie.options.maxAge}; Secure`,
  );
  return res;
}


