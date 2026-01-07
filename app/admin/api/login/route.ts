export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createAdminSessionCookie, adminPasswordMatches, isAdminEnabled } from "@/lib/server/adminAuth";

export async function GET(req: NextRequest) {
  return NextResponse.redirect(new URL("/admin/login", req.url), 303);
}

export async function POST(req: NextRequest) {
  try {
    if (!isAdminEnabled()) {
      return NextResponse.redirect(new URL("/admin/login?error=admin_disabled", req.url), 303);
    }
    const fd = await req.formData();
    const password = String(fd.get("password") || "");
    if (!password || !adminPasswordMatches(password)) {
      return NextResponse.redirect(new URL("/admin/login?error=invalid_password", req.url), 303);
    }
    const cookie = createAdminSessionCookie();
    const res = NextResponse.redirect(new URL("/admin", req.url), 303);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(new URL(`/admin/login?error=internal&message=${encodeURIComponent(msg)}`, req.url), 303);
  }
}


