/**
 * GET /api/youcam/mock-asset/<name>.png
 * Serves the self-made placeholder images that mock fixtures reference as result
 * URLs. Only active in mock mode; 404 otherwise.
 */
import { promises as fs } from "node:fs";
import { loadYoucamConfig } from "@/server/youcam/config";
import { fixtureImagePath } from "@/server/youcam/mock";

export const runtime = "nodejs";

const NAME = /^[a-z0-9-]+\.png$/;

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await ctx.params;
  const config = loadYoucamConfig();
  if (!config.mock || !NAME.test(name)) return new Response("not found", { status: 404 });
  try {
    const bytes = await fs.readFile(fixtureImagePath(config.fixturesDir, name));
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
