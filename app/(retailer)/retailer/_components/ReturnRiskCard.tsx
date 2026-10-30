"use client";
/**
 * Return-Risk before/after (owner: A6). Uses A3's published model as is (lib/fit/returnRisk.ts,
 * lib/fit/WEIGHTS.md): every input is editable here and every default cites docs/research/market.md.
 */
import { useId, useMemo, useState } from "react";
import {
  RETURN_COST_PRESETS,
  RETURN_RATE_PRESETS,
  RETURN_RISK_DEFAULTS,
  RETURN_RISK_FORMULA,
  RETURN_RISK_LABEL,
  portfolioReturnRisk,
} from "@/lib/fit/returnRisk";
import { Card, DataBadge, Formula, HowCalculated, int, pct, usd } from "./ui";

const RATE_OPTIONS = Object.entries(RETURN_RATE_PRESETS).map(([k, v]) => ({ key: k, value: v.rate, source: v.source }));
const COST_OPTIONS = Object.entries(RETURN_COST_PRESETS).map(([k, v]) => ({ key: k, value: v.cost, source: v.source }));
const RATE_LABEL: Record<string, string> = { fineJewelryOnline: "Fine jewelry online, 11%", holidayAllRetail: "Holiday, all retail, 17%", vendorJewelryBlended: "Jewelry blended, 4%" };

export function ReturnRiskCard({ scores, synthetic, realGifts }: { scores: number[]; synthetic: boolean; realGifts: number }) {
  const ids = { rate: useId(), cost: useId(), effect: useId() };
  const [rateKey, setRateKey] = useState("fineJewelryOnline");
  const [costKey, setCostKey] = useState("mid");
  const [effect, setEffect] = useState(RETURN_RISK_DEFAULTS.maxReduction);
  const rate = RATE_OPTIONS.find((o) => o.key === rateKey)!;
  const cost = COST_OPTIONS.find((o) => o.key === costKey)!;
  const r = useMemo(() => portfolioReturnRisk(scores, { baselineRate: rate.value, costPerReturn: cost.value, maxReduction: effect }), [scores, rate.value, cost.value, effect]);
  const per1000 = r.gifts ? (r.avoidedCost / r.gifts) * 1000 : 0;

  return (
    <Card id="return-risk" eyebrow="Return-Risk estimate" title="Before and after Fit Requests" badge={<DataBadge synthetic={synthetic} />} testId="return-risk-card">
      <p className="text-sm text-ink-soft">
        {int(r.gifts)} gifts bought through a Fit Request{synthetic ? ` (${int(realGifts)} real)` : ""}. {RETURN_RISK_LABEL}
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg bg-cream px-2 py-3">
          <dt className="text-xs text-muted">Before</dt>
          <dd className="mt-1 font-display text-3xl text-ink" data-testid="rr-before">{pct(r.before.rate, 1)}</dd>
          <dd className="text-xs text-muted">{r.before.expectedReturns.toFixed(1)} returns · {usd(r.before.expectedCost)}</dd>
        </div>
        <div className="rounded-lg bg-cream px-2 py-3">
          <dt className="text-xs text-muted">After</dt>
          <dd className="mt-1 font-display text-3xl text-ink" data-testid="rr-after">{pct(r.after.rate, 1)}</dd>
          <dd className="text-xs text-muted">{r.after.expectedReturns.toFixed(1)} returns · {usd(r.after.expectedCost)}</dd>
        </div>
        <div className="rounded-lg bg-sage/10 px-2 py-3">
          <dt className="text-xs text-sage">Avoided</dt>
          <dd className="mt-1 font-display text-3xl text-sage">{usd(r.avoidedCost)}</dd>
          <dd className="text-xs text-sage">≈ {usd(per1000)} per 1,000 gifts</dd>
        </div>
      </dl>

      <fieldset className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
        <legend className="sr-only">Model inputs</legend>
        <label htmlFor={ids.rate} className="flex flex-col gap-1 text-xs text-muted">
          Baseline return rate
          <select id={ids.rate} value={rateKey} onChange={(e) => setRateKey(e.target.value)} className="min-h-11 rounded-lg border border-line-strong bg-white px-2 text-sm text-ink">
            {RATE_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {RATE_LABEL[o.key] ?? o.key}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.cost} className="flex flex-col gap-1 text-xs text-muted">
          Cost per return
          <select id={ids.cost} value={costKey} onChange={(e) => setCostKey(e.target.value)} className="min-h-11 rounded-lg border border-line-strong bg-white px-2 text-sm text-ink">
            {COST_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {`${o.key[0].toUpperCase()}${o.key.slice(1)}, ${usd(o.value)}`}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.effect} className="flex flex-col gap-1 text-xs text-muted">
          Score effect (our assumption): ±{Math.round(effect * 100)}%
          <input id={ids.effect} type="range" min={0} max={1} step={0.05} value={effect} onChange={(e) => setEffect(Number(e.target.value))} className="min-h-11 accent-[#1f1a17]" />
        </label>
      </fieldset>

      <HowCalculated>
        <Formula>{RETURN_RISK_FORMULA}</Formula>
        <p>
          <strong className="font-medium text-ink">Before</strong> = every gift returns at the baseline rate (a gift chosen without a Fit Request scores 50).{" "}
          <strong className="font-medium text-ink">After</strong> = the mean of P(return) over the Fit Scores of the pieces actually bought.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Baseline: {rate.source}.</li>
          <li>Cost: {cost.source}. Markdown loss on resale is excluded (market.md K5 / S31), so the cost is conservative.</li>
          <li>The score effect (score 100 halves the risk, 0 raises it by half at ±50%) is our assumption; no source measures it.</li>
          <li>Benchmarks are US 2025–2026 secondary syntheses (grade C): directional, not a forecast.</li>
        </ul>
      </HowCalculated>
    </Card>
  );
}
