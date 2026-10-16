"use client";
import Link from "next/link";
import { useCart } from "./CartProvider";

export function BagIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" className={className}>
      <path d="M5 8h14l-1 12H6L5 8Z" strokeLinejoin="round" />
      <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
    </svg>
  );
}

export function BagLink() {
  const { count, ready } = useCart();
  return (
    <Link href="/cart" className="relative inline-flex min-h-11 min-w-11 items-center justify-center gap-2 text-ink hover:text-gold-deep" aria-label={ready ? `Shopping bag, ${count} ${count === 1 ? "item" : "items"}` : "Shopping bag"}>
      <BagIcon />
      <span className="hidden text-sm lg:inline">Bag</span>
      {ready && count > 0 ? (
        <span aria-hidden="true" className="absolute right-0.5 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-ink px-1 text-[0.625rem] font-semibold text-ivory lg:static lg:h-5 lg:min-w-5">
          {count}
        </span>
      ) : null}
    </Link>
  );
}
