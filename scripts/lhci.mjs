#!/usr/bin/env node
/**
 * Lighthouse CI runner (owner: A8). `npm run lhci` (needs a build: `npm run build` first).
 *
 * Starts `next start` in hermetic mock mode (same env as playwright.config.ts), seeds one Fit
 * Request through POST /api/fit/requests so a real /r/<token> page exists in this process, then
 * runs `lhci collect` (mobile preset, lighthouserc.json) on / (GiftFit home), /demo and that recipient
 * page, `lhci assert` (>= 0.9 perf/a11y/best-practices, SEO warn) and prints the median scores.
 *
 * Env: LHCI_RUNS (default 1), LHCI_PORT (3200), CHROME_PATH (default: Playwright's Chromium).
 * Exit code: lhci assert's (non-zero when a category is under 0.9).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.LHCI_PORT ?? 3200);
const BASE = `http://127.0.0.1:${PORT}`;
const RUNS = String(process.env.LHCI_RUNS ?? 1);
const SHORTLIST = ["dca42809-a2e1-5b50-8339-240170c69845", "74066662-deab-5925-b51f-4f39e11da0e3"];
const isWin = process.platform === "win32";

async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const { chromium } = await import("playwright");
  return chromium.executablePath();
}

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server not ready: ${url}`);
}

function lhci(args, env) {
  const r = spawnSync(isWin ? "npx.cmd" : "npx", ["lhci", ...args], { stdio: "inherit", env, shell: isWin });
  return r.status ?? 1;
}

const server = spawn(isWin ? "npx.cmd" : "npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  stdio: ["ignore", "ignore", "inherit"],
  shell: isWin,
  env: {
    ...process.env,
    YOUCAM_MOCK: "1",
    YOUCAM_ALLOW_PAID: "0",
    ANTHROPIC_API_KEY: "",
    VOYAGE_API_KEY: "",
    DATABASE_URL: "",
    BLOB_READ_WRITE_TOKEN: "",
    INGEST_FIXTURE: "1",
    GIFTFIT_URL_SIGNING_SECRET: randomBytes(32).toString("hex"),
    CRON_SECRET: randomBytes(24).toString("hex"),
    FIT_DECOY_SECRET: randomBytes(32).toString("hex"),
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
const stop = () => {
  if (server.exitCode !== null) return;
  if (isWin) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGTERM");
};
process.on("exit", stop);

let code = 1;
try {
  await waitFor(`${BASE}/api/fit/weights`, 120_000);
  const res = await fetch(`${BASE}/api/fit/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occasion: "anniversary", budgetMin: 150, budgetMax: 600, currency: "USD", shortlistIds: SHORTLIST }),
  });
  if (res.status !== 201) throw new Error(`seed Fit Request failed: ${res.status} ${await res.text()}`);
  const { recipientPath } = await res.json();
  const urls = ["/", "/demo", recipientPath].map((p) => BASE + p);

  const env = { ...process.env, CHROME_PATH: await chromePath() };
  rmSync(".lighthouseci", { recursive: true, force: true });
  const collect = lhci(["collect", ...urls.map((u) => `--url=${u}`), `--numberOfRuns=${RUNS}`], env);
  if (collect !== 0) throw new Error("lhci collect failed");
  code = lhci(["assert"], env);
  lhci(["upload"], env);

  // Median-ish summary (first representative run per URL).
  const manifest = path.join(".lighthouseci", "reports", "manifest.json");
  if (existsSync(manifest)) {
    const rows = JSON.parse(readFileSync(manifest, "utf8")).filter((r) => r.isRepresentativeRun);
    console.log("\nLighthouse (mobile) scores, representative run:");
    for (const r of rows) {
      const s = r.summary;
      const pct = (k) => String(Math.round((s[k] ?? 0) * 100)).padStart(3);
      console.log(`${pct("performance")} perf ${pct("accessibility")} a11y ${pct("best-practices")} bp ${pct("seo")} seo  ${r.url.replace(BASE, "").replace(/\/r\/[^/]+$/, "/r/<token>")}`);
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  code = 1;
} finally {
  stop();
}
process.exit(code);
