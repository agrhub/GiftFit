import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { featuredProducts, getProduct, relatedProducts, toGiftPiece } from "@/components/store/catalog";
import { OCCASION_LABELS, categoryInfo, humanize } from "@/components/store/format";
import { ProductVariantView } from "@/components/store/ProductVariantView";
import { ProductGrid } from "@/components/store/ProductCard";

type Params = Promise<{ id: string }>;

/** The demo-critical photo pieces are prerendered; the rest render on first request. */
export function generateStaticParams() {
  return featuredProducts().map((p) => ({ id: p.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const p = getProduct((await params).id);
  return p ? { title: p.title, description: p.description } : {};
}

export default async function ProductPage({ params }: { params: Params }) {
  const product = getProduct((await params).id);
  if (!product) notFound();
  const category = categoryInfo(product.category);
  const stone = humanize(product.stone);
  const details: Array<[string, string]> = [
    ...(stone ? ([["Stone", stone]] as Array<[string, string]>) : []),
    ["Style", humanize(product.style)],
    ["Good for", product.occasions.map((o) => OCCASION_LABELS[o]).join(", ")],
    ["Reference", product.sku],
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:py-12">
      <nav aria-label="Breadcrumb" className="text-xs text-muted">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href={`/c/${category.slug}`} className="hover:text-ink">
              {category.label}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-ink-soft">
            {product.title}
          </li>
        </ol>
      </nav>

      <ProductVariantView
        product={{ id: product.id, slug: product.slug, title: product.title, currency: product.currency, category: product.category, description: product.description, variants: product.variants }}
        categoryLabel={category.singular}
        giftPiece={toGiftPiece(product)}
        details={details}
        footer={<p className="mt-4 text-xs leading-5 text-muted">Free insured shipping and 30-day returns. Demo store: no real orders are placed.</p>}
      />

      <section aria-labelledby="related" className="mt-24">
        <h2 id="related" className="mb-8 font-display text-3xl text-ink">
          You may also like
        </h2>
        <ProductGrid products={relatedProducts(product, 4)} />
      </section>
    </div>
  );
}
