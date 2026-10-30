/**
 * Process-wide state for server/privacy (owner: A5), kept on `globalThis` under a namespaced symbol.
 *
 * Next.js compiles each route into its own bundle, so a module-level `let` exists once PER ROUTE:
 * /api/recipient/capture and /api/recipient/tryon/[id] would get different dev signing secrets,
 * photo stores and in-memory repositories (A4 hit exactly this in P3: 403, then 404). Everything
 * that must be shared across routes in one process lives here instead.
 */
import type { PrivacyDeps } from "./deps";
import type { MemoryPhotoStore } from "./photo-store";
import type { MemoryPrivacyRepos } from "./repos/memory";

export const PRIVACY_STATE_KEY = Symbol.for("giftfit.privacy.state.v1");

export interface PrivacyGlobalState {
  /** Random per-process signing secret used only when GIFTFIT_URL_SIGNING_SECRET is unset outside production. */
  devSigningSecret?: string;
  devSecretWarned?: boolean;
  memoryRepos?: MemoryPrivacyRepos;
  memoryPhotos?: MemoryPhotoStore;
  defaults?: Promise<PrivacyDeps>;
  override?: PrivacyDeps;
}

export function privacyState(): PrivacyGlobalState {
  const g = globalThis as typeof globalThis & { [PRIVACY_STATE_KEY]?: PrivacyGlobalState };
  return (g[PRIVACY_STATE_KEY] ??= {});
}

/** Test helper: forget every process-wide default (the next call rebuilds them). */
export function resetPrivacyState(): void {
  const g = globalThis as typeof globalThis & { [PRIVACY_STATE_KEY]?: PrivacyGlobalState };
  delete g[PRIVACY_STATE_KEY];
}
