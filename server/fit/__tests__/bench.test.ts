/**
 * Performance: p95 < 200 ms for scoring 200 SKUs (no LLM). Uses fixtures/aurum/catalog.json when A2 has
 * produced it, plus the synthetic 200-SKU catalog. Numbers go in docs/reports/A3.md.
 *
 * Wall-clock p95 is logged; the assertion uses per-iteration CPU time (process.cpuUsage) for p95 and
 * wall-clock for p50, because parallel agents and builds on the dev box can pin the CPU at 100% and
 * make single-sample wall-clock spikes measure the machine, not the code.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogSku } from "@/server/contracts/giftfit";
import { selectDecoys } from "../decoys";
import { scoreSkus } from "../score";
import { fakeRules, makeCatalog, profile, request } from "./fixtures";

function loadCatalog(): { skus: CatalogSku[]; source: string } {
  const file = path.join(process.cwd(), "fixtures", "aurum", "catalog.json");
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const skus = (Array.isArray(raw) ? raw : (raw as { skus?: unknown[] }).skus ?? []) as CatalogSku[];
      if (skus.length > 0 && skus.every((s) => s?.attributes?.metal && typeof s.price === "number")) {
        return { skus: skus.slice(0, 200), source: "fixtures/aurum/catalog.json" };
      }
    } catch {
      // fall through to the synthetic catalog
    }
  }
  return { skus: makeCatalog(200, "bench"), source: "synthetic" };
}

const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
const p95 = (xs: number[]) => pct(xs, 0.95);

/** Runs fn n times after a warm-up; returns wall-clock and CPU milliseconds per run. */
function measure(n: number, fn: (i: number) => void): { wall: number[]; cpu: number[] } {
  for (let i = 0; i < 20; i++) fn(i);
  const wall: number[] = [];
  const cpu: number[] = [];
  for (let i = 0; i < n; i++) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    fn(i);
    wall.push(performance.now() - t0);
    const c = process.cpuUsage(c0);
    cpu.push((c.user + c.system) / 1000);
  }
  return { wall, cpu };
}

describe("performance", () => {
  it("scores 200 SKUs with p95 < 200 ms", () => {
    const real = loadCatalog();
    const runs = [{ skus: makeCatalog(200, "bench"), source: "synthetic" }, ...(real.source === "synthetic" ? [] : [real])];
    for (const { skus, source } of runs) {
      const prof = profile({ undertoneConfidence: 0.7, faceShape: "Round", heartedSkuIds: skus.slice(0, 3).map((s) => s.id) });
      const hearted = skus.slice(0, 3);
      const { wall, cpu } = measure(200, () => {
        const out = scoreSkus(prof, skus, request(), fakeRules, { heartedSkus: hearted });
        if (out.length !== skus.length) throw new Error("lost SKUs");
      });
      console.log(
        `[bench] score ${skus.length} SKUs (${source}): wall p50 ${pct(wall, 0.5).toFixed(2)} ms, wall p95 ${p95(wall).toFixed(2)} ms, cpu p95 ${p95(cpu).toFixed(2)} ms`,
      );
      expect(p95(cpu)).toBeLessThan(200);
      expect(pct(wall, 0.5)).toBeLessThan(200);
    }
  }, 60_000);

  it("selects decoys from 200 SKUs with p95 < 200 ms", () => {
    const skus = makeCatalog(200, "bench");
    const ready = skus.filter((s) => s.attributes.vto_spec_ok);
    const { wall, cpu } = measure(200, (i) => {
      selectDecoys(ready.slice(i % 50, (i % 50) + 1 + (i % 4)), skus, { seed: `b${i}` });
    });
    console.log(`[bench] selectDecoys over 200 SKUs: wall p50 ${pct(wall, 0.5).toFixed(2)} ms, wall p95 ${p95(wall).toFixed(2)} ms, cpu p95 ${p95(cpu).toFixed(2)} ms`);
    expect(p95(cpu)).toBeLessThan(200);
    expect(pct(wall, 0.5)).toBeLessThan(200);
  }, 60_000);
});
