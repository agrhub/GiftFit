import Image from "next/image";
import Link from "next/link";
import { type Product, priceFrom } from "./catalog";
import { METAL_LABELS, formatPrice, productPath } from "./format";

export function ProductImage({ product, sizes, priority = false, className = "" }: { product: Pick<Product, "image" | "title">; sizes: string; priority?: boolean; className?: string }) {
  return (
    <div className={`relative aspect-square overflow-hidden bg-white ${className}`}>
      <Image src={product.image} alt={product.title} fill sizes={sizes} priority={priority} className="object-contain p-[8%] mix-blend-multiply transition-transform duration-700 ease-[var(--ease-soft)] group-hover:scale-[1.04]" />
    </div>
  );
}

export function ProductCard({ product, priority = false }: { product: Product; priority?: boolean }) {
  return (
    <article className="group relative">
      <ProductImage product={product} priority={priority} sizes="(min-width: 1024px) 23vw, (min-width: 640px) 31vw, 48vw" className="rounded-sm border border-line" />
      <div className="mt-3 space-y-1">
        <h3 className="font-display text-lg leading-snug text-ink">
          <Link href={productPath(product)} className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-4 focus-visible:after:outline-ink">
            {product.title}
          </Link>
        </h3>
        <p className="flex items-center justify-between gap-2 text-sm text-muted">
          <span>{product.variants.length > 1 ? `${product.variants.length} metals` : METAL_LABELS[product.variants[0]?.metal ?? product.metal]}</span>
          <span className="text-ink">
            {product.variants.length > 1 ? "From " : ""}
            {formatPrice(priceFrom(product), product.currency)}
          </span>
        </p>
      </div>
    </article>
  );
}

export function ProductGrid({ products, priorityCount = 0 }: { products: readonly Product[]; priorityCount?: number }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 lg:grid-cols-4 lg:gap-x-6">
      {products.map((p, i) => (
        <li key={p.id}>
          <ProductCard product={p} priority={i < priorityCount} />
        </li>
      ))}
    </ul>
  );
}
