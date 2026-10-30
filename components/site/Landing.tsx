/**
 * GiftFit landing at / (owner: A4, P8.4, ADR-055). Dark, scoped to this page (LandingRoot, `.gf-dark`).
 * Server component; the client islands are the code window (Copy / Run), the Quick start tabs and the
 * store-URL preview form, each given only its own strings. The widget is not loaded until Run.
 */
import Link from "next/link";
import { Live2DCredits } from "@/components/widget/character/Live2DCredits";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { CodeWindow } from "./CodeWindow";
import { IconChoose, IconPrivate, IconReport, IconVoice } from "./FeatureIcons";
import { CODE_KEYS, DOCS_KEYS, PREVIEW_KEYS, pick } from "./labels";
import { LandingRoot } from "./LandingRoot";
import { PreviewForm } from "./PreviewForm";
import { QuickStart } from "./QuickStart";

export interface LandingProps {
  locale: Locale;
  demoStoreUrl: string;
  /** Origin that serves /giftfit.js (APP_BASE_URL or this request's origin). */
  origin: string;
  /** `?previewmock=1`: the preview form uses its in-memory mock. */
  previewMock?: boolean;
}

export const btnPrimary =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-linear-to-r from-glow-gold via-glow-rose to-glow-violet px-7 text-sm font-semibold text-night-950 shadow-[0_10px_40px_-12px_rgb(242_154_182/0.6)] transition-transform hover:-translate-y-0.5";
export const btnSecondary =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-night-600 bg-night-900/60 px-7 text-sm font-medium text-fog-100 transition-colors hover:border-fog-300 hover:bg-night-800";

const FEATURES: Array<{ title: MessageKey; text: MessageKey; Icon: () => React.JSX.Element; tint: string }> = [
  { title: "landing.f1Title", text: "landing.f1Text", Icon: IconChoose, tint: "text-glow-gold" },
  { title: "landing.f2Title", text: "landing.f2Text", Icon: IconPrivate, tint: "text-glow-rose" },
  { title: "landing.f3Title", text: "landing.f3Text", Icon: IconReport, tint: "text-glow-violet" },
  { title: "landing.f4Title", text: "landing.f4Text", Icon: IconVoice, tint: "text-glow-mint" },
];

export function SectionHeading({ id, eyebrow, title, text }: { id: string; eyebrow?: string; title: string; text?: string }) {
  return (
    <div className="max-w-2xl">
      {eyebrow && <p className="text-xs font-semibold tracking-[0.2em] text-glow-gold uppercase">{eyebrow}</p>}
      <h2 id={id} className="mt-2 text-3xl font-semibold tracking-tight text-fog-100 sm:text-4xl">
        {title}
      </h2>
      {text && <p className="mt-4 text-base leading-7 text-fog-300">{text}</p>}
    </div>
  );
}

export function Credits({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section className="gf-credits space-y-3 text-xs leading-5 text-fog-400" aria-labelledby="credits" data-testid="site-credits">
      <h2 id="credits" className="text-sm font-semibold text-fog-300">
        {tr("site.creditsTitle")}
      </h2>
      <p data-testid="ai-note">{tr("site.aiNote")}</p>
      <p>{tr("site.privacyLink")}</p>
      <p>{tr("site.creditsYoucam")}</p>
      <p>{tr("site.creditsGoogle")}</p>
      <p>{tr("about.voiceTerms")}</p>
      <Live2DCredits title={tr("about.credits")} />
    </section>
  );
}

