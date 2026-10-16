/**
 * Ingest configuration from environment variables (owner: A10). Nothing here reads secrets into logs.
 *
 * | Variable | Meaning |
 * |---|---|
 * | INGEST_FIXTURE=1 | Offline mode: fetches and renders come from fixtures/ingest/ (no network, no browser). |
 * | ANTHROPIC_API_KEY | Enables the Claude extractor (Tier 3). Without it Tier 3 uses the DOM heuristic extractor. |
 * | INGEST_CLAUDE_MODEL | Default `claude-sonnet-5-5`. |
 * | VOYAGE_API_KEY | Enables real embeddings (voyage-3.5, 1024 dims). Without it: deterministic hash embedder. |
 * | INGEST_ALLOWED_HOSTS | Comma list of hosts POST /api/ingest may crawl. Empty → fixture hosts only (and localhost outside production). |
 * | INGEST_ADMIN_TOKEN | If set, POST /api/ingest requires `Authorization: Bearer <token>`. |
 * | INGEST_MAX_PAGES | Page cap per run (default 400). |
 * | INGEST_INFO_URL | URL in the User-Agent where site owners find who we are and how to opt out. |
 */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
export const DEFAULT_MAX_PAGES = 400;
/** Hosts served from fixtures/ingest/ in INGEST_FIXTURE=1 mode (reserved `.test` TLD, never resolvable). */
export const FIXTURE_HOSTS = ["aurum-fixture.test", "shopify-fixture.test", "jsonld-fixture.test"] as const;

export type Env = Record<string, string | undefined>;

export interface IngestConfig {
  fixture: boolean;
  anthropicApiKey?: string;
  claudeModel: string;
  voyageApiKey?: string;
  allowedHosts: string[];
  adminToken?: string;
  maxPages: number;
  /** Where site owners learn who we are and how to opt out (goes into the User-Agent). Unset until R0 picks one. */
  infoUrl?: string;
  production: boolean;
}

const flag = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function loadIngestConfig(env: Env = process.env): IngestConfig {
  const maxPages = Number(env.INGEST_MAX_PAGES);
  return {
    fixture: flag(env.INGEST_FIXTURE),
    anthropicApiKey: opt(env.ANTHROPIC_API_KEY),
    claudeModel: opt(env.INGEST_CLAUDE_MODEL) ?? DEFAULT_CLAUDE_MODEL,
    voyageApiKey: opt(env.VOYAGE_API_KEY),
    allowedHosts: (env.INGEST_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    adminToken: opt(env.INGEST_ADMIN_TOKEN),
    maxPages: Number.isInteger(maxPages) && maxPages > 0 ? maxPages : DEFAULT_MAX_PAGES,
    infoUrl: opt(env.INGEST_INFO_URL),
    production: env.NODE_ENV === "production",
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether POST /api/ingest may crawl this URL. Guards against SSRF and against crawling third-party
 * sites by accident: only http(s), only allow-listed hosts (fixture hosts in fixture mode, localhost
 * outside production), never raw private IPs.
 */
export function isHostAllowed(rawUrl: string, config: IngestConfig): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "only http(s) URLs" };
  if (url.username || url.password) return { ok: false, reason: "credentials in URL are not allowed" };
  const host = url.hostname.toLowerCase();
  if ((FIXTURE_HOSTS as readonly string[]).includes(host)) {
    return config.fixture ? { ok: true, url } : { ok: false, reason: "fixture host requires INGEST_FIXTURE=1" };
  }
  if (config.fixture) return { ok: false, reason: "INGEST_FIXTURE=1 only serves fixture hosts" };
  if (LOCAL_HOSTS.has(host)) {
    return config.production ? { ok: false, reason: "localhost is not allowed in production" } : { ok: true, url };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return { ok: false, reason: "raw IP hosts are not allowed" };
  if (!config.allowedHosts.includes(host)) return { ok: false, reason: `host ${host} is not in INGEST_ALLOWED_HOSTS` };
  return { ok: true, url };
}
