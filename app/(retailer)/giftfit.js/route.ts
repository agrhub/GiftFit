/**
 * GET /giftfit.js (owner: A6): serves client/plugin/giftfit.js from our origin, so a store adds
 * GiftFit with one tag: <script src="https://<app>/giftfit.js" data-store="aurum" async></script>.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const source = await readFile(path.join(process.cwd(), "client", "plugin", "giftfit.js"), "utf8");
  return new Response(source, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
