/**
 * Catalog source for recipient routes (owner: A5). Default: the Aurum demo catalog
 * (data/aurum/catalog.json), the same source lib/fit uses (ADR-020). A DB-backed source can be
 * injected through PrivacyDeps.catalog once Neon exists.
 */
import aurumCatalog from "@/data/aurum/catalog.json";
import type { CatalogSku } from "@/lib/contracts/giftfit";

export interface CatalogSource {
  getSkus(ids: readonly string[]): Promise<CatalogSku[]>;
}

export class StaticCatalogSource implements CatalogSource {
  private readonly byId: Map<string, CatalogSku>;
  constructor(skus: readonly CatalogSku[]) {
    this.byId = new Map(skus.map((s) => [s.id, s]));
  }
  async getSkus(ids: readonly string[]): Promise<CatalogSku[]> {
    return ids.flatMap((id) => {
      const s = this.byId.get(id);
      return s ? [s] : [];
    });
  }
}

let aurum: StaticCatalogSource | undefined;

export function aurumCatalogSource(): CatalogSource {
  aurum ??= new StaticCatalogSource(aurumCatalog as unknown as CatalogSku[]);
  return aurum;
}
