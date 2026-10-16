import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";
import { buildVersion } from "../version";

afterEach(() => vi.unstubAllEnvs());

const SECRET_ENV = {
  YOUCAM_API_KEY: "sk-test-youcam-0123456789",
  ANTHROPIC_API_KEY: "sk-ant-test-0123456789",
  GIFTFIT_URL_SIGNING_SECRET: "signing-secret-test-0123456789",
  FIT_DECOY_SECRET: "decoy-secret-test-0123456789",
  CRON_SECRET: "cron-secret-test-0123456789",
};

describe("GET /api/health", () => {
  it("reports mock mode, the committed demo and no paid calls by default", async () => {
    vi.stubEnv("YOUCAM_MOCK", "1");
    vi.stubEnv("YOUCAM_ALLOW_PAID", "0");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["demoAvailable", "mock", "ok", "paidCallsEnabled", "version"]);
    expect(body).toMatchObject({ ok: true, mock: true, demoAvailable: true, paidCallsEnabled: false });
  });

  it("says paid calls are enabled only with YOUCAM_ALLOW_PAID=1 and a key, and never echoes a secret", async () => {
    for (const [k, v] of Object.entries(SECRET_ENV)) vi.stubEnv(k, v);
    vi.stubEnv("YOUCAM_MOCK", "");
    vi.stubEnv("YOUCAM_ALLOW_PAID", "1");
    const res = await GET();
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ mock: false, paidCallsEnabled: true });
    for (const v of Object.values(SECRET_ENV)) expect(text).not.toContain(v);

    vi.stubEnv("YOUCAM_API_KEY", "");
    expect(await (await GET()).json()).toMatchObject({ paidCallsEnabled: false });
  });

  it("stays up with a malformed YOUCAM_* number and reports the safe values", async () => {
    vi.stubEnv("YOUCAM_ALLOW_PAID", "1");
    vi.stubEnv("YOUCAM_MOCK", "0");
    vi.stubEnv("YOUCAM_RESERVE_UNITS", "lots");
    const body = await (await GET()).json();
    expect(body).toMatchObject({ ok: true, mock: true, paidCallsEnabled: false });
  });
});

describe("buildVersion", () => {
  it("appends the Cloud Run revision or GIT_SHA, sanitised", () => {
    expect(buildVersion({})).toMatch(/^\d+\.\d+\.\d+$/);
    expect(buildVersion({ K_REVISION: "giftfit-00012-abc" })).toMatch(/\+giftfit-00012-abc$/);
    expect(buildVersion({ GIT_SHA: "abc123 <script>" })).toMatch(/\+abc123script$/);
  });
});
