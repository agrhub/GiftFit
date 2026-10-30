/**
 * Undertone fairness harness (owner: A5). Runs any `JewelryRules.estimateUndertone` over the
 * fairness fixtures and reports misclassification per Fitzpatrick group, with a specific flag
 * for "darker skin misread as cooler" (MASTER_PLAN v2 §9, first risk).
 */
import type { JewelryRules, Undertone } from "@/server/contracts/giftfit";
import { hexToLab, hueDeg } from "./color";
import { FITZPATRICK_ORDER, type FairnessFixture, type Fitzpatrick } from "./fixtures";

const refHue = (hex: string) => hueDeg(hexToLab(hex));

const ORDER: Record<Undertone, number> = { cool: 0, neutral: 1, warm: 2 };
/** Confidence at or above which a wrong answer counts as "confident" (the UI only nudges below 0.6). */
export const CONFIDENT = 0.6;
/** Flag thresholds. */
export const FLAG_GAP = 0.1;

export interface FixtureResult extends FairnessFixture {
  predicted: Undertone;
  confidence: number;
  correct: boolean;
  /** Predicted cooler than the label (warm->neutral/cool, neutral->cool). */
  cooler: boolean;
  warmer: boolean;
}

export interface GroupStats {
  group: Fitzpatrick;
  n: number;
  errors: number;
  errorRate: number;
  coolerErrors: number;
  coolerRate: number;
  warmerErrors: number;
  warmerRate: number;
  confidentErrors: number;
  meanConfidence: number;
  confusion: Record<Undertone, Record<Undertone, number>>;
}

export interface SweepDrift {
  label: Undertone;
  /** Predictions from light (L* 90) to deep (L* 20). */
  predictions: Array<{ L: number; predicted: Undertone; confidence: number }>;
  /** Number of label changes along the sweep (0 = depth-invariant). */
  changes: number;
  /** Deep end (L* <= 40) predicted cooler than the light end (L* >= 70). */
  deepCooler: boolean;
}

/** Per MST tone: can the estimator tell the warm and cool variants of THIS depth apart? */
export interface DepthResolution {
  mst: number;
  fitzpatrick: Fitzpatrick;
  L: number;
  C: number;
  /** Reference hue of the tone (degrees). */
  hueDeg: number;
  /** Predictions for shifts -14, -8, 0, +8, +14. */
  predictions: Undertone[];
  /** Strong warm variant predicted warmer than strong cool variant. */
  separates: boolean;
  /** Predictions go cooler as the hue goes warmer somewhere along the row. */
  monotonicViolations: number;
}

export interface FairnessReport {
  total: number;
  errors: number;
  errorRate: number;
  groups: GroupStats[];
  sweeps: SweepDrift[];
  depth: DepthResolution[];
  flags: string[];
  results: FixtureResult[];
}

const emptyConfusion = (): Record<Undertone, Record<Undertone, number>> => ({
  cool: { cool: 0, neutral: 0, warm: 0 },
  neutral: { cool: 0, neutral: 0, warm: 0 },
  warm: { cool: 0, neutral: 0, warm: 0 },
});

const rate = (k: number, n: number) => (n ? k / n : 0);

