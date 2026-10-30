/**
 * Proof that no giver-facing endpoint can return recipient images, hex values or face
 * attributes. Enumerates every app/api route on disk; a new route fails this test until it
 * is classified in server/privacy/route-manifest.ts, and every giver route must pass the checks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findGiverLeaks } from "../giver-guard";
import { ROUTE_MANIFEST, giverSourceViolations, manifestKey } from "../route-manifest";

const ROOT = path.resolve(__dirname, "../../..");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) out.push(manifestKey(path.relative(ROOT, full)));
  }
  return out;
}

const routes = routeFiles(path.join(ROOT, "app", "api"));

/** The route file plus the project modules it imports directly (route files are often thin). server/privacy is trusted. */
function giverSources(file: string): Array<{ file: string; source: string }> {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  const out = [{ file, source }];
  for (const m of source.matchAll(/from\s+["'](@\/|\.{1,2}\/)([^"']+)["']/g)) {
    const base = m[1] === "@/" ? path.join(ROOT, m[2]) : path.resolve(path.dirname(path.join(ROOT, file)), m[1] + m[2]);
    const rel = manifestKey(path.relative(ROOT, base));
    if (rel.startsWith("server/privacy/")) continue;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (existsSync(candidate)) {
        out.push({ file: manifestKey(path.relative(ROOT, candidate)), source: readFileSync(candidate, "utf8") });
        break;
      }
    }
  }
  return out;
}

describe("route-audience manifest", () => {
  it("finds the app/api routes on disk", () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toContain("app/api/recipient/delete/route.ts");
  });

  it("classifies every app/api/**/route.ts", () => {
    const missing = routes.filter((r) => !(r in ROUTE_MANIFEST));
    expect(missing, `add these routes to server/privacy/route-manifest.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no stale entries", () => {
    const stale = Object.entries(ROUTE_MANIFEST)
      .filter(([k, e]) => !routes.includes(k) && !e.planned)
      .map(([k]) => k);
    expect(stale, `remove or fix these manifest entries: ${stale.join(", ")}`).toEqual([]);
  });

  const giverRoutes = Object.entries(ROUTE_MANIFEST).filter(([, e]) => e.audience === "giver");

  it("has at least one giver route to check once the Fit Engine exists", () => {
    if (existsSync(path.join(ROOT, "app", "api", "fit"))) expect(giverRoutes.length).toBeGreaterThan(0);
  });

  for (const [file, entry] of giverRoutes.filter(([f]) => existsSync(path.join(ROOT, f)))) {
    it(`giver route ${file} never touches recipient imagery or raw analysis, and guards its output`, async () => {
      const sources = giverSources(file);
      const combined = sources.map((s) => s.source).join(String.fromCharCode(10));
      // ndjsonStream routes (A7) may build their one streaming Response: each line passes assertGiverSafe.
      // audioResponse routes (A13 voice TTS) may build their one audio Response; JSON still uses giverJson.
      const violations = giverSourceViolations(combined).filter((v) => !((entry.ndjsonStream || entry.audioResponse) && v.startsWith("builds a raw Response")));
      const guardMissing = violations.filter((v) => v.includes("giverJson"));
      const hard = violations.filter((v) => !v.includes("giverJson"));
      expect(hard, `${file} (+ ${sources.slice(1).map((s) => s.file).join(", ")})`).toEqual([]);
      if (entry.guardPending) {
        expect(guardMissing.length, `${file}: guardPending is stale, remove it from the manifest`).toBeGreaterThan(0);
        console.warn(`[privacy] ${file}: output guard pending (${entry.guardPending})`);
      } else {
        expect(guardMissing, file).toEqual([]);
      }
      if (entry.samplesModule) {
        const mod = (await import(/* @vite-ignore */ path.join(ROOT, entry.samplesModule))) as { giverResponseSamples?: unknown[] };
        expect(Array.isArray(mod.giverResponseSamples) && mod.giverResponseSamples.length > 0, `${entry.samplesModule} exports giverResponseSamples`).toBe(true);
        for (const sample of mod.giverResponseSamples ?? []) {
          expect(findGiverLeaks(sample, { allowProductImages: entry.allowsProductImages })).toEqual([]);
        }
      }
    });
  }

  it("recipient routes live under app/api/recipient and nothing else claims that audience", () => {
    for (const [file, e] of Object.entries(ROUTE_MANIFEST)) {
      if (e.audience === "recipient") expect(file.startsWith("app/api/recipient/"), file).toBe(true);
      if (file.startsWith("app/api/recipient/")) expect(["recipient", "internal"], file).toContain(e.audience);
    }
  });
});

describe("giver source scanner (self-test)", () => {
  it("accepts a guarded route", () => {
    const ok = `import { giverJson } from "@/server/privacy/giver-guard";
      export async function GET() { const r = await loadReport(); return giverJson({ items: r.items }); }`;
    expect(giverSourceViolations(ok)).toEqual([]);
  });

  it.each([
    ["unguarded JSON", `export async function GET() { return Response.json({ a: 1 }); }`, /without giverJson/],
    ["raw image response", `import { giverJson } from "x"; export async function GET() { return new Response(bytes); }`, /raw Response/],
    ["try-on reference", `import { giverJson } from "x"; const u = row.resultRef; giverJson({ u });`, /try-on image/],
    ["raw colors", `import { giverJson } from "x"; giverJson({ c: analysis.colors.skin_color });`, /raw facial colors/],
    ["photo store", `import { createPhotoStore } from "@/server/privacy/photo-store"; giverJson({});`, /photo store/],
    ["raw analysis", `import { analyzeRecipient } from "@/server/youcam"; giverJson({});`, /raw YouCam analysis/],
  ])("rejects %s", (_n, src, re) => {
    expect(giverSourceViolations(src).join("; ")).toMatch(re);
  });
});
