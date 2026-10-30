/**
 * Catalog source for recipient routes (owner: A5). Default: the Aurum demo catalog
 * (fixtures/aurum/catalog.json), the same source server/fit uses (ADR-020). A DB-backed source can be
 * injected through PrivacyDeps.catalog once Neon exists.
 */
import aurumCatalog from "@/fixtures/aurum/catalog.json";
import type { CatalogSku } from "@/server/contracts/giftfit";

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
