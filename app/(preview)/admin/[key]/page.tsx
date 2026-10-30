/**
 * /admin/<key> : Admin v0 for a store-URL preview (owner: A6, ADR-055). Reached only with the owner
 * cookie (middleware.ts turns ?t=<token> into it and answers 403 otherwise). No accounts, no uploads,
 * no email. Shows the ingested catalog (remove / restore products, re-ingest under the same caps), the
 * widget settings (character, languages, accent colour, greeting) and the snippet for this preview key.
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyText } from "@/components/preview/CopyText";
import { expiresInHours, MerchantImage } from "@/components/preview/PreviewChrome";
import { formatMoney, LOCALES, t, type MessageKey } from "@/lib/i18n";
import { inSnapshotMode } from "@/lib/preview/page-snapshot-http";
import { siteOrigin } from "@/lib/site/snippet";
import { previewStoreView } from "@/lib/widget/preview";
import { OWNER_COOKIE, verifyOwner } from "@/lib/widget/preview-admin";
import { MAX_GREETING, widgetSettingsFrom } from "@/lib/widget/preview-settings";
import { reingestAction, removeProductAction, restoreProductsAction, saveSettingsAction } from "./actions";

export const dynamic = "force-dynamic";
// same-origin (overrides the preview layout's no-referrer): server actions need a real Origin header on POST.
export const metadata: Metadata = { title: "Preview admin", referrer: "same-origin" };

const MESSAGES: Record<string, string> = {
  saved: "Settings saved. The assistant uses them on the next page load.",
  removed: "Product removed from the preview.",
  restored: "Removed products are back.",
  reingest_started: "Re-reading the store. The preview updates in about a minute.",
};
const ERRORS: Record<string, string> = {
  accentColor: "The accent colour must be a hex colour like #1f6f5c.",
  accentContrast: "That accent colour is too light for white text (contrast below 4.5:1). Pick a darker one.",
  greeting: `The greeting must be plain text, at most ${MAX_GREETING} characters, without links.`,
  languages: "Pick at least one language.",
  defaultLanguage: "The default language must be one of the allowed languages.",
  character: "Pick Mark-kun or the gift-box mascot.",
  rate_limited: "You've made the 5 previews (or re-reads) allowed per day from this network. Try again tomorrow.",
  daily_cap: "GiftFit has reached today's preview limit. Try again tomorrow.",
  unavailable: "The preview service is unavailable right now. Try again later.",
  busy: "The store is already being read. Wait a moment.",
  unknown_product: "That product isn't in this preview.",
};

export default async function PreviewAdminPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { key } = await params;
  const rec = await verifyOwner(key, (await cookies()).get(OWNER_COOKIE)?.value);
  if (!rec) notFound(); // middleware already answered 403; this is defence in depth
  const q = await searchParams;
  const origin = await siteOrigin();
  const settings = widgetSettingsFrom(rec.settings);
  const removed = new Set(rec.settings.removedProductIds ?? []);
  const view = rec.state === "ready" ? previewStoreView(rec) : null;
  const giftable = new Set(Object.keys(view?.skuIdByProduct ?? {}));
  const snippet = `<script src="${origin}/giftfit.js" data-store="preview:${key}" async></script>`;
  const errors = (q.err ?? "").split(",").filter(Boolean);
  const label = "text-sm font-medium text-ink";
  const btn = "min-h-11 rounded-full px-5 text-sm font-medium";

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6" data-testid="preview-admin">
      <p className="text-xs font-semibold tracking-[0.24em] text-gold-deep uppercase">GiftFit Admin v0 · preview</p>
      <h1 className="mt-2 font-display text-4xl text-ink">{rec.storeName ?? rec.domain}</h1>
      <p className="mt-1 text-sm text-ink-soft">
        {rec.domain} · state <span data-testid="admin-state">{rec.state}</span> · deleted in about {expiresInHours(rec.expiresAt)} h ·{" "}
        <Link href={`/s/${key}`} className="underline underline-offset-4">
          Open the preview store
        </Link>
      </p>
      <p className="mt-2 text-xs text-muted">This page opens only in the browser that used your owner link. Keep that link private; it is not shown again.</p>
      {rec.state === "ready" ? (
        <p className="mt-4 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink" data-testid="admin-look">
          Look:{" "}
          {inSnapshotMode(rec) ? (
            <>
              <span data-testid="admin-look-mode">snapshot</span> — an inert, sanitized copy of your home page
              {rec.snapshot?.productPages.length ? ` and ${rec.snapshot.productPages.length} product page${rec.snapshot.productPages.length === 1 ? "" : "s"}` : ""} (no scripts, forms or
              tracking; images, styles and fonts load from {rec.domain}).{" "}
              <Link href={`/s/${key}?view=template`} className="underline underline-offset-4">
                Open the template view
              </Link>
            </>
          ) : (
            <>
              <span data-testid="admin-look-mode">template</span> — GiftFit&apos;s neutral template
              {rec.snapshot?.reason ? (
                <>
                  , because <span data-testid="admin-look-reason">{t("en", `pstore.look.reason.${rec.snapshot.reason}` as MessageKey)}</span>
                </>
              ) : (
                "."
              )}
            </>
          )}
        </p>
      ) : null}

      {q.msg && MESSAGES[q.msg] ? (
        <p role="status" className="mt-6 rounded-xl border border-sage/40 bg-white px-4 py-3 text-sm text-ink" data-testid="admin-message">
          {MESSAGES[q.msg]}
        </p>
      ) : null}
      {errors.length ? (
        <ul role="alert" className="mt-6 rounded-xl border border-rose/40 bg-white px-4 py-3 text-sm text-rose" data-testid="admin-error">
          {errors.map((e) => (
            <li key={e}>{ERRORS[e] ?? "That didn't work. Please try again."}</li>
          ))}
        </ul>
      ) : null}

      <section className="mt-10" aria-labelledby="snippet">
        <h2 id="snippet" className="font-display text-2xl text-ink">
          Snippet for this preview
        </h2>
        <p className="mt-1 mb-3 text-sm text-ink-soft">Works on any https page for 24 hours (the preview&apos;s lifetime).</p>
        <CopyText text={snippet} testId="admin-snippet" />
      </section>

      <section className="mt-10" aria-labelledby="settings">
        <h2 id="settings" className="font-display text-2xl text-ink">
          Assistant settings
        </h2>
        <form action={saveSettingsAction} className="mt-4 grid gap-5 rounded-2xl border border-line bg-white p-5" data-testid="admin-settings">
          <input type="hidden" name="key" value={key} />
          <fieldset>
            <legend className={label}>Character</legend>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="radio" name="character" value="mark-kun" defaultChecked={settings.character === "mark-kun"} /> Mark-kun (Live2D, the one fixed model; gift-box mascot on devices without WebGL)
            </label>
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input type="radio" name="character" value="mascot" defaultChecked={settings.character === "mascot"} data-testid="admin-character-mascot" /> Gift-box mascot (SVG)
            </label>
          </fieldset>
          <fieldset>
            <legend className={label}>Languages</legend>
            {LOCALES.map((l) => (
              <label key={l} className="mt-2 mr-4 inline-flex items-center gap-2 text-sm">
                <input type="checkbox" name="languages" value={l} defaultChecked={settings.languages.includes(l)} data-testid={`admin-lang-${l}`} /> {t("en", `lang.${l}` as MessageKey)}
                {l !== "en" && l !== "vi" ? <span className="text-xs text-muted">(machine-translated)</span> : null}
              </label>
            ))}
            <label className="mt-3 block text-sm">
              Default language{" "}
              <select name="defaultLanguage" defaultValue={settings.defaultLanguage} className="ml-2 rounded-lg border border-line-strong px-2 py-1" data-testid="admin-default-lang">
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {t("en", `lang.${l}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <label className={label}>
            Accent colour (hex, dark enough for white text)
            <input name="accentColor" defaultValue={settings.accentColor ?? ""} placeholder="#1f6f5c" pattern="#[0-9a-fA-F]{6}" className="mt-1 block w-40 rounded-lg border border-line-strong px-3 py-2 font-mono text-sm" data-testid="admin-accent" />
          </label>
          <label className={label}>
            Greeting (plain text, up to {MAX_GREETING} characters)
            <input name="greeting" defaultValue={settings.greeting ?? ""} maxLength={MAX_GREETING} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" data-testid="admin-greeting" />
          </label>
          <button type="submit" className={`${btn} justify-self-start gf-cta bg-ink text-ivory`} data-testid="admin-save">
            Save settings
          </button>
        </form>
      </section>

      <section className="mt-10" aria-labelledby="catalog">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="catalog" className="font-display text-2xl text-ink">
            Catalog ({rec.products.length - [...removed].filter((id) => rec.products.some((p) => p.id === id)).length} shown, {removed.size} removed)
          </h2>
          <div className="flex gap-2">
            {removed.size ? (
              <form action={restoreProductsAction}>
                <input type="hidden" name="key" value={key} />
                <button type="submit" className={`${btn} border border-line-strong text-ink`}>
                  Restore removed
                </button>
              </form>
            ) : null}
            <form action={reingestAction}>
              <input type="hidden" name="key" value={key} />
              <button type="submit" className={`${btn} border border-ink text-ink`} data-testid="admin-reingest" disabled={rec.state === "queued" || rec.state === "crawling"}>
                Re-read the store
              </button>
            </form>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">Only public product data is read (same limits as a new preview: 5 per network per day). Pieces marked “giftable” are jewelry with a stated metal: the gift flow works for them (hearts only, no try-on in previews).</p>
        <ul className="mt-4 grid gap-2" data-testid="admin-products">
          {rec.products.map((p) => {
            const isRemoved = removed.has(p.id);
            return (
              <li key={p.id} className={`flex items-center gap-3 rounded-xl border border-line bg-white p-2 ${isRemoved ? "opacity-50" : ""}`} data-testid="admin-product" data-removed={isRemoved ? "true" : "false"}>
                <MerchantImage src={p.images[0]} alt="" className="h-14 w-14 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{p.title}</p>
                  <p className="text-xs text-muted">
                    {p.price !== null && p.currency ? formatMoney("en", p.price, p.currency) : "no price"} · {p.categoryText ?? "uncategorised"}
                    {giftable.has(p.id) ? " · giftable" : ""}
                    {isRemoved ? " · removed" : ""}
                  </p>
                </div>
                {!isRemoved ? (
                  <form action={removeProductAction}>
                    <input type="hidden" name="key" value={key} />
                    <input type="hidden" name="productId" value={p.id} />
                    <button type="submit" className={`${btn} border border-line-strong text-ink-soft`} data-testid="admin-remove">
                      Remove
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
