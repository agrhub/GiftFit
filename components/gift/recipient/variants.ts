/**
 * Recipient-side variant helpers (owner: A4, ADR-032). Kept apart from TryOnCarousel so the
 * flow can use them without pulling the (lazy-loaded) carousel into the first-load bundle.
 */
import type { CaptureResponse, CarouselItem } from "@/lib/contracts/api";
import { recipientEn } from "@/lib/i18n/recipient";

/** The render of one metal of one design. */
export interface TryOnRender {
  status: CaptureResponse["tryons"][number]["status"];
  imageUrl?: string;
  failureReason?: string;
}

/** What one card shows right now (computed by the flow). */
export interface CardState {
  /** Swatch shown (undefined for items without swatches). */
  swatchId?: string;
  render?: TryOnRender;
  /** A swatch render is in flight for this card. */
  loading: boolean;
  /** The metal shown is hearted. */
  hearted: boolean;
  wished: boolean;
  /** The extra-render cap was hit when trying a metal on this card. */
  capNote: boolean;
  /** "Delete my photo now" was used: only already-rendered metals can be shown (ADR-036). */
  rendersOff?: boolean;
  /** No try-on for this gift (store-URL previews, ADR-055): product photos only, never "your try-on". */
  noTryOn?: boolean;
  /** A16 mixed set: this piece is never tried on (its store photo can't be used); hearts from the photo. */
  notTriable?: boolean;
  /** Swatches with a render in hand (selectable even when renders are off). */
  renderedSwatchIds?: string[];
}

/** English copy (the page renders lib/i18n/recipient in its locale; these stay for tests and old callers). */
export const CAP_NOTE: string = recipientEn["card.capNote"];

/** Key of a heart or a render: "<itemId>|<swatchId>" ("" for swatch-less items). */
export const heartKey = (itemId: string, swatchId: string | undefined) =>
  `${itemId}|${swatchId ?? ""}`;

/** The swatch rendered first: the server's default, else the first. */
export function defaultSwatch(
  item: Pick<CarouselItem, "swatches">,
): string | undefined {
  return (
    item.swatches?.find((s) => s.isDefault)?.swatchId ??
    item.swatches?.[0]?.swatchId
  );
}

/** Consent copy (ADR-036, option A). */
export const PHOTO_RETENTION: string = recipientEn["intro.retention"];

export const PHOTO_DELETED_NOTE: string = recipientEn["photo.deletedNote"];
