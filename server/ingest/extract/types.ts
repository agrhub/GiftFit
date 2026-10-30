import type { RenderedPage } from "../html";
import type { DroppedField, ExtractedProduct } from "../types";

export interface ExtractionResult {
  product: ExtractedProduct;
  /** Fields the grounding check removed (the extractor proposed them, the page does not support them). */
  dropped: DroppedField[];
}

/** Tier 3 extractor: rendered page → product fields as written on the page. */
export interface Extractor {
  readonly name: string;
  extract(page: RenderedPage): Promise<ExtractionResult>;
}

export class ExtractionError extends Error {
  constructor(message: string, public readonly url: string) {
    super(message);
    this.name = "ExtractionError";
  }
}
