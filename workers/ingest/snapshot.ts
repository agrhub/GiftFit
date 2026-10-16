/**
 * Writes the INGEST_FIXTURE=1 snapshot of the Aurum fixture store: renders every HTML page of
 * fixtures/ingest/aurum-sample/site/ in headless Chromium (politely, through PlaywrightRenderer) and
 * saves the post-JavaScript DOM to fixtures/ingest/aurum-sample/rendered/ (same relative paths).
 * With --record and ANTHROPIC_API_KEY it also records real Claude extraction responses into
 * fixtures/ingest/aurum-sample/claude/ (replacing the synthetic P2 recordings).
 *
 *   npx tsx workers/ingest/snapshot.ts            # rendered snapshots only
 *   npx tsx workers/ingest/snapshot.ts --record   # + real Claude recordings (needs ANTHROPIC_API_KEY)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadIngestConfig } from "@/lib/ingest/config";
import { ClaudeExtractor, createAnthropicClient, createRecordingClient } from "@/lib/ingest/extract/claude";
import { fixtureRelPath } from "@/lib/ingest/fixtures";
import { PoliteFetcher } from "@/lib/ingest/politeness";
import { PlaywrightRenderer } from "@/lib/ingest/render";
import { serveDir } from "./static-server";

const SITE_ROOT = path.join(process.cwd(), "fixtures", "ingest", "aurum-sample");
export const AURUM_FIXTURE_ORIGIN = "https://aurum-fixture.test";

async function htmlPages(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await htmlPages(path.join(dir, e.name), rel)));
    else if (e.name.endsWith(".html")) out.push(rel);
  }
  return out;
}

/** "products/x.html" → "/products/x", "index.html" → "/", "shop/page/2.html" → "/shop/page/2". */
export const urlPathFor = (rel: string) => (rel === "index.html" ? "/" : `/${rel.replace(/\/index\.html$/, "/").replace(/\.html$/, "")}`);

export async function writeSnapshots(opts: { record?: boolean } = {}): Promise<number> {
  const config = loadIngestConfig();
  const server = await serveDir(path.join(SITE_ROOT, "site"));
  const fetcher = new PoliteFetcher({ infoUrl: config.infoUrl, maxPages: 200 });
  const renderer = new PlaywrightRenderer(fetcher);
  const recorder =
    opts.record && config.anthropicApiKey
      ? new ClaudeExtractor(createRecordingClient(await createAnthropicClient(config.anthropicApiKey), path.join(SITE_ROOT, "claude")), config.claudeModel)
      : undefined;
  if (opts.record && !recorder) console.warn("--record ignored: ANTHROPIC_API_KEY is not set");
  let n = 0;
  try {
    for (const rel of await htmlPages(path.join(SITE_ROOT, "site"))) {
      const p = urlPathFor(rel);
      const logical = `${AURUM_FIXTURE_ORIGIN}${p}`;
      const page = await renderer.render(`${server.origin}${p}`, logical);
      const out = path.join(SITE_ROOT, "rendered", fixtureRelPath(logical));
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, page.html);
      if (recorder && p.startsWith("/products/")) await recorder.extract(page);
      n++;
    }
  } finally {
    await renderer.close();
    await server.close();
  }
  return n;
}

if (process.argv[1] && /snapshot\.ts$/.test(process.argv[1])) {
  writeSnapshots({ record: process.argv.includes("--record") }).then((n) => console.log(`rendered ${n} pages`));
}
