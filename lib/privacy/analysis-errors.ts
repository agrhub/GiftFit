/**
 * Why YouCam refused a selfie, from the failed task's message, so the recipient gets a hint they can act on instead of
 * "we couldn't read that photo" (ADR-058: "The face is tilted too far downward for accurate analysis. Slightly tilt
 * head upwards and try again."). A refused task is refunded; the recipient simply retakes the photo.
 */
import { YoucamTaskError } from "@/lib/youcam/errors";

export type AnalysisFailure = "analysis_failed" | "face_angle" | "face_not_found" | "photo_quality";

export function analysisFailureCode(err: unknown): AnalysisFailure {
  if (!(err instanceof YoucamTaskError)) return "analysis_failed";
  const m = `${err.message} ${err.engineError ?? ""}`.toLowerCase();
  if (/tilt|angle|frontal|head pose|head position|turn your head|rotate|look straight|facing the camera/.test(m)) return "face_angle";
  if (/no face|face not (found|detected)|(cannot|can't|unable to) (find|detect)[^.]*face|multiple faces|more than one face/.test(m)) return "face_not_found";
  if (/light|dark|bright|blur|resolution|too small|occlu/.test(m)) return "photo_quality";
  return "analysis_failed";
}

/** A log line for a refused analysis: the task's feature and YouCam's message (no photo data, no tokens). */
export function analysisFailureLog(err: unknown): string {
  if (err instanceof YoucamTaskError) return `${analysisFailureCode(err)} feature=${err.feature} engine=${err.engineError ?? "-"} message=${JSON.stringify(err.message.slice(0, 200))}`;
  const e = err as { reason?: string; code?: string; constructor?: { name?: string } };
  return `analysis_failed ${e?.reason ?? e?.code ?? e?.constructor?.name ?? "unknown"}`;
}
