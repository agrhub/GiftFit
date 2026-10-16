"use client";
/** Mock bag (owner: A4): lines, quantities, demo checkout, Gift it right, and the giver's Fit Requests. */
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { JewelryCategory } from "@/lib/contracts/giftfit";
import { GiftItRightButton } from "@/components/gift/GiftItRightButton";
import { MAX_SHORTLIST } from "@/components/gift/giverDraft";
import { loadSavedRequests, type SavedFitRequest } from "@/components/gift/savedRequests";
import { recordGiftPurchases } from "@/lib/metrics/purchase-beacon";
import { lineKey, useCart } from "./CartProvider";
import { METAL_LABELS, OCCASION_LABELS, formatExpiry, formatPrice } from "./format";
import type { Metal, Occasion } from "@/lib/contracts/giftfit";

export function CartView({ addId, addMetal }: { addId?: string; addMetal?: string }) {
  const { lines, subtotal, ready, setQty, remove, add, clear } = useCart();
  const [ordered, setOrdered] = useState(false);
  const [requests, setRequests] = useState<SavedFitRequest[]>([]);
  const handledAdd = useRef(false);
  const statusRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => setRequests(loadSavedRequests()), []);

  // /cart?add=<id|slug> from the Fit Report's buy button.
  useEffect(() => {
    if (!ready || !addId || handledAdd.current) return;
    handledAdd.current = true;
    import("./catalog").then(({ getProduct, variantFor }) => {
      const p = getProduct(addId);
      if (p) {
        // The Fit Report's buy button names the exact variant (?metal=), ADR-032.
        const v = variantFor(p, addMetal);
        if (!lines.some((l) => lineKey(l) === v.variantId)) add({ id: p.id, variantId: v.variantId, metal: v.metal, slug: p.slug, title: p.title, price: v.price, currency: p.currency, image: v.image, category: p.category });
      }
      window.history.replaceState(null, "", "/cart");
    });
  }, [ready, addId, addMetal, add, lines]);

  useEffect(() => {
    if (ordered) statusRef.current?.focus();
  }, [ordered]);

  if (ordered) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center sm:px-6">
        <h1 ref={statusRef} tabIndex={-1} className="font-display text-5xl text-ink focus:outline-none" data-testid="order-confirmed">
          Thank you
        </h1>
        <p className="mt-4 text-ink-soft">This is a demo store, so no order was placed and no payment was taken.</p>
        <Link href="/" className="mt-8 inline-flex min-h-12 items-center rounded-full bg-ink px-7 text-sm font-medium text-ivory">
          Continue shopping
        </Link>
      </div>
    );
  }

  // One shortlist entry per design (two metals of one design are one design to gift).
  const giftPieces = lines
    .filter((l, i) => lines.findIndex((x) => x.id === l.id) === i)
    .slice(0, MAX_SHORTLIST)
    .map((l) => ({ id: l.id, slug: l.slug, title: l.title, price: l.price, currency: l.currency, image: l.image, category: l.category as JewelryCategory, metal: l.metal as Metal | undefined }));
  const currency = lines[0]?.currency ?? "USD";

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-5xl text-ink">Your bag</h1>
      {!ready ? (
        <div className="gf-shimmer mt-10 h-32 rounded" aria-hidden="true" />
      ) : lines.length === 0 ? (
        <div className="mt-10 rounded-xl border border-line bg-white p-10 text-center">
          <p className="text-ink-soft">Your bag is empty.</p>
          <Link href="/c/earrings" className="mt-6 inline-flex min-h-12 items-center rounded-full bg-ink px-7 text-sm font-medium text-ivory">
            Shop earrings
          </Link>
        </div>
      ) : (
        <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_22rem]">
          <ul className="divide-y divide-line border-y border-line" data-testid="bag-lines">
            {lines.map((l) => (
              <li key={lineKey(l)} className="flex gap-4 py-5">
                <Link href={`/p/${l.slug}`} className="shrink-0">
                  <Image src={l.image} alt={l.title} width={96} height={96} className="h-24 w-24 rounded-sm border border-line bg-white object-contain p-1" />
                </Link>
                <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
                  <div className="flex justify-between gap-4">
                    <div>
                      <Link href={`/p/${l.slug}${l.metal ? `?metal=${l.metal}` : ""}`} className="font-display text-xl leading-tight text-ink hover:underline">
                        {l.title}
                      </Link>
                      {l.metal ? (
                        <p className="text-sm text-ink-soft" data-testid="bag-line-metal">
                          {METAL_LABELS[l.metal as Metal] ?? l.metal} · {formatPrice(l.price, l.currency)}
                        </p>
                      ) : null}
                    </div>
                    <p className="text-ink">{formatPrice(l.price * l.qty, l.currency)}</p>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <label className="flex items-center gap-2 text-ink-soft">
                      Qty
                      <select value={l.qty} onChange={(e) => setQty(lineKey(l), Number(e.target.value))} className="min-h-11 rounded-lg border border-line-strong bg-white px-2 text-ink">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" onClick={() => remove(lineKey(l))} className="min-h-11 text-ink-soft underline underline-offset-4 hover:text-ink" aria-label={`Remove ${l.title} from bag`}>
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <aside className="space-y-4">
            <div className="rounded-xl border border-line bg-white p-6">
              <dl className="flex justify-between text-ink">
                <dt>Subtotal</dt>
                <dd>{formatPrice(subtotal, currency)}</dd>
              </dl>
              <p className="mt-1 text-xs text-muted">Shipping is free. Taxes are not charged in this demo.</p>
              <button
                type="button"
                onClick={() => {
                  recordGiftPurchases(lines.map((l) => l.id)); // A6: gift purchase event; the server keeps shortlisted ids only
                  clear();
                  setOrdered(true);
                }}
                className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-ink text-sm font-medium text-ivory hover:bg-ink-soft"
              >
                Checkout (demo)
              </button>
            </div>
            <div className="rounded-xl border border-line bg-cream/70 p-6">
              <h2 className="font-display text-2xl text-ink">Not sure it&apos;s right?</h2>
              <p className="mt-2 text-sm leading-6 text-ink-soft">
                Send {lines.length > 1 ? `these ${Math.min(lines.length, MAX_SHORTLIST)} pieces` : "this piece"} as a private try-on. You&apos;ll get fit scores, never photos.
              </p>
              <GiftItRightButton pieces={giftPieces} className="mt-4 w-full" />
            </div>
          </aside>
        </div>
      )}

      {requests.length > 0 ? (
        <section aria-labelledby="my-requests" className="mt-16">
          <h2 id="my-requests" className="font-display text-3xl text-ink">
            Your Fit Requests
          </h2>
          <ul className="mt-6 grid gap-3 md:grid-cols-2">
            {requests.map((r) => (
              <li key={r.giverReportPath} className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white p-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">{OCCASION_LABELS[r.occasion as Occasion] ?? r.occasion}</p>
                  <p className="truncate text-sm text-ink">{r.titles.join(" · ")}</p>
                  <p className="text-xs text-muted">Link works until {formatExpiry(r.expiresAt)}</p>
                </div>
                <Link href={r.giverReportPath} className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-ink px-4 text-sm text-ink hover:bg-ink hover:text-ivory">
                  Fit Report
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
