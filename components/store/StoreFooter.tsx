import Link from "next/link";
import { CATEGORIES } from "./format";
import { Wordmark } from "./StoreHeader";

export function StoreFooter() {
  return (
    <footer className="mt-24 border-t border-line bg-cream">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-4">
          <Wordmark className="items-start" />
          <p className="max-w-sm text-sm leading-6 text-ink-soft">
            Aurum Jewelry is a fictional demo boutique built to show GiftFit. Every piece, photo and price here was made by the GiftFit team. No real orders, no payments.
          </p>
        </div>
        <nav aria-label="Shop">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Shop</h2>
          <ul className="mt-4 space-y-2 text-sm text-ink-soft">
            {CATEGORIES.map((c) => (
              <li key={c.slug}>
                <Link href={`/c/${c.slug}`} className="hover:text-ink">
                  {c.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Gift it right</h2>
          <p className="mt-4 text-sm leading-6 text-ink-soft">
            The person you&apos;re shopping for tries pieces on with an AI preview. You see fit scores, never their photos.
          </p>
          <Link href="/#gift-it-right" className="mt-3 inline-block text-sm text-ink underline decoration-gold underline-offset-4">
            How it works
          </Link>
          <Link href="/demo" className="mt-3 block text-sm text-ink underline decoration-gold underline-offset-4">
            Judge demo
          </Link>
        </div>
      </div>
      <p className="border-t border-line px-4 py-5 text-center text-xs text-muted">Demo store · Powered by GiftFit on YouCam AI APIs</p>
    </footer>
  );
}
