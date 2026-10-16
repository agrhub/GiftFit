import type { CapturePorts } from "./capture";
import type { CatalogSource } from "./catalog";
import type { PhotoStore } from "./photo-store";
import type { PrivacyRepos } from "./repos/types";

/** What A5 needs from lib/youcam: the free task-delete call and the SHA-256 result cache. */
export interface YoucamPurgePort {
  /** POST /s2s/v2.0/task/delete (lib/youcam YoucamClient.deleteTask; a no-op in mock mode). */
  deleteTask(taskId: string): Promise<void>;
  /** lib/youcam ResultCache.delete (Postgres youcam_results or files). */
  deleteCachedResult(cacheKey: string): Promise<void>;
  /**
   * Batch purge (A1's YoucamClient.purge, P3). Preferred when present; the two calls above are
   * the fallback. Task deletes that fail are reported, not thrown.
   */
  purge?(input: { cacheKeys: readonly string[]; taskIds: readonly string[] }): Promise<{ cacheKeysPurged: number; tasks: Array<{ taskId: string; ok: boolean }> }>;
}

export interface PrivacyDeps {
  repos: PrivacyRepos;
  photos: PhotoStore;
  youcam: YoucamPurgePort;
  signingSecret: string;
  now: () => Date;
  /** Product data for carousel items (Aurum JSON by default). */
  catalog: CatalogSource;
  /** YouCam side of capture; defaults to youcamCapturePorts(getYoucamClient()). Tests inject fakes. */
  capturePorts?: (baseUrl: string) => CapturePorts;
  /**
   * Whether capture/swatch calls can reach the paid YouCam API ("real") or are fixtures ("mock").
   * Mock is exempt from per-IP limits. Default runtime: getYoucamClient().mode; unset = "mock".
   */
  youcamMode?: () => "mock" | "real";
}
