/**
 * GET /api/retailer/metrics?store=aurum&data=all|real (owner: A6). The Retailer Console snapshot:
 * funnel, hearted→bought, Undertone Coverage, Return-Risk inputs and k-anonymous mixes. Aggregates
 * only; synthetic demo requests are counted separately and labelled.
 */
import { handleMetrics } from "@/lib/metrics/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleMetrics(req);
}
