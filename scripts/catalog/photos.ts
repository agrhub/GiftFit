/**
 * Photo-real images for the 12 demo-critical SKUs (ADR-018): AI-generated with Google Flow from team-written
 * text prompts (data/aurum/photo-inbox/PROVENANCE.md), stored as public/catalog/aurum/photo/<sku>.jpg.
 *
 * Wiring rules (applied by generate.ts, also with --data-only):
 *  - images[0] = the photo; the vector render stays in images[] as a fallback.
 *  - If the photo passes BOTH the pixel check and the manual review below, it becomes `vto_image`
 *    and the vector render moves to `vto_image_fallback`.
 *  - Otherwise the photo is display-only: `vto_image` stays the vector render (which passes the spec).
 *  - `vto_spec_ok` always describes `vto_image` (contract semantics); `photo_vto_spec_ok` describes the photo.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CatalogSku } from "@/lib/contracts/giftfit";
import { checkVtoSpec } from "./spec-check";

export interface PhotoReview {
  /** Manual review against api_matrix.md §9 for the category (looked at by A2, 2026-10-15). */
  specOk: boolean;
  /** What the reviewer saw; kept in the catalog so A1/A4 can read it. */
  note: string;
  /** Flag for regeneration or verification on the first real smoke run. */
  recheck?: boolean;
  /** Replacement round; the previous file is kept in public/catalog/aurum/photo/v1/<sku>.jpg. */
  version?: "v2" | "v3";
  /** Anchor points measured on the photo itself (1024 px), e.g. the open tips of a rigid collar. */
  anchors?: Record<string, number[] | number[][]>;
  /** Inbox file the current photo was copied from, when it differs from the default name. */
  source?: string;
  /** Served photo path when it is not /catalog/aurum/photo/<sku>.jpg (e.g. a metal-variant photo used as the default). */
  file?: string;
}

export const PHOTO_REVIEW: Record<string, PhotoReview> = {
  "AUR-EAR-028": { specOk: true, note: "Single earring, front view: bezel stud, jump ring, pear centre stone with pavé halo in yellow gold." },
  "AUR-EAR-038": { specOk: true, note: "Single filigree chandelier earring, front view, white metal, three graduated pearls." },
  "AUR-EAR-034": {
    specOk: true,
    note: "Single yellow gold openwork bell drop, front view, clear pavé along the bell rim, ball post top (Flow metal edit of the rose gold photo, now the default listing).",
    file: "/catalog/aurum/photo/variants/aur-ear-034-yellow_gold.jpg",
  },
  "AUR-EAR-042": { specOk: true, note: "Single long fringe earring, front view: half-moon top with a fan of beaded chains; earring back slightly visible behind the top." },
  "AUR-EAR-002": { specOk: true, note: "Single round bezel stud, front view, white metal, clear round stone." },
  "AUR-NEC-037": { specOk: true, note: "Worn front view: cable chain V drape with both chain ends near the top, pear pendant." },
  "AUR-NEC-021": { specOk: true, note: "Worn front view: chain rises to both sides, horizontal bib of green bezel stones with clear accents." },
  "AUR-NEC-009": {
    specOk: true,
    note: "v2: worn front view, whole necklace inside the frame with both chain ends at the upper left and right, upturned crescent pendant, rose gold, no stones.",
    version: "v2",
    source: "data/aurum/photo-inbox/aur-nec-009-v2.jpg",
  },
  "AUR-NEC-017": {
    specOk: true,
    note: "v3: rigid yellow gold pavé collar shown front-on as an open U, both tips inside the frame, clear pavé, no chain (the tips are the anchor points).",
    version: "v3",
    source: "data/aurum/photo-inbox/aur-nec-017-v3.jpg",
    // measured on the v3 photo: centres of the two open tips
    anchors: {
      necklace_anchor_point: [
        [304, 178],
        [718, 178],
      ],
    },
  },
  "AUR-RNG-005": { specOk: true, note: "Single ring, three-quarter front view about 45 degrees, oval blue centre stone with halo, rose gold." },
  "AUR-BRC-003": {
    specOk: true,
    note: "v2: tennis bracelet tilted about 45 degrees, clear open ellipse with the front stones facing the camera, white metal, clear stones, no clasp visible.",
    version: "v2",
    // the inbox names were swapped: aur-nec-017-v2.jpg contains this bracelet (aur-brc-003-v2.jpg is a crescent necklace)
    source: "data/aurum/photo-inbox/aur-nec-017-v2.jpg",
  },
  "AUR-WCH-002": { specOk: true, note: "Watch upright and front-facing, two-tone case, silver dial, black leather straps cut straight, no buckle or clasp, no dial text." },
};

export const photoPath = (sku: string) => `/catalog/aurum/photo/${sku.toLowerCase()}.jpg`;

export interface PhotoOutcome {
  sku: string;
  pixelOk: boolean;
  pixelIssues: string[];
  specOk: boolean;
}

/** Mutates the SKUs that have a photo on disk. Returns one outcome per photo SKU. */
export async function applyPhotos(skus: CatalogSku[], root = process.cwd()): Promise<PhotoOutcome[]> {
  const out: PhotoOutcome[] = [];
  for (const [code, review] of Object.entries(PHOTO_REVIEW)) {
    const sku = skus.find((s) => s.attributes.sku === code);
    if (!sku) throw new Error(`photo for unknown SKU ${code}`);
    const rel = review.file ?? photoPath(code);
    const file = path.join(root, "public", rel);
    if (!existsSync(file)) throw new Error(`missing photo ${file}`);
    const check = await checkVtoSpec(readFileSync(file), sku.category, { photo: true });
    const specOk = check.ok && review.specOk;
    const a = sku.attributes;
    const vector = `/catalog/aurum/${code.toLowerCase()}.png`;
    sku.images = [rel, vector];
    a.image_source = "ai_photo";
    a.photo_image = rel;
    a.photo_vto_spec_ok = specOk;
    a.photo_review = review.note;
    if (!specOk) a.photo_vto_spec_issues = [...check.reasons, ...(review.specOk ? [] : ["manual review: does not meet the 2d-vto framing for its category"])];
    if (review.recheck) a.photo_recheck = true;
    if (review.version) {
      a.photo_version = review.version;
      a.photo_v1_image = `/catalog/aurum/photo/v1/${code.toLowerCase()}.jpg`;
      if (!existsSync(path.join(root, "public", String(a.photo_v1_image)))) throw new Error(`missing v1 photo for ${code}`);
    }
    if (specOk) {
      a.vto_image = rel;
      a.vto_image_fallback = vector;
      // anchors were measured on the vector render; they do not apply to the photo
      a.vto_params_fallback = a.vto_params;
      if (review.anchors) a.vto_params = review.anchors;
      else delete a.vto_params;
      a.vto_spec_ok = true;
    } else {
      a.vto_image = vector;
    }
    out.push({ sku: code, pixelOk: check.ok, pixelIssues: check.reasons, specOk });
  }
  return out;
}
