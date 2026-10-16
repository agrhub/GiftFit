/**
 * Seeded judge demo (owner: A5; MASTER_PLAN §8, ADR-030/037). Judges try GiftFit without a selfie and
 * without spending units: each seed creates a FRESH Fit Request for an AI-generated model from the
 * committed showcase fixtures (fixtures/youcam/ai-demo/showcase), already consented and captured:
 *   - profile: the subject's recorded Facial Color Tones + Face Attributes through jewelryRules
 *     (estimate and face shape only; the hex is never stored);
 *   - try-ons: `fixture:` result refs to the committed JPEGs, served by the same signed, session-bound
 *     route as real renders; metals with a fixture render from it, others say `demo_metal_unavailable`;
 *   - never a YouCam call. Capture is refused on demo requests.
 * Rate limit: lib/privacy/rate-limit.ts ("demo_seed", trusted client IP from client-ip.ts).
 * Demo requests are flagged `demo` (memory: a separate map, so lib/metrics never counts them).
 * "Delete" on a demo request revokes its rows and URLs; the committed files are never touched.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import aurumCatalog from "@/data/aurum/catalog.json";
import type { DemoSeedResponse, DemoSubject } from "@/lib/contracts/api";
import type { CatalogSku, FaceShape, FacialColors, JewelryRules } from "@/lib/contracts/giftfit";
import { FACE_SHAPES } from "@/lib/contracts/giftfit";
import { selectDecoys } from "@/lib/fit/decoys";
import { jewelryRules } from "@/lib/verticals/jewelry";
import { resolveCarousel } from "./carousel";
import type { PrivacyDeps } from "./deps";
import { fixtureRenderRef, parseFixtureRef } from "./renders";
import type { FitRequestRecord, TryOnRecord } from "./repos/types";
import { fitRequestExpiresAt, newFitRequestTokens } from "./tokens";

export const DEMO_LABEL = "AI-generated model" as const;
export const DEMO_SUBJECTS: readonly DemoSubject[] = ["showcase-latina-medium-warm", "showcase-black-deep-warm", "showcase-man-lightmed-neutral"];
export const DEFAULT_DEMO_SUBJECT: DemoSubject = "showcase-latina-medium-warm";
/** Seeds per client IP per hour: lib/privacy/rate-limit.ts RATE_LIMITS.demo_seed. */
export const DEMO_SEEDS_PER_HOUR = 10;

/**
 * The man's fixtures are men's gifts (ADR-037: Ashford watch on a wrist-centred AI hand photo, two
 * chains), so he gets a men's carousel: these picks, a cap that fits the watch, decoys from lib/fit
 * selectDecoys with a fixed seed. Decoys have no fixture render and show `demo_metal_unavailable`.
 */
export const MEN_DEMO = {
  subject: "showcase-man-lightmed-neutral" as DemoSubject,
  seed: "giftfit-judge-demo-men-v1",
  occasion: "birthday",
  budgetMax: 600,
  currency: "USD",
  picks: ["AUR-WCH-002", "AUR-NEC-033", "AUR-NEC-032"],
};

export function demoRoot(): string {
  return path.join(process.cwd(), "fixtures", "youcam", "ai-demo", "showcase");
}

interface DemoManifest {
  label: string;
  demo: { request: { occasion: string; budgetMax: number; currency: string; metalLock: null | string[] }; picks: string[]; decoys: string[] };
  subjects: Record<string, { faceShape: string; tryons: Record<string, string>; handPhoto?: string }>;
}

let manifestMemo: Promise<DemoManifest> | undefined;
export function loadDemoManifest(): Promise<DemoManifest> {
  manifestMemo ??= fs.readFile(path.join(demoRoot(), "manifest.json"), "utf8").then((s) => JSON.parse(s) as DemoManifest);
  return manifestMemo;
}

const bySku = new Map((aurumCatalog as unknown as CatalogSku[]).map((s) => [String(s.attributes.sku), s]));
const byId = new Map((aurumCatalog as unknown as CatalogSku[]).map((s) => [s.id, s]));

/** Reads a committed fixture JPEG for a `fixture:` ref; undefined if the ref or file is not valid. */
export async function readFixtureImage(ref: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
  const f = parseFixtureRef(ref);
  if (!f || !(DEMO_SUBJECTS as readonly string[]).includes(f.subject)) return undefined;
  const root = demoRoot();
  const file = path.resolve(root, f.subject, "tryons", f.file);
  if (!file.startsWith(path.resolve(root) + path.sep)) return undefined;
  try {
    return { bytes: new Uint8Array(await fs.readFile(file)), contentType: "image/jpeg" };
  } catch {
    return undefined;
  }
}

export const isFixtureRow = (r: Pick<TryOnRecord, "resultRef">) => Boolean(parseFixtureRef(r.resultRef));

/** True for a seeded demo request (flag in memory; fixture try-on rows in any store). */
export async function isDemoRequest(deps: PrivacyDeps, request: FitRequestRecord): Promise<boolean> {
  if (request.demo) return true;
  return (await deps.repos.tryons.listForRequest(request.id)).some(isFixtureRow);
}

/** The subject of a demo request, from its fixture rows. */
export function demoSubjectOf(rows: readonly TryOnRecord[]): DemoSubject | undefined {
  for (const r of rows) {
    const f = parseFixtureRef(r.resultRef);
    if (f) return f.subject as DemoSubject;
  }
  return undefined;
}