export function evaluateFairness(rules: Pick<JewelryRules, "estimateUndertone">, fixtures: readonly FairnessFixture[]): FairnessReport {
  const results: FixtureResult[] = fixtures.map((fx) => {
    const est = rules.estimateUndertone({ skin_color: fx.hex });
    const d = ORDER[est.undertone] - ORDER[fx.label];
    return { ...fx, predicted: est.undertone, confidence: est.confidence, correct: d === 0, cooler: d < 0, warmer: d > 0 };
  });

  const groups: GroupStats[] = FITZPATRICK_ORDER.map((group) => {
    const rs = results.filter((r) => r.fitzpatrick === group);
    const confusion = emptyConfusion();
    for (const r of rs) confusion[r.label][r.predicted]++;
    const errors = rs.filter((r) => !r.correct).length;
    const coolerErrors = rs.filter((r) => r.cooler).length;
    const warmerErrors = rs.filter((r) => r.warmer).length;
    return {
      group,
      n: rs.length,
      errors,
      errorRate: rate(errors, rs.length),
      coolerErrors,
      coolerRate: rate(coolerErrors, rs.length),
      warmerErrors,
      warmerRate: rate(warmerErrors, rs.length),
      confidentErrors: rs.filter((r) => !r.correct && r.confidence >= CONFIDENT).length,
      meanConfidence: rate(
        rs.reduce((a, r) => a + r.confidence, 0),
        rs.length,
      ),
      confusion,
    };
  });

  const sweeps: SweepDrift[] = (["cool", "neutral", "warm"] as const).map((label) => {
    const rs = results.filter((r) => r.family === "depth-sweep" && r.label === label).sort((a, b) => b.L - a.L);
    let changes = 0;
    for (let i = 1; i < rs.length; i++) if (rs[i].predicted !== rs[i - 1].predicted) changes++;
    const light = rs.filter((r) => r.L >= 70).map((r) => ORDER[r.predicted]);
    const deep = rs.filter((r) => r.L <= 40).map((r) => ORDER[r.predicted]);
    const deepCooler = light.length > 0 && deep.length > 0 && Math.min(...deep) < Math.min(...light);
    return { label, predictions: rs.map((r) => ({ L: r.L, predicted: r.predicted, confidence: r.confidence })), changes, deepCooler };
  });

  const depth: DepthResolution[] = [...new Set(results.filter((r) => r.family === "mst-rotation").map((r) => r.mst))].sort((a, b) => a - b).map((mst) => {
    const row = results.filter((r) => r.family === "mst-rotation" && r.mst === mst).sort((a, b) => a.shiftDeg - b.shiftDeg);
    const ref = row.find((r) => r.shiftDeg === 0) ?? row[0];
    const ords = row.map((r) => ORDER[r.predicted]);
    let monotonicViolations = 0;
    for (let i = 1; i < ords.length; i++) if (ords[i] < ords[i - 1]) monotonicViolations++;
    return {
      mst,
      fitzpatrick: ref.fitzpatrick,
      L: ref.L,
      C: ref.C,
      hueDeg: Math.round(refHue(ref.hex) * 10) / 10,
      predictions: row.map((r) => r.predicted),
      separates: ords[ords.length - 1] > ords[0],
      monotonicViolations,
    };
  });

  const flags: string[] = [];
  const g = (k: Fitzpatrick) => groups.find((x) => x.group === k)!;
  const light = [g("I"), g("II")];
  const dark = [g("V"), g("VI")];
  const pooled = (gs: GroupStats[], key: "coolerErrors" | "errors") => rate(gs.reduce((a, x) => a + x[key], 0), gs.reduce((a, x) => a + x.n, 0));
  const coolerGap = pooled(dark, "coolerErrors") - pooled(light, "coolerErrors");
  if (coolerGap >= FLAG_GAP) {
    flags.push(`DARKER_MISREAD_AS_COOLER: V–VI are read cooler than labelled ${(100 * pooled(dark, "coolerErrors")).toFixed(0)}% of the time vs ${(100 * pooled(light, "coolerErrors")).toFixed(0)}% for I–II`);
  }
  const darkWarmToCool = results.filter((r) => (r.fitzpatrick === "V" || r.fitzpatrick === "VI") && r.label === "warm" && r.predicted === "cool");
  if (darkWarmToCool.length) flags.push(`DARK_WARM_READ_AS_COOL: ${darkWarmToCool.map((r) => r.id).join(", ")}`);
  for (const s of sweeps) if (s.deepCooler) flags.push(`DEPTH_SWEEP_${s.label.toUpperCase()}_TURNS_COOLER_WHEN_DARKER`);
  const errGap = pooled(dark, "errors") - pooled(light, "errors");
  if (errGap >= FLAG_GAP) flags.push(`HIGHER_ERROR_ON_DARKER_SKIN: ${(100 * pooled(dark, "errors")).toFixed(0)}% (V–VI) vs ${(100 * pooled(light, "errors")).toFixed(0)}% (I–II)`);
  const confidentDark = dark.reduce((a, x) => a + x.confidentErrors, 0);
  if (confidentDark) flags.push(`CONFIDENT_ERRORS_ON_DARKER_SKIN: ${confidentDark} wrong answers with confidence >= ${CONFIDENT} in V–VI`);

  const noSep = depth.filter((d) => !d.separates);
  if (noSep.length) flags.push(`NO_WARM_COOL_SEPARATION: MST ${noSep.map((d) => `${d.mst} (${d.fitzpatrick})`).join(", ")}`);
  const nonMono = depth.filter((d) => d.monotonicViolations > 0);
  if (nonMono.length) flags.push(`NON_MONOTONIC: MST ${nonMono.map((d) => d.mst).join(", ")}`);

  const errors = results.filter((r) => !r.correct).length;
  return { total: results.length, errors, errorRate: rate(errors, results.length), groups, sweeps, depth, flags, results };
}

const pct = (x: number) => `${(100 * x).toFixed(0)}%`;

export function formatFairnessReport(r: FairnessReport, title = "Undertone fairness"): string {
  const lines: string[] = [];
  lines.push(`## ${title}`, "");
  lines.push(`Fixtures: ${r.total} · misclassified: ${r.errors} (${pct(r.errorRate)})`, "");
  lines.push("| Fitzpatrick | n | misclassified | read cooler | read warmer | confident errors (≥ 0.6) | mean confidence |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const g of r.groups) {
    lines.push(`| ${g.group} | ${g.n} | ${g.errors} (${pct(g.errorRate)}) | ${g.coolerErrors} (${pct(g.coolerRate)}) | ${g.warmerErrors} (${pct(g.warmerRate)}) | ${g.confidentErrors} | ${g.meanConfidence.toFixed(2)} |`);
  }
  lines.push("", "Per depth (MST tone, its own L*, C* and hue; variants rotated −14/−8/0/+8/+14°; c/n/w = cool/neutral/warm):", "");
  lines.push("| MST | Fitzpatrick | L* | C* | h* | −14 | −8 | 0 | +8 | +14 | separates warm/cool |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const d of r.depth) {
    lines.push(`| ${d.mst} | ${d.fitzpatrick} | ${d.L.toFixed(0)} | ${d.C.toFixed(1)} | ${d.hueDeg.toFixed(0)}° | ${d.predictions.map((p) => p[0]).join(" | ")} | ${d.separates ? "yes" : "**no**"} |`);
  }
  lines.push("", "Depth sweeps (same hue and chroma, L* 90 → 20):", "");
  for (const s of r.sweeps) {
    lines.push(`- ${s.label}: ${s.predictions.map((p) => `${p.L}:${p.predicted[0]}`).join(" ")} · label changes ${s.changes}${s.deepCooler ? " · **turns cooler when darker**" : ""}`);
  }
  lines.push("", r.flags.length ? "Flags:" : "Flags: none", "");
  for (const f of r.flags) lines.push(`- ${f}`);
  return lines.join("\n");
}
