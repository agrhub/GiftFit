import Image from "next/image";
import Link from "next/link";
import { HERO_SKU, featuredProducts, getProduct, productsInCategory } from "@/components/store/catalog";
import { CATEGORIES, formatPrice, productPath } from "@/components/store/format";
import { ProductGrid } from "@/components/store/ProductCard";
import { JudgeDemo } from "@/components/gift/JudgeDemo";

const STEPS = [
  {
    n: "01",
    title: "Shortlist and send",
    body: "Pick the occasion, a budget and up to four pieces. Tap Gift it right and send a private link that lasts 72 hours.",
  },
  {
    n: "02",
    title: "They try on, privately",
    body: "On their phone they see six to eight pieces on themselves, as an AI preview, and heart the ones they love. You see their taste, never their photos, so the surprise holds.",
  },
  {
    n: "03",
    title: "You get a Fit Report",
    body: "Fit scores and short reasons for each of your picks. Never a photo. Their photos are deleted as soon as the try-ons are made.",
  },
];

export default function HomePage() {
  const hero = getProduct(HERO_SKU)!;
  const featured = featuredProducts().slice(0, 8);
  const tiles = CATEGORIES.map((c) => ({ ...c, product: productsInCategory(c.value)[0] }));

  return (
    <>
      <section className="border-b border-line">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 sm:px-6 md:grid-cols-2 md:py-20">
          <div className="gf-fade-in order-2 md:order-1">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-gold-deep">The Gift Edit</p>
            <h1 className="mt-4 font-display text-5xl font-medium leading-[1.05] text-ink sm:text-6xl">
              Fine jewelry,
              <br />
              <em className="font-normal">chosen with care.</em>
            </h1>
            <p className="mt-6 max-w-md text-base leading-7 text-ink-soft">
              You can try on a ring for yourself. Now you can let them try it on, without spoiling the surprise.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href={productPath(hero)} className="inline-flex min-h-12 items-center rounded-full bg-ink px-7 text-sm font-medium text-ivory transition-colors hover:bg-ink-soft">
                Shop the Halo Drop
              </Link>
              <Link href="#gift-it-right" className="inline-flex min-h-12 items-center rounded-full border border-line-strong px-7 text-sm font-medium text-ink transition-colors hover:border-ink">
                How Gift it right works
              </Link>
            </div>
          </div>
          <figure className="order-1 md:order-2">
            <Link href={productPath(hero)} className="group block">
              <div className="relative aspect-[4/5] overflow-hidden rounded-sm border border-line bg-white">
                <Image src={hero.image} alt={hero.title} fill priority unoptimized fetchPriority="high" sizes="(min-width: 768px) 46vw, 92vw" className="object-contain p-[12%] mix-blend-multiply transition-transform duration-1000 ease-[var(--ease-soft)] group-hover:scale-[1.03]" />
              </div>
              <figcaption className="mt-3 flex justify-between text-sm text-ink-soft">
                <span className="font-display text-lg text-ink">{hero.title}</span>
                <span>{formatPrice(hero.price, hero.currency)}</span>
              </figcaption>
            </Link>
          </figure>
        </div>
      </section>

      <section aria-labelledby="judge-demo-title" className="border-b border-line bg-white">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:px-6 md:grid-cols-[1fr_1.4fr] md:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-gold-deep">For judges</p>
            <h2 id="judge-demo-title" className="mt-2 font-display text-3xl leading-tight text-ink">
              Try GiftFit in a minute
            </h2>
            <Link href="/demo" className="mt-2 inline-block text-sm text-ink underline decoration-gold underline-offset-4">
              More demo options
            </Link>
          </div>
          <JudgeDemo compact />
        </div>
      </section>

      <section aria-labelledby="shop-by-category" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="shop-by-category" className="text-center font-display text-3xl text-ink sm:text-4xl">
          Shop by category
        </h2>
        <ul className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {tiles.map((t) => (
            <li key={t.slug} className={t.slug === "watches" ? "col-span-2 sm:col-span-1" : ""}>
              <Link href={`/c/${t.slug}`} className="group block">
                <div className="relative aspect-square overflow-hidden rounded-sm border border-line bg-white">
                  {t.product ? <Image src={t.product.image} alt="" fill sizes="(min-width: 1024px) 18vw, (min-width: 640px) 30vw, 46vw" className="object-contain p-[14%] mix-blend-multiply transition-transform duration-700 group-hover:scale-105" /> : null}
                </div>
                <p className="mt-3 text-center text-sm font-medium uppercase tracking-[0.2em] text-ink">{t.label}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section id="gift-it-right" aria-labelledby="gift-it-right-title" className="scroll-mt-28 bg-cream">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-gold-deep">Gift it right, by GiftFit</p>
            <h2 id="gift-it-right-title" className="mt-4 font-display text-4xl leading-tight text-ink sm:text-5xl">
              Try it on for someone else. The surprise stays a surprise.
            </h2>
          </div>
          <ol className="mt-12 grid gap-px overflow-hidden rounded-sm border border-line bg-line md:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="bg-ivory p-7">
                <p className="font-display text-3xl text-gold-deep">{s.n}</p>
                <h3 className="mt-4 text-base font-semibold text-ink">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-ink-soft">{s.body}</p>
              </li>
            ))}
          </ol>
          <dl className="mt-10 grid grid-cols-3 gap-4 text-center">
            <div>
              <dt className="text-xs uppercase tracking-[0.18em] text-muted">Photos you see</dt>
              <dd className="mt-1 font-display text-4xl text-ink">0</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.18em] text-muted">Pieces they try</dt>
              <dd className="mt-1 font-display text-4xl text-ink">6</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.18em] text-muted">Link lifetime</dt>
              <dd className="mt-1 font-display text-4xl text-ink">72 h</dd>
            </div>
          </dl>
          <p className="mt-10 text-sm text-ink-soft">
            Start from any product page or your bag: look for <strong className="font-semibold text-ink">Gift it right</strong>.
          </p>
        </div>
      </section>

      <section aria-labelledby="gift-edit" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="mb-10 flex items-end justify-between gap-4">
          <h2 id="gift-edit" className="font-display text-3xl text-ink sm:text-4xl">
            The Gift Edit
          </h2>
          <Link href="/c/earrings" className="text-sm text-ink underline decoration-gold underline-offset-4">
            Shop all earrings
          </Link>
        </div>
        <ProductGrid products={featured} />
      </section>
    </>
  );
}
