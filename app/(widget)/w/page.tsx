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
import { loadPreviewStore, previewKeyOf } from "@/lib/widget/preview";
import { WidgetApp, type WidgetPreview } from "@/components/widget/WidgetApp";
import { tryOnOfferedTo } from "@/lib/privacy/tryon-mode";

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
  // ADR-055: data-store="preview:<key>" = a READY store-URL preview; its owner's settings win over data-lang(s).
  const previewKey = previewKeyOf(q.store);
  const previewView = previewKey ? await loadPreviewStore(previewKey).catch(() => null) : null;
  const store = previewKey ? null : findStore(q.store ?? "aurum");
  const allowedLangs = previewView ? previewView.settings.languages : parseLangList(q.langs);
  const preferredLang = previewView ? previewView.settings.defaultLanguage : typeof q.lang === "string" ? q.lang.slice(0, 12) : undefined;
  const preview: WidgetPreview | undefined = previewView
    ? {
        key: previewView.key,
        domain: previewView.domain,
        storeName: previewView.storeName,
        giftable: previewView.skus.length > 0,
        products: previewView.products.map((p) => ({
          id: p.id,
          title: p.title,
          url: p.url,
          price: p.price,
          currency: p.currency,
          ...(p.images[0] ? { image: p.images[0] } : {}),
          ...(previewView.skuIdByProduct[p.id] ? { skuId: previewView.skuIdByProduct[p.id] } : {}),
        })),
        settings: { character: previewView.settings.character, ...(previewView.settings.accentColor ? { accentColor: previewView.settings.accentColor } : {}), ...(previewView.settings.greeting ? { greeting: previewView.settings.greeting } : {}) },
      }
    : undefined;
  const base = appBaseUrl(null);
  const self = await selfOrigin();

  let parentOrigin: string | null = null;
  if (q.parent !== undefined) {
    parentOrigin = exactOrigin(q.parent);
    if ((!store && !preview) || !parentOrigin || !isWidgetOriginAllowed(parentOrigin, self ?? base, process.env, { previewReady: Boolean(preview) })) {
      const tr = translator(detectLocale({ preferred: preferredLang, allowed: allowedLangs }));
      return (
        <p role="alert" className="m-2 rounded-xl border border-line bg-white p-3 text-sm text-ink" data-testid="widget-not-allowed">
          {tr("panel.notAllowed")}
        </p>
      );
    }
  }
  if (previewKey && !preview) {
    const tr = translator(detectLocale({ preferred: preferredLang, allowed: allowedLangs }));
    return (
      <p role="alert" className="m-2 rounded-xl border border-line bg-white p-3 text-sm text-ink" data-testid="widget-not-allowed">
        {tr("panel.notAllowed")}
      </p>
    );
  }
  // A16: will a gift made in this frame offer its recipient a try-on? Public production: no (0 YouCam units).
  const tryOn = tryOnOfferedTo({ headers: await headers() }) && (!previewView || previewView.skus.some((s) => s.attributes.tryon_eligible === true));
  return <WidgetApp store={preview ? `preview:${preview.key}` : (store?.key ?? "aurum")} preview={preview} tryOn={tryOn} parentOrigin={parentOrigin} preferredLang={preferredLang} allowedLangs={allowedLangs} baseUrl={process.env.APP_BASE_URL?.trim() ? base : (self ?? base)} facebookAppId={facebookAppId()} />;
}
