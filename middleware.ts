/**
 * Request-time policies (owner: A6; ADR-046, ADR-055). next.config.ts `headers()` are fixed at build time,
 * so anything that depends on runtime env or data is decided here.
 *
 * /w (widget frame): `Content-Security-Policy: frame-ancestors …` from GIFTFIT_WIDGET_ORIGINS
 *   ("'self' <origins>", or "*" when unset). For `store=preview:<key>` whose preview is READY, any https
 *   origin is allowed too ("'self' https: <origins>"), so the bookmarklet works on the owner's live site;
 *   a missing / not-ready preview gets the normal policy. Only frame-ancestors is set (WebGL and the
 *   same-origin /live2d/** and /voice/** assets are unaffected).
 * /s/<key>/** (preview store): X-Robots-Tag noindex, nofollow; no Referer to the merchant.
 * /admin/<key>/** (Admin v0): only the owner cookie (HttpOnly, SameSite=Strict, scoped to the path) opens it;
 *   otherwise 403, whose page turns the owner link's #t= fragment into that cookie through
 *   POST /api/preview/<key>/session. A token in the query (?t=) is never accepted: it would reach request
 *   logs and Referer headers.
 */
import { NextResponse, type NextRequest } from "next/server";
import { widgetFrameAncestors } from "@/lib/widget/config";
import { isReadyPreviewStore } from "@/lib/widget/preview-key";
import { adminKeyOf, forbiddenHtml, OWNER_COOKIE, verifyOwner } from "@/lib/widget/preview-admin";

export const config = {
  matcher: ["/w", "/w/:path*", "/s/:path*", "/admin/:path*"],
  runtime: "nodejs",
};

const PRIVATE_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function withHeaders<T extends NextResponse>(res: T, headers: Record<string, string>): T {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, searchParams } = req.nextUrl;

  if (pathname === "/w" || pathname.startsWith("/w/")) {
    const previewReady = await isReadyPreviewStore(searchParams.get("store"));
    return withHeaders(NextResponse.next(), {
      "Content-Security-Policy": `frame-ancestors ${widgetFrameAncestors(process.env, { previewReady })}`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
  }

  if (pathname.startsWith("/s/")) return withHeaders(NextResponse.next(), PRIVATE_HEADERS);

  const key = adminKeyOf(pathname);
  if (pathname.startsWith("/admin/")) {
    // same-origin, not no-referrer: Admin v0 uses server actions (same-origin POSTs). Under no-referrer the
    // browser sends "Origin: null" on POST, which Next.js server actions reject (Invalid URL "null").
    // No referrer still leaves the site; merchant images keep referrerpolicy="no-referrer" on the tag.
    const headers = { ...PRIVATE_HEADERS, "Referrer-Policy": "same-origin", "Cache-Control": "private, no-store" };
    if (!key) return withHeaders(new NextResponse("Not found", { status: 404 }), headers);

    // ?t= is refused without even checking it (the 403 page also strips the query from the address bar).
    if (searchParams.has("t")) return withHeaders(new NextResponse(forbiddenHtml(key), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }), headers);
    const rec = await verifyOwner(key, req.cookies.get(OWNER_COOKIE)?.value);
    if (!rec) return withHeaders(new NextResponse(forbiddenHtml(key), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }), headers);
    return withHeaders(NextResponse.next(), headers);
  }

  return NextResponse.next();
}
