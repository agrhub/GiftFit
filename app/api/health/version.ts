import pkg from "@/package.json";

const packageVersion: string = pkg.version;

/** Package version, plus the Cloud Run revision (K_REVISION) or GIT_SHA when set, sanitised. */
export function buildVersion(env: Record<string, string | undefined> = process.env): string {
  const build = (env.K_REVISION || env.GIT_SHA || "").trim().replace(/[^\w.-]/g, "").slice(0, 64);
  return build ? `${packageVersion}+${build}` : packageVersion;
}