/** Fixture file for one design in one metal, if the subject has it. */
export async function fixtureFileFor(subject: DemoSubject, catalogId: string, metal: string): Promise<string | undefined> {
  const m = await loadDemoManifest();
  const sku = byId.get(catalogId)?.attributes.sku;
  return sku ? m.subjects[subject]?.tryons[`${String(sku)}-${metal}`]?.replace(/^tryons\//, "") : undefined;
}

async function readFixtureJson<T>(subject: DemoSubject, feature: string): Promise<T> {
  const raw = JSON.parse(await fs.readFile(path.join(demoRoot(), subject, `${feature}.json`), "utf8")) as { response: { data: { results: T } } };
  return raw.response.data.results;
}

export class DemoError extends Error {
  constructor(
    readonly status: 400 | 429 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface SeedDemoInput {
  subject?: unknown;
  /** Defaults to A10's jewelryRules (lib/verticals/jewelry.ts). */
  rules?: Pick<JewelryRules, "estimateUndertone">;
}

export async function seedDemoRequest(deps: PrivacyDeps, input: SeedDemoInput): Promise<DemoSeedResponse> {
  const subject = (input.subject ?? DEFAULT_DEMO_SUBJECT) as DemoSubject;
  if (!(DEMO_SUBJECTS as readonly unknown[]).includes(subject)) throw new DemoError(400, "unknown_subject");
  const manifest = await loadDemoManifest();
  const ids = (codes: string[]) =>
    codes.map((c) => {
      const sku = bySku.get(c);
      if (!sku) throw new DemoError(503, "demo_catalog_mismatch");
      return sku.id;
    });
  const men = subject === MEN_DEMO.subject;
  const plan = men
    ? { occasion: MEN_DEMO.occasion, budgetMax: MEN_DEMO.budgetMax, currency: MEN_DEMO.currency, shortlistIds: ids(MEN_DEMO.picks), decoyIds: [] as string[] }
    : { ...manifest.demo.request, shortlistIds: ids(manifest.demo.picks), decoyIds: ids(manifest.demo.decoys) };
  if (men) {
    const all = aurumCatalog as unknown as CatalogSku[];
    const shortlist = plan.shortlistIds.map((id) => byId.get(id)!);
    plan.decoyIds = selectDecoys(shortlist, all, { seed: MEN_DEMO.seed, request: { budgetMax: plan.budgetMax, currency: plan.currency } }).decoyIds;
  }
  const { shortlistIds, decoyIds } = plan;

  const now = deps.now();
  const tokens = newFitRequestTokens();
  const request = await deps.repos.fitRequests.create({
    storeId: null,
    giverTokenHash: tokens.giverTokenHash,
    recipientTokenHash: tokens.recipientTokenHash,
    occasion: plan.occasion,
    budgetMin: null,
    budgetMax: plan.budgetMax,
    currency: plan.currency,
    shortlistIds,
    decoyIds,
    metalLock: null,
    demo: true,
    status: "tried_on",
    createdAt: now,
    expiresAt: fitRequestExpiresAt(now),
  });

  try {
    // Profile: estimate and face shape from the recorded results; the hex stays in the fixture file.
    const tones = await readFixtureJson<{ color: FacialColors }>(subject, "skin-tone-analysis");
    const attrs = await readFixtureJson<{ faceshape?: string }>(subject, "face-attr-analysis");
    const est = (input.rules ?? jewelryRules).estimateUndertone(tones.color);
    const shape = (FACE_SHAPES as readonly string[]).includes(attrs.faceshape ?? "") ? (attrs.faceshape as FaceShape) : "Unknown";
    await deps.repos.profiles.upsert({
      fitRequestId: request.id,
      undertoneEstimate: est.undertone,
      undertoneConfidence: est.confidence,
      undertoneOverride: null,
      faceShape: shape,
      // The man's watch render used an AI back-of-hand photo (manifest handPhoto); nothing is stored.
      hasHandCapture: Boolean(manifest.subjects[subject] && "handPhoto" in manifest.subjects[subject]),
      consentAt: now,
      expiresAt: request.expiresAt,
    });

    // Pre-captured try-ons: each design's default metal if the subject has it, else a visible metal it has.
    const carousel = await resolveCarousel(deps, request);
    for (const item of carousel) {
      const ordered = [item.defaultSwatch, ...item.swatches.filter((s) => !s.isDefault)];
      let placed = false;
      for (const s of ordered) {
        const file = await fixtureFileFor(subject, item.sku.id, s.variant.metal);
        if (!file) continue;
        await deps.repos.tryons.insert({
          fitRequestId: request.id,
          catalogId: item.sku.id,
          feature: `2d-vto/${item.sku.category}`,
          taskId: null,
          cacheKey: `demo-${createHash("sha256").update(s.variant.variantId).digest("hex").slice(0, 24)}`,
          resultRef: fixtureRenderRef(subject, file, "d", s.variant.variantId, request.expiresAt.getTime()),
          status: "success",
          unitsCharged: 0,
          expiresAt: request.expiresAt,
        });
        placed = true;
        break;
      }
      if (!placed && shortlistIds.includes(item.sku.id)) throw new DemoError(503, "demo_fixture_missing");
    }
  } catch (err) {
    // Never leave a half-seeded demo behind.
    await deps.repos.deleteRecipientData(request.id);
    await deps.repos.fitRequests.setStatus(request.id, "deleted");
    throw err;
  }

  return {
    recipientPath: `/r/${tokens.recipientToken}`,
    giverReportPath: `/g/${tokens.giverToken}`,
    expiresAt: request.expiresAt.toISOString(),
    subject,
    label: DEMO_LABEL,
  };
}
