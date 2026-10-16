/**
 * Ingest CLI (owner: A10). Runs one ingest in the foreground and prints coverage.
 *
 *   INGEST_FIXTURE=1 npx tsx workers/ingest/cli.ts --url https://aurum-fixture.test/
 *   npx tsx workers/ingest/cli.ts --url https://<aurum-host>/ --tier 3 --max 300 --out .giftfit/aurum-ingest.json
 *
 * Live runs need the host in INGEST_ALLOWED_HOSTS (same guard as POST /api/ingest). Uses Claude when
 * ANTHROPIC_API_KEY is set, Voyage when VOYAGE_API_KEY is set, Postgres when DATABASE_URL is set.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createIngestDeps } from "@/lib/ingest/index";
import { isHostAllowed } from "@/lib/ingest/config";
import { runIngest } from "@/lib/ingest/pipeline";
import type { IngestTier } from "@/lib/ingest/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const url = arg("url");
  if (!url) {
    console.error("usage: tsx workers/ingest/cli.ts --url <store url> [--tier 1|2|3] [--max N] [--out file.json]");
    return 2;
  }
  const deps = await createIngestDeps(process.env, {
    onProgress: (p) => process.stderr.write(`\r${p.phase.padEnd(9)} discovered ${p.discovered} processed ${p.processed} skus ${p.skus} errors ${p.errors}   `),
  });
  const allowed = isHostAllowed(url, deps.config);
  if (!allowed.ok) {
    console.error(`refused: ${allowed.reason}`);
    return 2;
  }
  const tierArg = arg("tier");
  const tier = tierArg ? (Number(tierArg) as IngestTier) : "auto";
  const max = arg("max") ? Number(arg("max")) : undefined;
  try {
    const r = await runIngest({ url, tier, maxProducts: max }, deps);
    process.stderr.write("\n");
    const c = r.coverage;
    console.log(
      JSON.stringify(
        {
          status: r.status,
          fatal: r.fatal,
          platform: r.platform,
          tier: r.tier,
          extractor: r.extractor,
          embedder: deps.embedder.name,
          sink: deps.sink.name,
          discovered: r.discovered,
          skus: c.total,
          coverage: { metal: c.withMetal, price: c.withPrice, images: c.withImages, all3: c.withAll3, ratio: Number(c.ratio.toFixed(3)) },
          droppedFields: r.dropped.reduce((n, d) => n + d.fields.length, 0),
          errors: r.errors.length,
          fetcher: deps.fetcher.stats(),
        },
        null,
        2,
      ),
    );
    const out = arg("out");
    if (out) {
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, `${JSON.stringify(r, null, 2)}\n`);
    }
    return r.status === "done" ? 0 : 1;
  } finally {
    await deps.renderer?.close();
  }
}

if (process.argv[1] && /cli\.ts$/.test(process.argv[1])) {
  main().then((code) => process.exit(code));
}
