/**
 * In-browser UI mock of the GiftFit API (owner: A4). Opt-in only: NEXT_PUBLIC_GIFTFIT_UI_MOCK=1.
 * For looking at the pages while the backend routes land; never the default and never shipped as
 * a fallback. State lives in this browser's localStorage, so giver and recipient must share a
 * browser. Scores are placeholders, not the Fit Engine. "Try-ons" are the catalog variant images.
 * Follows the ADR-032 contract: cap + metal lock, swatches without prices, lazy swatch renders
 * capped at 4 extra, hearts per variant, wish-for-another-metal.
 */
import type {
  CaptureResponse,
  CarouselItem,
  CreateFitRequestBody,
  CreateFitRequestResponse,
  DoneResponse,
  GiverReportStatus,
  RecipientSessionResponse,
  SwatchResponse,
} from "@/lib/contracts/api";
import type {
  FitResult,
  Metal,
  Occasion,
  Undertone,
} from "@/lib/contracts/giftfit";
import type { Product, ProductVariant } from "@/components/store/catalog";
import { METAL_LABELS } from "@/components/store/format";
import { ApiError, type GiftApi, normalizeReport } from "./api";

export const MOCK_EXTRA_RENDERS = 4;

interface MockRequest {
  id: string;
  giverToken: string;
  recipientToken: string;
  body: CreateFitRequestBody;
  decoyIds: string[];
  order: string[];
  status: RecipientSessionResponse["status"];
  expiresAt: string;
  /** "<itemId>|<swatchId>" */
  hearts: string[];
  wishes: string[];
  rendered: string[];
  override: Undertone | null;
  /** "Delete my photo now" was used: no more metal renders (ADR-036). */
  photoDeleted?: boolean;
}

const KEY = "giftfit.uimock.v2";
const read = (): MockRequest[] => {
  try {
    return JSON.parse(
      window.localStorage.getItem(KEY) ?? "[]",
    ) as MockRequest[];
  } catch {
    return [];
  }
};
const write = (all: MockRequest[]) =>
  window.localStorage.setItem(KEY, JSON.stringify(all));
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function find(pred: (r: MockRequest) => boolean): MockRequest {
  const r = read().find(pred);
  if (!r) throw new ApiError(404, "not_found");
  if (new Date(r.expiresAt).getTime() < Date.now())
    throw new ApiError(410, "expired");
  return r;
}
function save(r: MockRequest) {
  write(read().map((x) => (x.id === r.id ? r : x)));
}

async function catalog() {
  return (await import("@/components/store/catalog")).PRODUCTS;
}

const SWATCH_COLORS: Record<Metal, string> = {
  yellow_gold: "#d4b062",
  rose_gold: "#d39a85",
  white_gold: "#d9d9d6",
  silver: "#c8cacc",
  platinum: "#d3d4d8",
  mixed_two_tone: "#cfc09a",
};

function eligible(p: Product, body: CreateFitRequestBody): ProductVariant[] {
  const vs = p.variants.filter(
    (v) =>
      v.price <= body.budgetMax &&
      (!body.metalLock || body.metalLock.includes(v.metal)),
  );
  return vs.length ? vs : [p.variants[0]];
}

const itemIdOf = (id: string) => `m-${id.slice(0, 8)}`;
const swatchIdOf = (v: ProductVariant) => `s-${v.metal}`;

async function items(
  r: MockRequest,
): Promise<
  Array<CarouselItem & { variants: ProductVariant[]; productId: string }>
> {
  const all = await catalog();
  return r.order.map((id) => {
    const p = all.find((x) => x.id === id)!;
    const vs = eligible(p, r.body);
    return {
      itemId: itemIdOf(id),
      productId: id,
      variants: vs,
      title: p.title,
      category: p.category,
      productImage: vs[0].image,
      needsHandPhoto: ["ring", "bracelet", "watch"].includes(p.category),
      swatches: vs.map((v, i) => ({
        swatchId: swatchIdOf(v),
        metalLabel: METAL_LABELS[v.metal].replace(
          "Silver tone",
          "Sterling silver",
        ),
        swatchColor: SWATCH_COLORS[v.metal],
        isDefault: i === 0,
      })),
    };
  });
}

