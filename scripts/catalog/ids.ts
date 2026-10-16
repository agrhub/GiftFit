/** Deterministic ids: RFC 4122 v5 UUIDs (SHA-1, fixed namespace) so re-seeding never changes a row id. */
import { createHash } from "node:crypto";

/** Namespace for every Aurum Jewelry id (randomly generated once, never change it). */
export const AURUM_NAMESPACE = "6b0d3c2e-8f4a-4d1b-9c55-1e7a2f9d4b30";

export function uuidv5(name: string, namespace = AURUM_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 32-bit FNV-1a, for deterministic per-SKU variation. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const AURUM_STORE_ID = uuidv5("store:aurum-jewelry");
export const skuId = (sku: string) => uuidv5(`sku:${sku}`);
