/**
 * /embed?store=aurum&sku=<slug|sku|id>&parent=<origin> (owner: A6). The page the script tag opens
 * in an iframe: A4's Giver Panel, reused by import, for one product. It posts only
 * giftfit:ready / giftfit:sent / giftfit:close to the parent origin given in the URL; no tokens,
 * ids or recipient data ever cross the frame boundary.
 */
import type { Metadata } from "next";
import { getProduct, toGiftPiece } from "@/client/store/catalog";
import { findStore } from "@/server/metrics/catalog";
import { EmbedPanel } from "./EmbedPanel";
import { parentOrigin } from "./origin";

export const metadata: Metadata = { title: "Gift it right", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Search = Promise<{ store?: string; sku?: string; parent?: string }>;

export default async function EmbedPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const store = findStore(q.store ?? "aurum");
  const product = store && q.sku ? getProduct(q.sku) : undefined;
  return (
    <>
      {/* The overlay iframe is transparent: the panel's own backdrop dims the store page behind it. */}
      <style>{"html,body{background:transparent!important}"}</style>
      <EmbedPanel piece={product ? toGiftPiece(product) : null} parentOrigin={parentOrigin(q.parent)} />
    </>
  );
}
