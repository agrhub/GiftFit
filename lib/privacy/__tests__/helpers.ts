/** Test stack: in-memory repos, memory photo store, recording YouCam purge port, fixed clock. */
import { vi } from "vitest";
import { aurumCatalogSource } from "../catalog";
import type { PrivacyDeps } from "../deps";
import { MemoryPhotoStore } from "../photo-store";
import { MemoryPrivacyRepos } from "../repos/memory";
import type { FitRequestRecord } from "../repos/types";
import { newFitRequestTokens } from "../tokens";

export const T0 = new Date("2026-10-20T12:00:00.000Z");

export interface TestStack {
  deps: PrivacyDeps;
  repos: MemoryPrivacyRepos;
  photos: MemoryPhotoStore;
  clock: { now: Date; advance(ms: number): void };
  deletedTasks: string[];
  purgedCacheKeys: string[];
  deleteTask: ReturnType<typeof vi.fn>;
}

export function makeStack(): TestStack {
  const clock = {
    now: new Date(T0),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const now = () => new Date(clock.now);
  const repos = new MemoryPrivacyRepos(now);
  const photos = new MemoryPhotoStore(now);
  const deletedTasks: string[] = [];
  const purgedCacheKeys: string[] = [];
  const deleteTask = vi.fn(async (id: string) => {
    deletedTasks.push(id);
  });
  const deps: PrivacyDeps = {
    repos,
    photos,
    youcam: {
      deleteTask,
      deleteCachedResult: async (key) => {
        purgedCacheKeys.push(key);
      },
    },
    signingSecret: "test-secret-test-secret-test-secret-0123456789",
    now,
    catalog: aurumCatalogSource(),
  };
  return { deps, repos, photos, clock, deletedTasks, purgedCacheKeys, deleteTask };
}

export const hex64 = (c: string) => c.repeat(64).slice(0, 64);

export interface SeededRequest {
  request: FitRequestRecord;
  giverToken: string;
  recipientToken: string;
  renderKeys: string[];
  tryOnIds: string[];
}

/**
 * A Fit Request with everything a recipient can leave behind: profile, analysis tasks,
 * two stored renders, hearts, a report, and a still-present selfie blob.
 */
export async function seedFullRequest(stack: TestStack, label = "a"): Promise<SeededRequest> {
  const tokens = newFitRequestTokens();
  const request = await stack.repos.fitRequests.create({
    storeId: null,
    giverTokenHash: tokens.giverTokenHash,
    recipientTokenHash: tokens.recipientTokenHash,
    occasion: "anniversary",
    budgetMin: 150,
    budgetMax: 300,
    currency: "USD",
    shortlistIds: [`sku-${label}-1`, `sku-${label}-2`],
    decoyIds: [`sku-${label}-3`, `sku-${label}-4`],
  });
  const { deps } = stack;
  await deps.repos.profiles.upsert({
    fitRequestId: request.id,
    undertoneEstimate: "warm",
    undertoneConfidence: 0.7,
    undertoneOverride: null,
    faceShape: "Oval",
    hasHandCapture: false,
    consentAt: deps.now(),
    expiresAt: request.expiresAt,
  });
  for (const [feature, n] of [
    ["skin-tone-analysis", "1"],
    ["face-attr-analysis", "2"],
  ] as const) {
    await deps.repos.tryons.insert({
      fitRequestId: request.id,
      catalogId: null,
      feature,
      taskId: `task-${label}-${feature}`,
      cacheKey: hex64(n + label.charCodeAt(0).toString(16)),
      resultRef: null,
      status: "success",
      unitsCharged: 0,
      expiresAt: request.expiresAt,
    });
  }
  const renderKeys: string[] = [];
  const tryOnIds: string[] = [];
  for (const i of [1, 2]) {
    const stored = await deps.photos.put({ fitRequestId: request.id, kind: "tryon", bytes: new Uint8Array([i, i, i]), contentType: "image/png" });
    renderKeys.push(stored.key);
    const row = await deps.repos.tryons.insert({
      fitRequestId: request.id,
      catalogId: `sku-${label}-${i}`,
      feature: "2d-vto/earring",
      taskId: `task-${label}-vto-${i}`,
      cacheKey: hex64(`${i}f${label.charCodeAt(0).toString(16)}`),
      resultRef: `store:${stored.key}`,
      status: "success",
      unitsCharged: 0,
      expiresAt: request.expiresAt,
    });
    tryOnIds.push(row.id);
  }
  // A selfie that somehow survived (e.g. a crashed capture) must still be removed.
  await deps.photos.put({ fitRequestId: request.id, kind: "selfie", bytes: new Uint8Array([9]), contentType: "image/jpeg" });
  await deps.repos.hearts.add(request.id, `sku-${label}-1`);
  await deps.repos.hearts.add(request.id, `sku-${label}-3`);
  await deps.repos.reports.upsert({ fitRequestId: request.id, items: [{ catalogId: `sku-${label}-1`, score: 94 }] });
  return { request, giverToken: tokens.giverToken, recipientToken: tokens.recipientToken, renderKeys, tryOnIds };
}

/** Real Aurum catalog ids (data/aurum/catalog.json). */
export const AURUM = {
  earrings: ["96b9bb0c-8b22-597e-837e-d90ee529f9b6", "0ace33fe-4801-5f52-a56c-462d2b2c97de", "7629cea5-9524-5ca3-b81f-6fdeab28fe7a"],
  necklaces: ["531e6037-9319-50bd-998f-e9ac230894cc", "265419a0-6730-5e4c-b0a3-58398c5ef1e3"],
  ring: "cf314b81-1877-5b7d-ac14-0cfc279508da",
};

/** A fresh Fit Request as A3's POST /api/fit/requests creates it: 3 shortlisted + 3 decoys from Aurum. */
export async function seedAurumRequest(stack: TestStack, opts: { shortlist?: string[]; decoys?: string[] } = {}) {
  const tokens = newFitRequestTokens();
  const request = await stack.repos.fitRequests.create({
    storeId: null,
    giverTokenHash: tokens.giverTokenHash,
    recipientTokenHash: tokens.recipientTokenHash,
    occasion: "anniversary",
    budgetMin: 30,
    budgetMax: 300,
    currency: "USD",
    shortlistIds: opts.shortlist ?? [AURUM.earrings[0], AURUM.necklaces[0], AURUM.ring],
    decoyIds: opts.decoys ?? [AURUM.earrings[1], AURUM.earrings[2], AURUM.necklaces[1]],
  });
  return { request, giverToken: tokens.giverToken, recipientToken: tokens.recipientToken };
}
