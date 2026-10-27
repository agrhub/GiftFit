/**
 * POST /api/preview/<key>/session  { token } (owner: A6, ADR-055): turns the preview owner token from a
 * `#t=` link fragment into the Admin v0 cookie (HttpOnly, SameSite=Strict, Path=/admin/<key>, until the
 * preview expires). 204 on success; 403 { error: "forbidden" } for a wrong, malformed or expired token.
 * Same-origin only (the browser sends Origin; a cross-site POST is refused). The token is never logged
 * or echoed.
 */
import { ownerCookie, verifyOwner } from "@/lib/widget/preview-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  if (origin && originHost(origin) !== host) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  let token: unknown;
  try {
    token = ((await req.json()) as { token?: unknown })?.token;
  } catch {
    token = undefined;
  }
  const rec = typeof token === "string" ? await verifyOwner(key, token) : null;
  if (!rec || typeof token !== "string") return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const secure = (req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "")) === "https";
  return new Response(null, { status: 204, headers: { ...NO_STORE, "Set-Cookie": ownerCookie(key, token, rec.expiresAt, { secure }) } });
}
