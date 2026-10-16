import Link from "next/link";
import { CATEGORIES } from "./format";
import { BagLink } from "./BagLink";

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex flex-col items-center leading-none ${className}`}>
      <span className="font-display text-[1.65rem] font-medium tracking-[0.32em] text-ink">AURUM</span>
      <span className="mt-1 text-[0.6rem] font-medium tracking-[0.42em] text-muted">JEWELRY</span>
    </span>
  );
}

export function StoreHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ivory/95 backdrop-blur supports-[backdrop-filter]:bg-ivory/85">
      <p className="bg-ink px-4 py-2 text-center text-xs tracking-wide text-ivory">
        Shopping for someone? Let them try it on privately.{" "}
        <Link href="/#gift-it-right" className="underline decoration-gold underline-offset-4 hover:decoration-ivory">
          How Gift it right works
        </Link>
      </p>
      <div className="mx-auto grid max-w-6xl grid-cols-[1fr_auto_1fr] items-center px-4 py-3 sm:px-6">
        <nav aria-label="Primary" className="hidden md:block">
          <ul className="flex gap-6 text-sm text-ink-soft">
            {CATEGORIES.slice(0, 3).map((c) => (
              <li key={c.slug}>
                <Link href={`/c/${c.slug}`} className="transition-colors hover:text-ink">
                  {c.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <span className="md:hidden" />
        <Link href="/" className="justify-self-center py-1">
          <Wordmark />
          <span className="sr-only"> home</span>
        </Link>
        <div className="flex items-center justify-end gap-6 text-sm text-ink-soft">
          <ul className="hidden gap-6 md:flex">
            {CATEGORIES.slice(3).map((c) => (
              <li key={c.slug}>
                <Link href={`/c/${c.slug}`} className="transition-colors hover:text-ink">
                  {c.label}
                </Link>
              </li>
            ))}
          </ul>
          <BagLink />
        </div>
      </div>
      <nav aria-label="Categories" className="gf-no-scrollbar overflow-x-auto border-t border-line md:hidden">
        <ul className="flex min-w-max gap-5 px-4 py-2.5 text-sm text-ink-soft">
          {CATEGORIES.map((c) => (
            <li key={c.slug}>
              <Link href={`/c/${c.slug}`} className="inline-block py-1 hover:text-ink">
                {c.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
