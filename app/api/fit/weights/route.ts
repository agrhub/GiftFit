/** GET /api/fit/weights (public). The published Fit Score weights and Return-Risk formula. */
import { handleWeights } from "@/lib/fit/api";

export const runtime = "nodejs";

export function GET(): Response {
  return handleWeights();
}
