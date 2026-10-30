import { timingSafeEqual } from "node:crypto";

/** Bearer-token check for the ingest API (INGEST_ADMIN_TOKEN). No token configured → open. */
export function authorised(req: Request, token: string | undefined): boolean {
  if (!token) return true;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
