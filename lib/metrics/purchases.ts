/**
 * Gift purchase events (owner: A6). The only new data the retailer side records: "a shortlisted
 * piece of Fit Request X was bought". No recipient data, no giver data, no price paid.
 *
 * Process-wide memory store on globalThis (every Next route bundle sees the same log, like
 * lib/privacy's repos, ADR-023). It does not survive restarts; a Postgres table is requested in
 * docs/reports/A6.md.
 */

export interface PurchaseEvent {
  fitRequestId: string;
  skuId: string;
  at: Date;
}

export interface PurchaseLog {
  /** Records each (request, sku) once; returns how many were new. */
  record(fitRequestId: string, skuIds: readonly string[], at?: Date): number;
  forRequest(fitRequestId: string): PurchaseEvent[];
  all(): PurchaseEvent[];
  clear(): void;
}

export class MemoryPurchaseLog implements PurchaseLog {
  private readonly events: PurchaseEvent[] = [];

  record(fitRequestId: string, skuIds: readonly string[], at: Date = new Date()): number {
    let added = 0;
    for (const skuId of new Set(skuIds)) {
      if (this.events.some((e) => e.fitRequestId === fitRequestId && e.skuId === skuId)) continue;
      this.events.push({ fitRequestId, skuId, at });
      added++;
    }
    return added;
  }

  forRequest(fitRequestId: string): PurchaseEvent[] {
    return this.events.filter((e) => e.fitRequestId === fitRequestId).map((e) => ({ ...e }));
  }

  all(): PurchaseEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  clear(): void {
    this.events.length = 0;
  }
}

const KEY = Symbol.for("giftfit.metrics.purchases");
type G = typeof globalThis & { [KEY]?: PurchaseLog };

export function getPurchaseLog(): PurchaseLog {
  const g = globalThis as G;
  return (g[KEY] ??= new MemoryPurchaseLog());
}

/** Tests: swap the log (undefined resets to a fresh memory log on next use). */
export function setPurchaseLog(log: PurchaseLog | undefined): void {
  (globalThis as G)[KEY] = log;
}
