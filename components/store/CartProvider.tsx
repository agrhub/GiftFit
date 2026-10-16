"use client";
/**
 * Mock shopping bag (owner: A4). Demo store only: lives in this browser (localStorage), no
 * payment, no account. Lines keep a small product snapshot so the bag renders without the catalog.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface CartLine {
  /** Catalog (design) id. */
  id: string;
  /** Metal variant (ADR-032); a design in two metals is two lines. */
  variantId?: string;
  metal?: string;
  slug: string;
  title: string;
  price: number;
  currency: string;
  image: string;
  category: string;
  qty: number;
}

interface CartContextValue {
  lines: CartLine[];
  count: number;
  subtotal: number;
  ready: boolean;
  add: (line: Omit<CartLine, "qty">, qty?: number) => void;
  /** By line key (variant id, else design id). */
  setQty: (key: string, qty: number) => void;
  remove: (key: string) => void;
  clear: () => void;
}

const STORAGE_KEY = "aurum.bag.v1";

/** A bag line is one variant of a design. */
export const lineKey = (l: Pick<CartLine, "id" | "variantId">) => l.variantId ?? l.id;
const CartContext = createContext<CartContextValue | null>(null);

function read(): CartLine[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as CartLine[]).filter((l) => l && typeof l.id === "string" && l.qty > 0) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLines(read());
    setReady(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setLines(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const persist = useCallback((next: CartLine[]) => {
    setLines(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the bag still works for this page view */
    }
  }, []);

  const value = useMemo<CartContextValue>(() => {
    const add: CartContextValue["add"] = (line, qty = 1) => {
      const key = lineKey(line);
      const existing = lines.find((l) => lineKey(l) === key);
      persist(existing ? lines.map((l) => (lineKey(l) === key ? { ...l, qty: Math.min(9, l.qty + qty) } : l)) : [...lines, { ...line, qty }]);
    };
    return {
      lines,
      ready,
      count: lines.reduce((n, l) => n + l.qty, 0),
      subtotal: lines.reduce((n, l) => n + l.qty * l.price, 0),
      add,
      setQty: (key, qty) => persist(qty <= 0 ? lines.filter((l) => lineKey(l) !== key) : lines.map((l) => (lineKey(l) === key ? { ...l, qty: Math.min(9, qty) } : l))),
      remove: (key) => persist(lines.filter((l) => lineKey(l) !== key)),
      clear: () => persist([]),
    };
  }, [lines, persist, ready]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}
