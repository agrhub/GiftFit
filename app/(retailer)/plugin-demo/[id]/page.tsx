/**
 * /plugin-demo/<slug> (owner: A6): the script-tag demo on the Aurum store. The same PDP content as
 * /p/<slug>, but with NO built-in GiftFit code: only schema.org Product JSON-LD (what most stores
 * already publish) and one script tag. The "Gift it right" button is injected by giftfit.js.
 * Store chrome (header, footer, bag) is A4's, reused by import.
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AddToBagButton } from "@/components/store/AddToBagButton";
import { CartProvider } from "@/components/store/CartProvider";
import { StoreFooter } from "@/components/store/StoreFooter";
import { StoreHeader } from "@/components/store/StoreHeader";
import { getProduct } from "@/components/store/catalog";
import { METAL_LABELS, formatPrice, humanize } from "@/components/store/format";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const p = getProduct((await params).id);
  return { title: p ? `${p.title} (script tag demo)` : "Script tag demo", robots: { index: false } };
}

export default async function PluginDemoPage({ params }: { params: Params }) {
  const product = getProduct((await params).id);
  if (!product) notFound();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    sku: product.sku,
    name: product.title,
    description: product.description,
    url: `/p/${product.slug}`,
    offers: { "@type": "Offer", price: product.price, priceCurrency: product.currency, availability: "https://schema.org/InStock" },
  };

  return (
    <CartProvider>
      <StoreHeader />
      <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:py-12">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
        <p className="rounded-lg border border-dashed border-gold bg-cream/70 px-4 py-3 text-sm text-ink-soft" data-testid="plugin-demo-banner">
          <strong className="font-medium text-ink">Script tag demo.</strong> This product page has no GiftFit code of its own: just Product JSON-LD and{" "}
          <code className="rounded bg-white px-1.5 py-0.5 text-xs text-ink">&lt;script src=&quot;/giftfit.js&quot; data-store=&quot;aurum&quot; async&gt;</code>. The
          &quot;Gift it right&quot; button below is injected by that one line. <Link href={`/p/${product.slug}`} className="underline underline-offset-4">Built-in version</Link>
        </p>

        <div className="mt-8 grid gap-10 md:grid-cols-[1.1fr_1fr] md:gap-14">
          <div className="relative aspect-square overflow-hidden rounded-sm border border-line bg-white">
            <Image src={product.image} alt={product.title} fill priority sizes="(min-width: 768px) 52vw, 92vw" className="object-contain p-[10%] mix-blend-multiply" />
          </div>
          <div>
            <h1 className="font-display text-4xl leading-tight text-ink sm:text-5xl">{product.title}</h1>
            <p className="mt-3 text-xl text-ink">{formatPrice(product.price, product.currency)}</p>
            <p className="mt-6 max-w-prose leading-7 text-ink-soft">{product.description}</p>
            <div className="mt-8">
              <AddToBagButton line={{ id: product.id, slug: product.slug, title: product.title, price: product.price, currency: product.currency, image: product.image, category: product.category }} />
            </div>
            {/* giftfit.js mounts its button here (optional; without it the button goes after add-to-cart or floats). */}
            <div data-giftfit-mount className="mt-2" />
            <dl className="mt-10 divide-y divide-line border-y border-line text-sm">
              {[
                ["Metal", METAL_LABELS[product.metal]],
                ["Style", humanize(product.style)],
                ["Reference", product.sku],
              ].map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8rem_1fr] gap-4 py-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </main>
      <StoreFooter />
      <script src="/giftfit.js" data-store="aurum" async />
    </CartProvider>
  );
}
