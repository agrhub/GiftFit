"use client";
import Link from "next/link";
import { useState } from "react";
import { type CartLine, useCart } from "./CartProvider";

export function AddToBagButton({ line, className = "" }: { line: Omit<CartLine, "qty">; className?: string }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        data-testid="add-to-bag"
        onClick={() => {
          add(line);
          setAdded(true);
        }}
        className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-ink px-7 text-sm font-medium text-ivory transition-colors hover:bg-ink-soft"
      >
        Add to bag
      </button>
      <p role="status" aria-live="polite" className="mt-2 min-h-5 text-center text-sm text-ink-soft">
        {added ? (
          <>
            Added to your bag.{" "}
            <Link href="/cart" className="text-ink underline decoration-gold underline-offset-4">
              View bag
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}
