/**
 * Request-time framing policy for the embeddable widget frame /w (owner: A6, ADR-046).
 *
 * next.config.ts `headers()` are fixed at build time, so the /w frame-ancestors list is set here from
 * GIFTFIT_WIDGET_ORIGINS at request time (a Cloud Run env change needs no rebuild): "'self' <origins>",
 * or "*" when the variable is unset. Only frame-ancestors is set: it does not restrict scripts, WebGL or
 * same-origin assets such as /live2d/**. Every other path keeps next.config.ts's policy.
 */
import { NextResponse } from "next/server";
import { widgetFrameAncestors } from "@/lib/widget/config";

export const config = {
  matcher: ["/w", "/w/:path*"],
  runtime: "nodejs",
};

export function middleware(): NextResponse {
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", `frame-ancestors ${widgetFrameAncestors()}`);
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Content-Type-Options", "nosniff");
  return res;
}
