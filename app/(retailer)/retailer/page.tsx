/**
 * /retailer — Retailer Console (owner: A6, MASTER_PLAN v2 G8, §3.3 step 7). Desktop-first, responsive.
 * Aggregates only: no recipient photos, colors, LAB, face attributes or per-person estimates; any
 * undertone or face-shape breakdown needs a cohort of at least 5. Synthetic demo requests are
 * labelled on every card that counts them, and real numbers are always shown next to them.
 */
import Link from "next/link";
import { FIT_WEIGHTS_VERSION } from "@/server/fit/weights";
import { categoryInfo } from "@/client/store/format";
import { loadIngestConfig } from "@/server/ingest/config";
import { buildRetailerSnapshot, type DataView } from "@/server/metrics/console";
import { MIN_COHORT, type CohortMix } from "@/server/metrics/types";
import { getPurchaseLog } from "@/server/metrics/purchases";
import { SYNTHETIC_ASSUMPTIONS } from "@/server/metrics/synthetic";
import { FACE_SHAPE_WORDS } from "@/server/privacy/labels";
import { getPrivacyDeps } from "@/server/privacy/runtime";
import type { Metal } from "@/server/contracts/giftfit";
import { IngestBox } from "./_components/IngestBox";
import { ReturnRiskCard } from "./_components/ReturnRiskCard";
import { ScriptTagCard } from "./_components/ScriptTagCard";
import { Bar, Card, DataBadge, Formula, HowCalculated, TONE_FILL, int, pct, ratePct, usd } from "./_components/ui";

export const dynamic = "force-dynamic";

const METAL_WORDS: Record<Metal, string> = { yellow_gold: "yellow gold", rose_gold: "rose gold", white_gold: "white gold", silver: "silver", platinum: "platinum", mixed_two_tone: "two-tone" };
const TONE_WORD = { warm: "Warm", neutral: "Neutral", cool: "Cool" } as const;