/** No prices to the recipient: strip the internal fields. */
async function publicItems(r: MockRequest): Promise<CarouselItem[]> {
  return (await items(r)).map(
    ({ itemId, title, category, productImage, needsHandPhoto, swatches }) => ({
      itemId,
      title,
      category,
      productImage,
      needsHandPhoto,
      swatches,
    }),
  );
}

async function session(r: MockRequest): Promise<RecipientSessionResponse> {
  return {
    status: r.status,
    occasion: r.body.occasion as Occasion,
    expiresAt: r.expiresAt,
    items: await publicItems(r),
  };
}

async function mockCapture(
  r: MockRequest,
  hand: boolean,
): Promise<CaptureResponse> {
  const its = await items(r);
  return {
    tryons: its.map((i) =>
      i.needsHandPhoto && !hand
        ? {
            itemId: i.itemId,
            swatchId: i.swatches![0].swatchId,
            status: "skipped_needs_hand",
          }
        : {
            itemId: i.itemId,
            swatchId: i.swatches![0].swatchId,
            status: "ready",
            imageUrl: i.variants[0].image,
          },
    ),
    undertone: {
      estimate: "neutral",
      confidence: 0.2,
      override: r.override,
      label: "Neutral undertone (estimate)",
    },
    faceShapeLabel: "Oval face shape (estimate)",
    processingSeconds: 2.5,
  };
}

