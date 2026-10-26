/**
 * /w?store=aurum&parent=<store origin>&lang=vi&langs=en,vi&v=1 (owner: A6, ADR-046): the widget frame
 * the script tag opens. `parent` must be an exact http(s) origin on GIFTFIT_WIDGET_ORIGINS (or any
 * origin when that is unset); otherwise the frame renders a short notice and talks to no one.
 * Framing is limited by the frame-ancestors CSP set at request time in middleware.ts.
 */
import { headers } from "next/headers";
import { appBaseUrl } from "@/lib/email/links";
import { parseLangList, translator, detectLocale } from "@/lib/i18n";
import { facebookAppId, isWidgetOriginAllowed } from "@/lib/widget/config";
import { exactOrigin } from "@/lib/widget/protocol";
import { findStore } from "@/lib/metrics/catalog";
import { WidgetApp } from "@/components/widget/WidgetApp";

export const dynamic = "force-dynamic";

type Search = Promise<{ store?: string; parent?: string; lang?: string; langs?: string }>;

async function selfOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  return exactOrigin(`${proto}://${host}`);
}

export default async function WidgetPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const store = findStore(q.store ?? "aurum");
  const allowedLangs = parseLangList(q.langs);
  const preferredLang = typeof q.lang === "string" ? q.lang.slice(0, 12) : undefined;
  const base = appBaseUrl(null);
  const self = await selfOrigin();

  let parentOrigin: string | null = null;
  if (q.parent !== undefined) {
    parentOrigin = exactOrigin(q.parent);
    if (!store || !parentOrigin || !isWidgetOriginAllowed(parentOrigin, self ?? base)) {
      const tr = translator(detectLocale({ preferred: preferredLang, allowed: allowedLangs }));
      return (
        <p role="alert" className="m-2 rounded-xl border border-line bg-white p-3 text-sm text-ink" data-testid="widget-not-allowed">
          {tr("panel.notAllowed")}
        </p>
      );
    }
  }
  return <WidgetApp store={store?.key ?? "aurum"} parentOrigin={parentOrigin} preferredLang={preferredLang} allowedLangs={allowedLangs} baseUrl={process.env.APP_BASE_URL?.trim() ? base : (self ?? base)} facebookAppId={facebookAppId()} />;
}
