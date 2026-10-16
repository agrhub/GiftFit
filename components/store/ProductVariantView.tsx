"use client";
/**
 * PDP body with a metal selector (owner: A4, ADR-032): shoppers pick the design, then the metal;
 * the image, price, material and bag line follow the metal. `?metal=` preselects a variant
 * (bag links, the Fit Report's buy button) and is kept in the URL when the metal changes.
 */
import Image from "next/image";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { Metal } from "@/lib/contracts/giftfit";
import type { GiftPiece } from "@/components/gift/giverDraft";
import { GiftItRightButton } from "@/components/gift/GiftItRightButton";
import type { Product, ProductVariant } from "./catalog";
import { AddToBagButton } from "./AddToBagButton";
import { METAL_LABELS, METAL_SWATCH, formatPrice, humanize } from "./format";

export interface ProductVariantViewProps {
  product: Pick<Product, "id" | "slug" | "title" | "currency" | "category" | "description" | "variants">;
  categoryLabel: string;
  giftPiece: GiftPiece;
  /** Variant-independent details (stone, style, occasions, reference). */
  details: Array<[string, string]>;
  /** Rendered below the details (server content). */
  footer?: ReactNode;
}

export function ProductVariantView({ product, categoryLabel, giftPiece, details, footer }: ProductVariantViewProps) {
  const [metal, setMetal] = useState<Metal>(product.variants[0].metal);
  const groupId = useId();
  const variant: ProductVariant = product.variants.find((v) => v.metal === metal) ?? product.variants[0];
  const multi = product.variants.length > 1;

  // ?metal= from the bag or the Fit Report.
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("metal");
    if (m && product.variants.some((v) => v.metal === m)) setMetal(m as Metal);
  }, [product.variants]);

  function choose(m: Metal) {
    setMetal(m);
    const url = new URL(window.location.href);
    url.searchParams.set("metal", m);
    window.history.replaceState(null, "", url);
  }

  const allDetails: Array<[string, string]> = [["Metal", METAL_LABELS[variant.metal]], ["Material", humanize(variant.material)], ...details];

  return (
    <div className="mt-6 grid gap-10 md:grid-cols-[1.1fr_1fr] md:gap-14">
      <div className="md:sticky md:top-28 md:self-start">
        <div className="relative aspect-square overflow-hidden rounded-sm border border-line bg-white">
          <Image
            key={variant.image}
            src={variant.image}
            alt={`${product.title} in ${METAL_LABELS[variant.metal].toLowerCase()}`}
            fill
            priority
            unoptimized
            fetchPriority="high"
            sizes="(min-width: 768px) 52vw, 92vw"
            className="gf-fade-in object-contain p-[10%] mix-blend-multiply"
          />
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-gold-deep">{categoryLabel}</p>
        <h1 className="mt-3 font-display text-4xl leading-tight text-ink sm:text-5xl">{product.title}</h1>
        <p className="mt-3 text-xl text-ink" data-testid="pdp-price">
          {formatPrice(variant.price, product.currency)}
        </p>

        {multi ? (
          <fieldset className="mt-6">
            <legend id={groupId} className="text-sm text-ink-soft">
              Metal: <span className="font-medium text-ink">{METAL_LABELS[variant.metal]}</span>
            </legend>
            <div className="mt-2 flex flex-wrap gap-2" data-testid="pdp-metals">
              {product.variants.map((v) => {
                const checked = v.metal === variant.metal;
                return (
                  <label
                    key={v.variantId}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-4 text-sm transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink ${
                      checked ? "border-ink bg-white text-ink" : "border-line-strong text-ink-soft hover:border-ink"
                    }`}
                  >
                    <input type="radio" name={`${groupId}-metal`} value={v.metal} checked={checked} onChange={() => choose(v.metal)} className="sr-only" data-testid={`pdp-metal-${v.metal}`} />
                    <span aria-hidden="true" className="h-7 w-7 rounded-full border border-line-strong" style={{ background: METAL_SWATCH[v.metal] }} />
                    <span>{METAL_LABELS[v.metal]}</span>
                    <span className="text-muted">{formatPrice(v.price, product.currency)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        <p className="mt-6 max-w-prose leading-7 text-ink-soft">{product.description}</p>

        <div className="mt-8 space-y-3">
          <AddToBagButton
            line={{ id: product.id, variantId: variant.variantId, metal: variant.metal, slug: product.slug, title: product.title, price: variant.price, currency: product.currency, image: variant.image, category: product.category }}
          />
        </div>

        <aside aria-labelledby="gift-box-title" className="mt-4 rounded-xl border border-line bg-cream/70 p-5">
          <h2 id="gift-box-title" className="font-display text-2xl text-ink">
            Buying it for someone?
          </h2>
          <p className="mt-2 text-sm leading-6 text-ink-soft">
            Let them try it on privately{multi ? ", in every metal within your budget" : ""}, mixed with similar pieces so the surprise holds. You get fit scores, never their photos.
          </p>
          <GiftItRightButton pieces={[giftPiece]} className="mt-4 w-full" />
        </aside>

        <dl className="mt-10 divide-y divide-line border-y border-line text-sm">
          {allDetails.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[8rem_1fr] gap-4 py-3">
              <dt className="text-muted">{k}</dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        {footer}
      </div>
    </div>
  );
}
