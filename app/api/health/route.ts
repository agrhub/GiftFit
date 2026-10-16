/**
 * GET /api/health  (audience: internal; owner: A8)
 * Liveness/readiness for Cloud Run and the deploy smoke check (deploy/README.md).
 * Reports configuration flags only: never a key, a secret, a balance or any request data.
 *   ok               always true when the process answers
 *   mock             YouCam calls are mocked (no network to YouCam)
 *   demoAvailable    the committed AI-model demo fixtures are on disk (POST /api/demo/seed works, 0 units)
 *   paidCallsEnabled YOUCAM_ALLOW_PAID=1 and a YouCam key are set (the cost guard still applies)
 *   version          package version, plus the Cloud Run revision or GIT_SHA when set
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { loadYoucamConfig } from "@/lib/youcam/config";
import { buildVersion } from "./version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface HealthResponse {
  ok: true;
  mock: boolean;
  demoAvailable: boolean;
  paidCallsEnabled: boolean;
  version: string;
}

async function demoAvailable(): Promise<boolean> {
  try {
    await access(path.join(process.cwd(), "fixtures", "youcam", "ai-demo", "showcase", "manifest.json"));
    return true;
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  let mock = true;
  let paidCallsEnabled = false;
  try {
    const cfg = loadYoucamConfig();
    mock = cfg.mock;
    paidCallsEnabled = !cfg.mock && cfg.allowPaid && Boolean(cfg.apiKey);
  } catch {
    // A malformed YOUCAM_* number must not take the health check down; report the safe values.
  }
  const body: HealthResponse = { ok: true, mock, demoAvailable: await demoAvailable(), paidCallsEnabled, version: buildVersion() };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