function Mix({ title, mix, words }: { title: string; mix: CohortMix<string>; words: (k: string) => string }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {mix.suppressed ? (
        <p className="mt-2 rounded-lg bg-cream px-3 py-2 text-sm text-ink-soft" data-testid="cohort-suppressed">
          Hidden: {mix.cohort} completed request{mix.cohort === 1 ? "" : "s"}, fewer than {MIN_COHORT}.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {mix.cells.map((c) => (
            <li key={c.key} className="grid grid-cols-[6.5rem_1fr_4.5rem] items-center gap-3 text-sm">
              <span className="text-ink-soft">{words(c.key)}</span>
              <Bar value={c.share ?? 0} fill={TONE_FILL[c.key as keyof typeof TONE_FILL] ?? "bg-ink-soft"} label={`${words(c.key)}: ${c.share === null ? `fewer than ${MIN_COHORT}` : pct(c.share)}`} />
              <span className="text-right tabular-nums text-ink">{c.count === null ? `< ${MIN_COHORT}` : pct(c.share)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function RetailerConsolePage({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const view: DataView = (await searchParams).data === "real" ? "real" : "all";
  const snap = await buildRetailerSnapshot({ repos: (await getPrivacyDeps()).repos, purchases: getPurchaseLog() }, { view });
  const ingest = loadIngestConfig();
  const synthetic = snap.includesSynthetic;
  const c = snap.combined;
  const r = snap.real;
  const stage = (k: string) => c.funnel.stages.find((s) => s.key === k)!;
  const realStage = (k: string) => r.funnel.stages.find((s) => s.key === k)!;
  const cov = snap.coverage;
  const gap = cov.gap;
  const realNote = (n: string) => (synthetic ? <p className="mt-1 text-xs text-muted">Real only: {n}</p> : null);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 md:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-gold-deep">{snap.store.name}</p>
          <h1 className="mt-2 font-display text-4xl text-ink sm:text-5xl">Retailer Console</h1>
          <p className="mt-2 text-sm text-ink-soft" data-testid="source-counts">
            {int(snap.sources.real)} real Fit Request{snap.sources.real === 1 ? "" : "s"} in this store
            {synthetic ? ` + ${int(snap.sources.synthetic)} synthetic demo requests` : ""} · {int(snap.store.skuCount)} SKUs in the catalog
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <DataBadge synthetic={synthetic} />
          <nav aria-label="Data shown" className="inline-flex rounded-full border border-line-strong bg-white p-1 text-sm">
            {(
              [
                ["all", "Real + synthetic demo"],
                ["real", "Real only"],
              ] as const
            ).map(([k, label]) => (
              <Link
                key={k}
                href={k === "all" ? "/retailer" : "/retailer?data=real"}
                aria-current={view === k ? "page" : undefined}
                className={`inline-flex min-h-10 items-center rounded-full px-4 ${view === k ? "bg-ink text-ivory" : "text-ink-soft hover:text-ink"}`}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {synthetic ? (
        <p className="mt-6 rounded-xl border border-rose/30 bg-blush px-4 py-3 text-sm text-ink" role="note" data-testid="synthetic-notice">
          <strong className="font-medium text-rose">Synthetic demo data.</strong> Funnel, hearted→bought, Return-Risk and recipient-mix numbers include {int(snap.sources.synthetic)} seeded,
          generated Fit Requests so the console has volume for the demo. They are not real shoppers. Real requests are counted on every card under &quot;Real only&quot;. Undertone Coverage
          uses the live catalog only.
        </p>
      ) : null}

      {/* KPI row */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Completion rate" eyebrow="Fit Requests" badge={<DataBadge synthetic={synthetic} />} testId="kpi-completion">
          <p className="font-display text-5xl text-ink">{ratePct(stage("completed").overallRate)}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {int(stage("completed").count)} of {int(stage("sent").count)} sent requests completed
          </p>
          {realNote(`${int(realStage("completed").count)} of ${int(realStage("sent").count)}`)}
          <HowCalculated>
            <Formula>completion = completed / sent</Formula>
            <p>Completed = the recipient sent their hearts (status completed).</p>
          </HowCalculated>
        </Card>
        <Card title="Hearted → bought" eyebrow="Conversion" badge={<DataBadge synthetic={synthetic} />} testId="kpi-hearted">
          <p className="font-display text-5xl text-ink">{ratePct(c.heartedToBought.requestRate)}</p>
          <p className="mt-1 text-sm text-ink-soft">
            of givers whose recipient hearted a shortlisted piece bought a hearted piece ({int(c.heartedToBought.requestRate.numerator)}/{int(c.heartedToBought.requestRate.denominator)})
          </p>
          {realNote(`${int(r.heartedToBought.requestRate.numerator)}/${int(r.heartedToBought.requestRate.denominator)}`)}
          <HowCalculated>
            <Formula>{"hearted→bought = completed requests where a hearted shortlist piece was bought\n               / completed requests with ≥ 1 hearted shortlist piece"}</Formula>
          </HowCalculated>
        </Card>
        <Card title="Cool-undertone coverage" eyebrow="Catalog gap" badge={<DataBadge synthetic={false} label="Live catalog" />} testId="kpi-coverage">
          <p className="font-display text-5xl text-gold-deep" data-testid="coverage-headline">
            {pct(gap?.share)}
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            Only {int(gap?.count ?? 0)} of {int(cov.total)} SKUs suit a {gap?.tone ?? "cool"} undertone estimate
          </p>
          <HowCalculated>
            <Formula>{"coverage(tone) = SKUs whose metal is \"recommended\" for tone / all SKUs"}</Formula>
            <p>Rule table: server/verticals/jewelry.ts (jewelryRules.metalFit), sourced in docs/research/jewelry_rules.md.</p>
          </HowCalculated>
        </Card>
        <Card title="Return cost avoided" eyebrow="Estimate" badge={<DataBadge synthetic={synthetic} />} testId="kpi-return">
          <p className="font-display text-5xl text-sage">{usd(c.returnRisk.avoidedCost)}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {c.returnRisk.avoidedReturns.toFixed(1)} fewer expected returns on {int(c.returnRisk.gifts)} gifts ({pct(c.returnRisk.before.rate, 1)} → {pct(c.returnRisk.after.rate, 1)})
          </p>
          {realNote(`${usd(r.returnRisk.avoidedCost)} on ${int(r.returnRisk.gifts)} gifts`)}
          <HowCalculated>
            <p>Default inputs (11% baseline, $37 per return, ±50% score effect). Edit them in the Return-Risk card below.</p>
          </HowCalculated>
        </Card>
      </div>

      {/* Funnel + hearted */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card id="funnel" eyebrow="Fit Request funnel" title="Sent → opened → completed → purchased" badge={<DataBadge synthetic={synthetic} />} testId="funnel-card">
          <ol className="space-y-4">
            {c.funnel.stages.map((s) => (
              <li key={s.key} className="grid grid-cols-[6.5rem_1fr_7.5rem] items-center gap-3 sm:grid-cols-[7rem_1fr_9rem]" data-testid={`funnel-${s.key}`}>
                <span className="text-sm text-ink-soft">{s.label}</span>
                <Bar value={s.overallRate.value ?? 0} fill={s.key === "purchased" ? "bg-sage" : "bg-ink"} label={`${s.label}: ${int(s.count)}, ${ratePct(s.overallRate)} of sent`} />
                <span className="text-right text-sm tabular-nums text-ink">
                  <strong className="font-medium">{int(s.count)}</strong>
                  <span className="text-muted"> · {s.stepRate ? `${ratePct(s.stepRate)} of prev.` : "100%"}</span>
                </span>
              </li>
            ))}
          </ol>
          {synthetic ? (
            <p className="mt-4 text-xs text-muted">
              Real only: {r.funnel.stages.map((s) => `${s.label.toLowerCase()} ${int(s.count)}`).join(" · ")}
            </p>
          ) : null}
          <HowCalculated>
            <Formula>
              {"sent      = Fit Requests created\nopened    = status opened, consented, tried_on, completed or deleted\ncompleted = status completed (hearts sent)\npurchased = completed AND a shortlisted piece was bought as a gift\nstep rate = stage / previous stage"}
            </Formula>
            <p>
              Purchases come from the &quot;Buy as a gift&quot; checkout (POST /api/retailer/purchase): only pieces on that request&apos;s shortlist count, and the event stores no recipient data.
              Requests that expired unopened: {int(c.funnel.closedUnknown)}.
            </p>
            {synthetic ? (
              <p>
                Synthetic requests follow stated demo assumptions: open {pct(SYNTHETIC_ASSUMPTIONS.openRate)}, complete {pct(SYNTHETIC_ASSUMPTIONS.completeGivenOpened)} of opened, heart
                {` ${pct(SYNTHETIC_ASSUMPTIONS.heartBase)}`} per piece ({pct(SYNTHETIC_ASSUMPTIONS.heartIfMetalSuits)} when the metal suits), buy {pct(SYNTHETIC_ASSUMPTIONS.buyIfHearted)} when
                something was hearted. Scores use the published {FIT_WEIGHTS_VERSION} weights. Seeded, so the same every time.
              </p>
            ) : null}
          </HowCalculated>
        </Card>

        <Card id="hearted" eyebrow="Hearts vs purchases" title="Did they buy what was loved?" badge={<DataBadge synthetic={synthetic} />} testId="hearted-card">
          <dl className="space-y-4">
            <div>
              <dt className="text-sm text-ink-soft">Bought pieces that were hearted</dt>
              <dd className="font-display text-4xl text-ink">{ratePct(c.heartedToBought.boughtWereHearted)}</dd>
              <dd className="text-xs text-muted">
                {int(c.heartedToBought.boughtWereHearted.numerator)} of {int(c.heartedToBought.boughtWereHearted.denominator)} gifts
                {synthetic ? ` · real ${int(r.heartedToBought.boughtWereHearted.numerator)}/${int(r.heartedToBought.boughtWereHearted.denominator)}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">Purchase rate after a completed request</dt>
              <dd className="font-display text-4xl text-ink">{stage("purchased").stepRate ? ratePct(stage("purchased").stepRate!) : "–"}</dd>
            </div>
          </dl>
          <HowCalculated>
            <Formula>{"bought were hearted = bought pieces the recipient hearted / bought pieces\npurchase rate       = purchased / completed"}</Formula>
          </HowCalculated>
        </Card>
      </div>

      {/* Undertone Coverage */}
      <Card id="coverage" eyebrow="Undertone Coverage" title="Who can your catalog suit?" className="mt-4" badge={<DataBadge synthetic={false} label="Live catalog" />} testId="coverage-card">
        <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
          <div>
            <ul className="grid grid-cols-3 gap-3">
              {(["warm", "neutral", "cool"] as const).map((t) => (
                <li key={t} className={`rounded-lg px-3 py-3 ${gap?.tone === t ? "bg-blush ring-1 ring-rose/40" : "bg-cream"}`} data-testid={`coverage-${t}`}>
                  <p className="text-xs text-muted">{TONE_WORD[t]}</p>
                  <p className="font-display text-3xl text-ink">{pct(cov.byTone[t].share)}</p>
                  <p className="text-xs text-muted">
                    {int(cov.byTone[t].count)} / {int(cov.total)} SKUs
                  </p>
                </li>
              ))}
            </ul>
            {gap ? (
              <div className="mt-4 rounded-xl border border-rose/30 bg-blush p-4" role="note" data-testid="coverage-gap">
                <p className="text-sm font-medium text-rose">Gap</p>
                <p className="mt-1 font-display text-2xl leading-snug text-ink">
                  Only {pct(gap.share)} of the catalog suits a {gap.tone} undertone. {categoryInfo(gap.category).label}: {pct(gap.categoryShare)} ({gap.categoryCount} of {gap.categoryTotal}).
                </p>
                {gap.toAdd > 0 ? (
                  <p className="mt-2 text-sm text-ink-soft">
                    Add {gap.toAdd} {categoryInfo(gap.category).label.toLowerCase()} in {gap.metals.map((m) => METAL_WORDS[m as Metal]).join(", ")} to reach {pct(gap.targetShare)}{" "}
                    for {gap.tone}-undertone recipients.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <caption className="sr-only">Share of SKUs per category that suit each undertone estimate</caption>
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="py-2 pr-3 font-normal">
                    Category
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-normal">
                    SKUs
                  </th>
                  {(["warm", "neutral", "cool"] as const).map((t) => (
                    <th key={t} scope="col" className="py-2 pr-3 font-normal">
                      {TONE_WORD[t]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {cov.byCategory.map((row) => (
                  <tr key={row.category}>
                    <th scope="row" className="py-2.5 pr-3 text-left font-normal text-ink">
                      {categoryInfo(row.category).label}
                    </th>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-ink-soft">{row.total}</td>
                    {(["warm", "neutral", "cool"] as const).map((t) => (
                      <td key={t} className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <Bar value={row[t].share} fill={TONE_FILL[t]} label={`${categoryInfo(row.category).label}, ${t}: ${pct(row[t].share)}`} />
                          <span
                            className={`w-10 shrink-0 text-right tabular-nums ${gap?.tone === t && gap.category === row.category ? "font-semibold text-rose" : "text-ink"}`}
                          >
                            {pct(row[t].share)}
                          </span>
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <HowCalculated>
          <Formula>
            {
              'suits(sku, tone) = jewelryRules.metalFit(sku.metal, tone).strength == "recommended"\ncoverage(tone)   = |SKUs that suit tone| / |SKUs|\ngap              = lowest-coverage tone, then its lowest category\nto add           = ceil((50% × total − count) / (1 − 50%))'
            }
          </Formula>
          <p>
            Warm: yellow and rose gold. Cool: white gold, silver, platinum. Neutral: every metal (docs/research/jewelry_rules.md, Table 1). No metal is ever &quot;avoid&quot;, so a piece outside a
            tone is still acceptable; recipients&apos; hearts carry half of every Fit Score. Undertone is an estimate the recipient can override.
          </p>
        </HowCalculated>
      </Card>

      {/* Return risk + mix */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <ReturnRiskCard scores={c.boughtScores} synthetic={synthetic} realGifts={r.returnRisk.gifts} />
        <Card id="mix" eyebrow="Recipients, in aggregate" title="Who completed a Fit Request" badge={<DataBadge synthetic={synthetic} />} testId="mix-card">
          <div className="space-y-5">
            <Mix title={`Undertone (estimate or recipient's choice), n = ${int(c.mix.tone.cohort)}`} mix={c.mix.tone} words={(k) => TONE_WORD[k as keyof typeof TONE_WORD] ?? k} />
            <Mix title={`Face shape estimate, n = ${int(c.mix.shape.cohort)}`} mix={c.mix.shape} words={(k) => FACE_SHAPE_WORDS[k as keyof typeof FACE_SHAPE_WORDS] ?? k} />
          </div>
          <HowCalculated>
            <p>
              Completed requests only. A breakdown appears once at least {MIN_COHORT} requests are in it; any group under {MIN_COHORT} shows as &quot;&lt; {MIN_COHORT}&quot;, and if only one group
              is hidden the next smallest is hidden too, so it cannot be worked out by subtraction. No photo, color value or per-person estimate ever reaches this page.
            </p>
          </HowCalculated>
        </Card>
      </div>

      {/* Ingest + script tag */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <IngestBox fixtureMode={ingest.fixture} defaultUrl={ingest.fixture ? "https://aurum-fixture.test/" : "http://localhost:3000/"} />
        <ScriptTagCard storeKey={snap.store.key} demoSlug="halo-drop-earrings" />
      </div>

      <p className="mt-10 border-t border-line pt-6 text-xs leading-5 text-muted">
        Privacy: this console shows aggregates only. It never receives recipient photos, colors, CIELAB values, face measurements or any one person&apos;s estimate. Aurum Jewelry is a fictional
        demo store. Generated {new Date(snap.generatedAt).toUTCString()}.
      </p>
    </div>
  );
}
