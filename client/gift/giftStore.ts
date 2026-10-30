"use client";
/**
 * Which store the gift pages are for (ADR-055). The (gift) layout's header can't know it: the report and
 * recipient pages learn it from their API response and publish it here. Unknown until then, so a
 * store-URL preview's pages never flash "Aurum Jewelry".
 */
import { useSyncExternalStore } from "react";
import storeInfo from "@/fixtures/aurum/store.json";

/** The Aurum demo store's display name. */
export const AURUM_STORE_NAME: string = storeInfo.name;

let current: string | null = null;
const listeners = new Set<() => void>();

/** Publish the store name (null = unknown: the header shows GiftFit only). */
export function setGiftStoreName(name: string | null): void {
  if (name === current) return;
  current = name;
  for (const l of listeners) l();
}

export function useGiftStoreName(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
}

/**
 * The store name for a request's pages: the preview store's own name; null for a preview whose name is
 * unknown (never the Aurum name); the Aurum demo store otherwise.
 */
export function storeNameFor(r: {
  storeName?: string;
  preview: boolean;
}): string | null {
  if (r.storeName) return r.storeName;
  return r.preview ? null : AURUM_STORE_NAME;
}
