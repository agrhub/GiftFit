/**
 * Ingest entry point (owner: A10): builds the dependency set from configuration.
 *
 * | Mode | Fetch | Render | Extract | Embed | Store |
 * |---|---|---|---|---|---|
 * | INGEST_FIXTURE=1 | fixtures/ingest/<site>/site | rendered/ snapshots | DOM heuristic (or recorded Claude with INGEST_EXTRACTOR=recorded) | hash | memory |
 * | live, no keys | polite HTTP | Playwright | DOM heuristic | hash | memory, or Postgres if DATABASE_URL |
 * | live, keys | polite HTTP | Playwright | Claude claude-sonnet-5-5 | Voyage voyage-3.5 | Postgres |
 */
import path from "node:path";
import { loadIngestConfig, type Env, type IngestConfig } from "./config";
import { createEmbedder, HashEmbedder } from "./embed";
import { ClaudeExtractor, createAnthropicClient, createRecordedClient } from "./extract/claude";
import { HeuristicExtractor } from "./extract/heuristic";
import type { Extractor } from "./extract/types";
import { createFixtureFetch, FIXTURES_ROOT } from "./fixtures";
import type { IngestDeps } from "./pipeline";
import { PoliteFetcher } from "./politeness";
import { PlaywrightRenderer, SnapshotRenderer } from "./render";
import { DbCatalogSink, InMemoryCatalogSink, type CatalogSink } from "./store";

export * from "./types";
export { runIngest, type IngestOptions, type IngestResult } from "./pipeline";
export { loadIngestConfig, isHostAllowed } from "./config";

export async function createIngestDeps(
  env: Env = process.env,
  overrides: Partial<IngestDeps> & { config?: IngestConfig } = {},
): Promise<IngestDeps & { config: IngestConfig }> {
  const config = overrides.config ?? loadIngestConfig(env);
  const sink: CatalogSink = overrides.sink ?? (!config.fixture && env.DATABASE_URL?.trim() ? new DbCatalogSink() : new InMemoryCatalogSink());

  if (config.fixture) {
    const fetcher =
      overrides.fetcher ??
      new PoliteFetcher({ fetch: createFixtureFetch(), sleep: async () => {}, maxPages: config.maxPages, infoUrl: config.infoUrl });
    let extractor: Extractor = new HeuristicExtractor();
    if (env.INGEST_EXTRACTOR === "recorded") extractor = new ClaudeExtractor(createRecordedClient(path.join(FIXTURES_ROOT, "aurum-sample", "claude")));
    return {
      config,
      fetcher,
      renderer: overrides.renderer ?? new SnapshotRenderer(),
      extractor: overrides.extractor ?? extractor,
      embedder: overrides.embedder ?? new HashEmbedder(),
      sink,
      onProgress: overrides.onProgress,
    };
  }

  const fetcher = overrides.fetcher ?? new PoliteFetcher({ maxPages: config.maxPages, infoUrl: config.infoUrl });
  let extractor = overrides.extractor;
  if (!extractor) {
    extractor =
      config.anthropicApiKey && env.INGEST_EXTRACTOR !== "heuristic"
        ? new ClaudeExtractor(await createAnthropicClient(config.anthropicApiKey), config.claudeModel)
        : new HeuristicExtractor();
  }
  return {
    config,
    fetcher,
    renderer: overrides.renderer ?? new PlaywrightRenderer(fetcher),
    extractor,
    embedder: overrides.embedder ?? createEmbedder(env),
    sink,
    onProgress: overrides.onProgress,
  };
}
