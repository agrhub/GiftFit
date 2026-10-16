import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientIp, clientKey, trustedProxyHops, UNKNOWN_CLIENT } from "../client-ip";
import { resetPrivacyState } from "../global-state";
import { RATE_LIMITS, rateKeysForTests, rateLimitsEnabled, setRateLimitOverride, takeRate, takeRateFor } from "../rate-limit";

const req = (xff?: string) => new Request("http://x/", { headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
const ENV = { GIFTFIT_URL_SIGNING_SECRET: "s".repeat(40) };

beforeEach(() => resetPrivacyState());
afterEach(() => resetPrivacyState());

describe("trusted client IP", () => {
  it("uses the entry appended by the trusted proxy, never the left-most one", () => {
    expect(clientIp(req("203.0.113.9"), ENV)).toBe("203.0.113.9"); // direct *.run.app: GFE appended it
    expect(clientIp(req("6.6.6.6, 203.0.113.9"), ENV)).toBe("203.0.113.9"); // spoofed left-most ignored
    expect(clientIp(req("1.1.1.1, 2.2.2.2, 203.0.113.9"), ENV)).toBe("203.0.113.9");
    // Behind an external ALB the client is the second entry from the right.
    const alb = { ...ENV, GIFTFIT_TRUSTED_PROXY_HOPS: "2" };
    expect(clientIp(req("6.6.6.6, 203.0.113.9, 34.120.0.1"), alb)).toBe("203.0.113.9");
    expect(trustedProxyHops(alb)).toBe(2);
    expect(trustedProxyHops({ GIFTFIT_TRUSTED_PROXY_HOPS: "zero" })).toBe(1);
  });

  it("falls back to one shared 'unknown' bucket instead of trusting anything the client sent", () => {
    expect(clientIp(req(), ENV)).toBe(UNKNOWN_CLIENT);
    expect(clientIp(req(""), ENV)).toBe(UNKNOWN_CLIENT);
    expect(clientIp(req("203.0.113.9"), { ...ENV, GIFTFIT_TRUSTED_PROXY_HOPS: "2" })).toBe(UNKNOWN_CLIENT); // fewer entries than hops
    expect(clientIp(req("1.1.1.1, <script>"), ENV)).toBe(UNKNOWN_CLIENT);
    expect(clientIp(new Request("http://x/", { headers: { "x-real-ip": "9.9.9.9" } }), ENV)).toBe(UNKNOWN_CLIENT); // never trusted
  });

  it("keys are salted, scope-bound hashes with no raw IP", () => {
    const k = clientKey(req("203.0.113.9"), "capture", ENV);
    expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(k).not.toContain("203");
    expect(clientKey(req("203.0.113.9"), "swatch", ENV)).not.toBe(k);
    expect(clientKey(req("203.0.113.9"), "capture", { GIFTFIT_URL_SIGNING_SECRET: "t".repeat(40) })).not.toBe(k);
    expect(clientKey(req("203.0.113.9"), "capture", { ...ENV, GIFTFIT_IP_HASH_SALT: "dedicated-salt-0123456789" })).not.toBe(k);
    expect(clientKey(req("6.6.6.6, 203.0.113.9"), "capture", ENV)).toBe(k);
  });
});

describe("sliding windows", () => {
  const H = 60 * 60 * 1000;

  it("capture: 2 per hour, exact edges and Retry-After", () => {
    const t0 = 1_800_000_000_000;
    expect(takeRate("capture", "k", t0).ok).toBe(true);
    expect(takeRate("capture", "k", t0 + 10_000).ok).toBe(true);
    const no = takeRate("capture", "k", t0 + 20_000);
    expect(no).toEqual({ ok: false, retryAfterSec: (H - 20_000) / 1000 });
    expect(takeRate("capture", "k", t0 + H - 1).ok).toBe(false); // first hit still inside
    expect(takeRate("capture", "k", t0 + H).ok).toBe(true); // first hit just left the window
    expect(takeRate("capture", "other", t0 + 20_000).ok).toBe(true); // per key
  });

  it("capture: 4 per 24 h on top of the hourly limit", () => {
    const t0 = 1_800_000_000_000;
    for (const h of [0, 0, 1, 1]) expect(takeRate("capture", "k", t0 + h * H + (h ? 1 : 0)).ok).toBe(true);
    const fifth = takeRate("capture", "k", t0 + 5 * H);
    expect(fifth.ok).toBe(false);
    expect(fifth.retryAfterSec).toBe((24 * H - 5 * H) / 1000);
    expect(takeRate("capture", "k", t0 + 24 * H).ok).toBe(true);
  });

  it("swatch 8/h, fit_requests 10/h, demo_seed 10/h", () => {
    expect(RATE_LIMITS.swatch).toEqual([{ limit: 8, windowMs: H }]);
    expect(RATE_LIMITS.fit_requests).toEqual([{ limit: 10, windowMs: H }]);
    expect(RATE_LIMITS.demo_seed).toEqual([{ limit: 10, windowMs: H }]);
    for (let i = 0; i < 8; i++) expect(takeRate("swatch", "k", 1000 + i).ok).toBe(true);
    expect(takeRate("swatch", "k", 2000).ok).toBe(false);
  });

  it("is on in production, off under unit tests unless forced, and the dev switch is ignored in production", () => {
    expect(rateLimitsEnabled({ NODE_ENV: "production", GIFTFIT_RATE_LIMITS: "off" })).toBe(true);
    expect(rateLimitsEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(rateLimitsEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(rateLimitsEnabled({ NODE_ENV: "development", GIFTFIT_RATE_LIMITS: "off" })).toBe(false);
    setRateLimitOverride(true);
    expect(rateLimitsEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("only salted hashes are kept in memory", () => {
    setRateLimitOverride(true);
    takeRateFor(req("6.6.6.6, 203.0.113.9"), "capture", Date.now());
    const keys = rateKeysForTests();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^capture\|[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(keys)).not.toMatch(/203\.0\.113\.9|6\.6\.6\.6/);
  });
});