export const mockGiftApi: GiftApi = {
  isMock: true,
  async createFitRequest(body) {
    await wait(500);
    const all = await catalog();
    const picks = all.filter((p) => body.shortlistIds.includes(p.id));
    if (
      picks.some(
        (p) =>
          !p.variants.some(
            (v) =>
              v.price <= body.budgetMax &&
              (!body.metalLock || body.metalLock.includes(v.metal)),
          ),
      )
    ) {
      throw new ApiError(
        422,
        "no_eligible_variant",
        "A design has no variant within the cap and metal lock.",
      );
    }
    const decoys = all
      .filter(
        (p) =>
          !body.shortlistIds.includes(p.id) &&
          picks.some(
            (s) =>
              s.category === p.category &&
              Math.abs(p.price - s.price) <= s.price * 0.2,
          ),
      )
      .slice(0, 6 - picks.length)
      .map((p) => p.id);
    const order = [...body.shortlistIds, ...decoys].sort(
      () => Math.random() - 0.5,
    );
    const r: MockRequest = {
      id: token().slice(0, 12),
      giverToken: token(),
      recipientToken: token(),
      body,
      decoyIds: decoys,
      order,
      status: "awaiting_consent",
      expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
      hearts: [],
      wishes: [],
      rendered: [],
      override: null,
    };
    write([...read(), r]);
    const res: CreateFitRequestResponse = {
      fitRequestId: r.id,
      giverToken: r.giverToken,
      recipientPath: `/r/${r.recipientToken}`,
      giverReportPath: `/g/${r.giverToken}`,
      expiresAt: r.expiresAt,
      carouselSize: order.length,
    };
    return res;
  },
  async giverReport(giverToken) {
    const r = find((x) => x.giverToken === giverToken);
    const its = await items(r);
    const status: GiverReportStatus["status"] =
      r.status === "completed"
        ? "completed"
        : r.status === "awaiting_consent"
          ? "waiting"
          : "in_progress";
    const shortlist = its.filter((i) =>
      r.body.shortlistIds.includes(i.productId),
    );
    const heartedVariant = (i: (typeof its)[number]) => {
      const h = r.hearts.find((k) => k.startsWith(`${i.itemId}|`));
      return h
        ? i.variants.find((v) => swatchIdOf(v) === h.split("|")[1])
        : undefined;
    };
    const results: FitResult[] | undefined =
      status === "completed"
        ? shortlist.map((i) => {
            const v = heartedVariant(i) ?? i.variants[0];
            const hearted = Boolean(heartedVariant(i));
            const hearts = hearted ? 50 : 8;
            const metal =
              v.metal === "yellow_gold" || v.metal === "rose_gold" ? 12 : 10;
            return {
              skuId: i.productId,
              variantId: v.variantId,
              metal: v.metal,
              price: v.price,
              wishOtherMetal: r.wishes.includes(i.itemId),
              score: Math.round(hearts + metal + 11.5 + 13.2),
              breakdown: { hearts, metal, style: 11.5, budgetOccasion: 13.2 },
              reasons: [
                hearted
                  ? "They hearted this piece."
                  : "Close to a piece they hearted.",
                "Within your budget for the occasion.",
              ],
              caution: "UI mock: placeholder scores, not the Fit Engine.",
            };
          })
        : undefined;
    return normalizeReport({
      status,
      expiresAt: r.expiresAt,
      results,
      heartedShortlistIds:
        status === "completed"
          ? shortlist.filter((i) => heartedVariant(i)).map((i) => i.productId)
          : undefined,
      otherMetalWishes:
        status === "completed"
          ? shortlist
              .filter((i) => r.wishes.includes(i.itemId))
              .map((i) => i.productId)
          : undefined,
      recipientLabels:
        status === "completed"
          ? {
              undertone: "Neutral undertone estimate (low confidence)",
              faceShape: "Oval face shape estimate",
            }
          : undefined,
    });
  },
  async openSession(t) {
    await wait(300);
    return session(find((x) => x.recipientToken === t));
  },
  async consent(t) {
    const r = find((x) => x.recipientToken === t);
    r.status = "awaiting_capture";
    save(r);
    return session(r);
  },
  async resumeCapture(t) {
    const r = find((x) => x.recipientToken === t);
    if (r.status !== "trying_on" && r.status !== "completed") return null;
    const c = await mockCapture(r, false);
    // After "Delete my photo now": no try-on images at all (ADR-036, clarified).
    if (!r.photoDeleted) return c;
    return {
      ...c,
      tryons: c.tryons.map((t) => ({
        itemId: t.itemId,
        swatchId: t.swatchId,
        status: "failed" as const,
        failureReason: "photo_deleted",
      })),
    };
  },
  async capture(t, { hand }) {
    const r = find((x) => x.recipientToken === t);
    await wait(2500);
    r.status = "trying_on";
    save(r);
    return mockCapture(r, Boolean(hand));
  },
  async trySwatch(t, itemId, swatchId): Promise<SwatchResponse> {
    const r = find((x) => x.recipientToken === t);
    const item = (await items(r)).find((i) => i.itemId === itemId);
    const v = item?.variants.find((x) => swatchIdOf(x) === swatchId);
    if (!item || !v) throw new ApiError(404, "not_found");
    const key = `${itemId}|${swatchId}`;
    if (r.photoDeleted)
      return {
        status: "failed",
        failureReason: "photo_deleted",
        rendersLeft: 0,
      };
    if (!r.rendered.includes(key)) {
      if (r.rendered.length >= MOCK_EXTRA_RENDERS)
        return { status: "cap_reached", rendersLeft: 0 };
      await wait(1200);
      r.rendered.push(key);
      save(r);
    }
    if (item.needsHandPhoto)
      return {
        status: "skipped_needs_hand",
        rendersLeft: MOCK_EXTRA_RENDERS - r.rendered.length,
      };
    return {
      status: "ready",
      imageUrl: v.image,
      rendersLeft: MOCK_EXTRA_RENDERS - r.rendered.length,
    };
  },
  async saveHearts(t, hearts) {
    const r = find((x) => x.recipientToken === t);
    r.hearts = hearts.map((h) => `${h.itemId}|${h.swatchId ?? ""}`);
    save(r);
  },
  async deletePhoto(t) {
    const r = find((x) => x.recipientToken === t);
    r.photoDeleted = true;
    save(r);
    return { photoDeleted: true, rendersLeft: 0 };
  },
  async wishMetal(t, itemId) {
    const r = find((x) => x.recipientToken === t);
    if (!r.wishes.includes(itemId)) r.wishes.push(itemId);
    save(r);
  },
  async finish(t) {
    const r = find((x) => x.recipientToken === t);
    r.status = "completed";
    save(r);
    const res: DoneResponse = {
      photosDeleted: true,
      photosStored: 0,
      completedAt: new Date().toISOString(),
    };
    return res;
  },
  async setUndertone(t, value) {
    const r = find((x) => x.recipientToken === t);
    r.override = value;
    save(r);
  },
};
