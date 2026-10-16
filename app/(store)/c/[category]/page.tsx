import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { productsInCategory } from "@/components/store/catalog";
import { CATEGORIES, METAL_LABELS, categoryBySlug } from "@/components/store/format";
import { ProductGrid } from "@/components/store/ProductCard";
import type { Metal } from "@/lib/contracts/giftfit";

type Params = Promise<{ category: string }>;
type Search = Promise<{ metal?: string; sort?: string }>;

const SORTS = [
  { value: "featured", label: "Featured" },
  { value: "price-asc", label: "Price, low to high" },
  { value: "price-desc", label: "Price, high to low" },
] as const;

export function generateStaticParams() {
  return CATEGORIES.map((c) => ({ category: c.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const c = categoryBySlug((await params).category);
  return c ? { title: c.label, description: c.blurb } : {};
}

function href(slug: string, q: { metal?: string; sort?: string }) {
  const sp = new URLSearchParams();
  if (q.metal) sp.set("metal", q.metal);
  if (q.sort && q.sort !== "featured") sp.set("sort", q.sort);
  const s = sp.toString();
  return `/c/${slug}${s ? `?${s}` : ""}`;
}

export default async function CategoryPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const category = categoryBySlug((await params).category);
  if (!category) notFound();
  const q = await searchParams;
  const all = productsInCategory(category.value);
  const metals = [...new Set(all.map((p) => p.metal))] as Metal[];
  const metal = metals.includes(q.metal as Metal) ? (q.metal as Metal) : undefined;
  const sort = SORTS.some((s) => s.value === q.sort) ? q.sort! : "featured";

  let products = metal ? all.filter((p) => p.metal === metal) : all;
  if (sort === "price-asc") products = [...products].sort((a, b) => a.price - b.price);
  if (sort === "price-desc") products = [...products].sort((a, b) => b.price - a.price);

  const chip = (active: boolean) =>
    `inline-flex min-h-10 items-center rounded-full border px-4 text-sm transition-colors ${active ? "border-ink bg-ink text-ivory" : "border-line-strong text-ink-soft hover:border-ink hover:text-ink"}`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-xs text-muted">
        <ol className="flex gap-2">
          <li>
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-ink-soft">
            {category.label}
          </li>
        </ol>
      </nav>
      <header className="mt-6 max-w-2xl">
        <h1 className="font-display text-5xl text-ink">{category.label}</h1>
        <p className="mt-3 text-ink-soft">{category.blurb}</p>
      </header>

      <div className="mt-10 flex flex-col gap-4 border-y border-line py-4 md:flex-row md:items-center md:justify-between">
        <ul aria-label="Filter by metal" className="flex flex-wrap gap-2">
          <li>
            <Link href={href(category.slug, { sort })} aria-current={!metal ? "true" : undefined} className={chip(!metal)}>
              All metals
            </Link>
          </li>
          {metals.map((m) => (
            <li key={m}>
              <Link href={href(category.slug, { metal: m, sort })} aria-current={metal === m ? "true" : undefined} className={chip(metal === m)}>
                {METAL_LABELS[m]}
              </Link>
            </li>
          ))}
        </ul>
        <ul aria-label="Sort" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {SORTS.map((s) => (
            <li key={s.value}>
              <Link href={href(category.slug, { metal, sort: s.value })} aria-current={sort === s.value ? "true" : undefined} className={sort === s.value ? "text-ink underline decoration-gold underline-offset-4" : "text-muted hover:text-ink"}>
                {s.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-6 text-sm text-muted" role="status">
        {products.length} {products.length === 1 ? "piece" : "pieces"}
      </p>
      <div className="mt-6">
        <ProductGrid products={products} priorityCount={4} />
      </div>
    </div>
  );
}
