/**
 * Owner-only real-credit recording switch (A16). Every "paid" call here goes to the in-memory FakeYoucamApi:
 * 0 units, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "../audit";
import { YoucamClient } from "../client";
import { CostGuardError } from "../errors";
import {
  clearRecordingCookie,
  isOwnerRecording,
  isValidPaidGrant,
  mintPaidGrant,
  paidReadiness,
  RECORDING_COOKIE,
  RECORDING_SESSION_MS,
  recordingCookie,
  recordingCookieValue,
  recordingEnabled,
  recordingSwitchOn,
  recordingTokenMatches,
  verifyRecordingCookieValue,
} from "../recording";
import { FakeYoucamApi } from "./fake-api";

const TOKEN = "owner-recording-token-0123456789-abcdefghij";
/** Everything a production deployment needs for a paid owner call (values are fakes). */
const READY = { YOUCAM_RECORDING: "on", GIFTFIT_RECORDING_TOKEN: TOKEN, YOUCAM_MOCK: "0", YOUCAM_ALLOW_PAID: "1", YOUCAM_API_KEY: "fake-key", STORE: "firestore" } as const;
const withCookie = (value: string) => ({ headers: new Headers({ cookie: `other=1; ${RECORDING_COOKIE}=${value}` }) });
const owner = (nowMs = Date.now()) => withCookie(recordingCookieValue(TOKEN, nowMs));
const face = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), contentType: "image/jpeg" as const };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the switch", () => {
  it("is off by default: no env → no recording, no paid readiness, nobody is the owner", () => {
    expect(recordingSwitchOn({})).toBe(false);
    expect(recordingEnabled({})).toBe(false);
    const r = paidReadiness({});
    expect(r).toMatchObject({ youcamPaid: false, recording: "off" });
    expect(r.blockers).toEqual(expect.arrayContaining(["recording_switch_off", "no_recording_token", "youcam_mock", "no_durable_counter"]));
    expect(isOwnerRecording(owner(), {})).toBe(false);
  });

  it("paid readiness needs every piece; each missing one is named", () => {
    expect(paidReadiness(READY)).toMatchObject({ youcamPaid: true, recording: "on", blockers: [], dailyUnitCap: 150, totalUnitCap: 300 });
    const without = (k: keyof typeof READY, v = "") => paidReadiness({ ...READY, [k]: v }).blockers;
    expect(without("YOUCAM_RECORDING", "off")).toEqual(["recording_switch_off"]);
    expect(without("GIFTFIT_RECORDING_TOKEN", "short")).toEqual(["no_recording_token"]);
    expect(without("YOUCAM_MOCK", "1")).toEqual(["youcam_mock", "no_daily_cap"]); // mock mode has no daily cap by default
    expect(without("YOUCAM_ALLOW_PAID", "0")).toEqual(["paid_not_allowed"]);
    expect(without("YOUCAM_API_KEY")).toEqual(["no_api_key"]);
    expect(without("STORE", "memory")).toEqual(["no_durable_counter"]);
    expect(paidReadiness({ ...READY, YOUCAM_DAILY_UNIT_CAP: "0" }).blockers).toEqual(["no_daily_cap"]);
    expect(paidReadiness({ ...READY, YOUCAM_DAILY_UNIT_CAP: "lots" }).blockers).toContain("config_error");
  });

  it("owner cookie: HMAC of the token, ≤ 6 h, wrong/expired/tampered/foreign values fail; switch off = nobody", () => {
    const now = Date.now();
    const v = recordingCookieValue(TOKEN, now);
    expect(verifyRecordingCookieValue(v, TOKEN, now)).toBe(true);
    expect(verifyRecordingCookieValue(v, TOKEN, now + RECORDING_SESSION_MS + 1)).toBe(false); // expired
    expect(verifyRecordingCookieValue(v, `${TOKEN}x`, now)).toBe(false); // rotated token
    expect(verifyRecordingCookieValue(v.replace(/.$/, (c) => (c === "A" ? "B" : "A")), TOKEN, now)).toBe(false); // tampered
    const far = now + 10 * RECORDING_SESSION_MS;
    expect(verifyRecordingCookieValue(`v1.${far}.${v.split(".")[2]}`, TOKEN, now)).toBe(false); // exp moved
    expect(verifyRecordingCookieValue(undefined, TOKEN, now)).toBe(false);
    const env = { YOUCAM_RECORDING: "on", GIFTFIT_RECORDING_TOKEN: TOKEN };
    expect(isOwnerRecording(owner(now), env, now)).toBe(true);
    expect(isOwnerRecording({ headers: new Headers() }, env, now)).toBe(false);
    expect(isOwnerRecording(owner(now), { ...env, YOUCAM_RECORDING: "off" }, now)).toBe(false);
  });

  it("token check is exact; cookies are HttpOnly, SameSite=None+Secure on https, cleared with Max-Age=0", () => {
    const env = { GIFTFIT_RECORDING_TOKEN: TOKEN };
    expect(recordingTokenMatches(TOKEN, env)).toBe(true);
    expect(recordingTokenMatches(` ${TOKEN} `, env)).toBe(true);
    expect(recordingTokenMatches(TOKEN.slice(1), env)).toBe(false);
    expect(recordingTokenMatches(undefined, env)).toBe(false);
    expect(recordingTokenMatches(TOKEN, {})).toBe(false);
    const c = recordingCookie(TOKEN, { secure: true });
    expect(c).toMatch(/^gf_rec=v1\.\d{13}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=None; Max-Age=21600$/);
    expect(c).not.toContain(TOKEN);
    expect(recordingCookie(TOKEN, { secure: false })).toContain("SameSite=Lax");
    expect(clearRecordingCookie({ secure: true })).toContain("Max-Age=0");
  });
});