export function Landing({ locale, demoStoreUrl, origin, previewMock = false }: LandingProps) {
  const tr = translator(locale);
  const wrap = "mx-auto max-w-6xl px-4 sm:px-6";
  return (
    <LandingRoot lang={locale}>
      {/* Hero + live code window */}
      <div className="relative isolate overflow-x-clip">
        <div aria-hidden="true" className="gf-aura -z-10" />
        <div className={`${wrap} pt-4`}>
          <div className="grid items-center gap-12 pt-10 pb-20 sm:pt-16 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pb-28">
            <div className="min-w-0">
              <p className="gf-rise text-xs font-semibold tracking-[0.24em] text-fog-300 uppercase">
                GiftFit <span className="text-glow-gold">·</span> {tr("landing.eyebrow")}
              </p>
              <h1 className="gf-rise mt-5 text-[2.6rem] leading-[1.05] font-bold tracking-tight text-balance sm:text-6xl lg:text-7xl" style={{ ["--gf-delay" as string]: "80ms" }}>
                <span className="gf-gradient-text">{tr("site.tagline")}</span>
              </h1>
              <p className="gf-rise mt-6 max-w-xl text-lg leading-8 text-fog-300" style={{ ["--gf-delay" as string]: "160ms" }}>
                {tr("landing.lead")}
              </p>
              <div className="gf-rise mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap" style={{ ["--gf-delay" as string]: "240ms" }}>
                <a href={demoStoreUrl} className={btnPrimary} data-testid="cta-demo-store">
                  {tr("site.openStore")}
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8h10M9 4l4 4-4 4" />
                  </svg>
                </a>
                <a href="#try" className={btnSecondary} data-testid="cta-try">
                  {tr("landing.ctaTry")}
                </a>
              </div>
              <p className="gf-rise mt-6 text-sm text-fog-400" style={{ ["--gf-delay" as string]: "320ms" }}>
                <Link href={"/merchants"} className="inline-flex min-h-11 items-center underline decoration-night-600 underline-offset-4 hover:text-fog-100 hover:decoration-glow-gold" data-testid="cta-merchants">
                  {tr("site.forMerchants")}
                </Link>
              </p>
            </div>

            <section className="gf-rise min-w-0" aria-labelledby="live-code" style={{ ["--gf-delay" as string]: "200ms" }}>
              <h2 id="live-code" className="text-lg font-semibold text-fog-100">
                {tr("landing.codeTitle")}
              </h2>
              <p className="mt-2 mb-5 text-sm leading-6 text-fog-300">{tr("landing.codeText")}</p>
              <CodeWindow origin={origin} labels={pick(tr, CODE_KEYS)} />
            </section>
          </div>
        </div>
      </div>

      {/* Features */}
      <section className={`${wrap} py-16 sm:py-20`} aria-labelledby="features">
        <SectionHeading id="features" title={tr("landing.featuresTitle")} />
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="features">
          {FEATURES.map(({ title, text, Icon, tint }) => (
            <li key={title} className="group rounded-3xl border border-night-700 bg-night-900 p-6 transition-colors hover:border-night-600 hover:bg-night-800">
              <span className={`inline-flex size-11 items-center justify-center rounded-2xl border border-night-700 bg-night-950 ${tint}`}>
                <Icon />
              </span>
              <h3 className="mt-5 text-base font-semibold text-fog-100">{tr(title)}</h3>
              <p className="mt-2 text-sm leading-6 text-fog-300">{tr(text)}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* How it works */}
      <section className={`${wrap} py-16 sm:py-20`} aria-labelledby="how">
        <SectionHeading id="how" title={tr("site.howTitle")} />
        <ol className="mt-10 grid gap-6 sm:grid-cols-3" data-testid="how-steps">
          {(["site.step1", "site.step2", "site.step3"] as const).map((k, i) => (
            <li key={k} className="border-t border-night-700 pt-5">
              <span className="gf-gradient-text text-3xl font-bold">{String(i + 1).padStart(2, "0")}</span>
              <p className="mt-3 text-sm leading-6 text-fog-300">{tr(k)}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Quick start */}
      <section id="docs" className={`${wrap} scroll-mt-20 py-16 sm:py-20`} aria-labelledby="docs-title">
        <SectionHeading id="docs-title" title={tr("landing.docsTitle")} text={tr("landing.docsText")} />
        <div className="mt-10 max-w-4xl">
          <QuickStart origin={origin} labels={pick(tr, DOCS_KEYS)} />
        </div>
      </section>

      {/* Store-URL preview */}
      <section id="try" className={`${wrap} scroll-mt-20 py-16 sm:py-20`} aria-labelledby="try-title">
        <div className="relative overflow-hidden rounded-[2rem] border border-night-700 bg-night-900 p-6 sm:p-10">
          <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-glow-violet/10 blur-3xl" />
          <SectionHeading id="try-title" title={tr("landing.tryTitle")} text={tr("landing.tryText")} />
          <div className="relative mt-8 max-w-2xl">
            <PreviewForm labels={pick(tr, PREVIEW_KEYS)} mock={previewMock} />
            <p className="mt-6 text-xs leading-5 text-fog-400">{tr("landing.tryNote")}</p>
          </div>
        </div>
      </section>

      {/* Judges */}
      <section className={`${wrap} pb-16`} aria-labelledby="judges">
        <div className="flex flex-col gap-4 rounded-3xl border border-night-700 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="judges" className="text-lg font-semibold text-fog-100">
              {tr("site.judgeTitle")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-fog-300">{tr("site.judgeText")}</p>
          </div>
          <Link href="/demo" className={`${btnSecondary} shrink-0`} data-testid="link-judge-demo">
            {tr("site.judgeLink")}
          </Link>
        </div>
      </section>

      <footer className="border-t border-night-700">
        <div className={`${wrap} py-12`}>
          <nav aria-label="GiftFit" className="mb-8 flex flex-wrap gap-x-6 text-sm text-fog-300">
            <a href={demoStoreUrl} className="inline-flex min-h-11 items-center hover:text-fog-100">
              {tr("site.openStore")}
            </a>
            <Link href={"/merchants"} className="inline-flex min-h-11 items-center hover:text-fog-100">
              {tr("site.forMerchants")}
            </Link>
            <a href="#docs" className="inline-flex min-h-11 items-center hover:text-fog-100">
              {tr("landing.docsTitle")}
            </a>
          </nav>
          <Credits locale={locale} />
        </div>
      </footer>
    </LandingRoot>
  );
}