describe("paid grants", () => {
  it("are minted only for an owner on a paid-ready deployment, and only registered objects count", () => {
    expect(mintPaidGrant(owner(), READY)).toBeDefined();
    expect(mintPaidGrant({ headers: new Headers() }, READY)).toBeUndefined(); // no owner cookie
    expect(mintPaidGrant(owner(), { ...READY, YOUCAM_MOCK: "1" })).toBeUndefined(); // not paid-ready
    expect(mintPaidGrant(owner(), { ...READY, YOUCAM_RECORDING: "off" })).toBeUndefined();
    const g = mintPaidGrant(owner(), READY)!;
    expect(isValidPaidGrant(g, Date.now(), READY)).toBe(true);
    expect(isValidPaidGrant({ ...g }, Date.now(), READY)).toBe(false); // a look-alike copy
    expect(isValidPaidGrant({ kind: "giftfit.youcam.paid-grant", exp: Date.now() + 1e6 }, Date.now(), READY)).toBe(false);
    expect(isValidPaidGrant(g, g.exp + 1, READY)).toBe(false); // expired
    expect(isValidPaidGrant(g, Date.now(), { ...READY, YOUCAM_RECORDING: "off" })).toBe(false); // switched off since
  });
});

describe("the shared client (requirePaidGrant): no grant, no paid task", () => {
  const client = (api: FakeYoucamApi, audit = new MemoryAuditSink()) =>
    new YoucamClient({
      requirePaidGrant: true,
      config: { mock: false, allowPaid: true, apiKey: "fake-key", baseUrl: "https://api.test", reserveUnits: 0, maxUnitsPerRun: 40, dailyUnitCap: 150, pollIntervalMs: 1, maxPolls: 3 },
      fetch: api.fetch,
      sleep: async () => {},
      audit,
      cache: null,
      limiter: null,
      dailyCounter: null,
      state: "isolated",
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    });

  it("without a grant (or with a forged one) every paid method refuses before ANY request to YouCam", async () => {
    vi.stubEnv("YOUCAM_RECORDING", "on");
    vi.stubEnv("GIFTFIT_RECORDING_TOKEN", TOKEN);
    const api = new FakeYoucamApi({ results: { "skin-tone-analysis": { color: { skin_color: "#aa8877" } } } });
    const audit = new MemoryAuditSink();
    const c = client(api, audit);
    const forged = { kind: "giftfit.youcam.paid-grant", exp: Date.now() + 60_000 } as never;
    for (const call of [
      () => c.facialColorTones(face),
      () => c.faceAttributes(face),
      () => c.jewelryVto("earring", face, { products: [{ url: "https://shop.test/e.png" }] }),
      () => c.facialColorTones(face, {}, { paidGrant: forged }),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(CostGuardError);
      expect((err as CostGuardError).reason).toBe("recording_off");
    }
    expect(api.calls).toEqual([]); // not even a free balance or price lookup
    expect(audit.events.filter((e) => e.decision === "refused" && e.reason === "recording_off")).toHaveLength(4);
  });

  it("with an owner grant the paid path is taken (here against the fake API) and logged without PII", async () => {
    for (const [k, v] of Object.entries(READY)) vi.stubEnv(k, v);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const api = new FakeYoucamApi({ runningPolls: 0, results: { "skin-tone-analysis": { color: { skin_color: "#aa8877" } } } });
    const g = mintPaidGrant(owner())!;
    const r = await client(api).facialColorTones(face, {}, { paidGrant: g });
    expect(r.result.color.skin_color).toBe("#aa8877");
    expect(api.callsTo("POST", /task\/skin-tone-analysis$/)).toHaveLength(1);
    const line = log.mock.calls.map((c) => String(c[0])).find((s) => s.includes("youcam paid call"))!;
    expect(JSON.parse(line)).toMatchObject({ severity: "NOTICE", paidMode: "on", feature: "skin-tone-analysis", units: 20 });
    expect(line).not.toMatch(/#aa8877|fake-key|owner-recording-token/);
  });

  it("mock mode never needs a grant (fixtures, 0 units)", async () => {
    const c = new YoucamClient({ requirePaidGrant: true, config: { mock: true }, audit: new MemoryAuditSink(), cache: null, state: "isolated" });
    expect((await c.facialColorTones(face)).mock).toBe(true);
  });
});
