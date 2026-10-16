import { describe, expect, it, vi } from "vitest";
import { YoucamApiError } from "../errors";
import { RateLimiter, backoffDelay, send, sendJson, sharedRateLimiter, type Transport } from "../http";
import { json } from "./fake-api";

const policy = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 };

function transport(responses: Array<Response | Error>): Transport & { sleeps: number[]; fetchMock: ReturnType<typeof vi.fn> } {
  const sleeps: number[] = [];
  const fetchMock = vi.fn(async () => {
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  });
  return { fetch: fetchMock, sleep: async (ms) => void sleeps.push(ms), retry: policy, random: () => 1, sleeps, fetchMock };
}

describe("backoffDelay", () => {
  it("grows exponentially up to the cap and honours Retry-After", () => {
    expect(backoffDelay(0, policy, null, () => 1)).toBe(100);
    expect(backoffDelay(0, policy, null, () => 0)).toBe(50);
    expect(backoffDelay(2, policy, null, () => 1)).toBe(400);
    expect(backoffDelay(10, policy, null, () => 1)).toBe(1000);
    expect(backoffDelay(0, policy, "0.25", () => 1)).toBe(250);
    expect(backoffDelay(0, policy, "60", () => 1)).toBe(1000);
    expect(backoffDelay(1, policy, "soon", () => 1)).toBe(200);
  });
});

describe("send", () => {
  const opts = { method: "POST" as const, url: "https://api.test/x", json: { a: 1 }, idempotent: false, endpoint: "POST /x" };

  it("retries 429 with backoff, then succeeds", async () => {
    const t = transport([json({}, 429), json({}, 429, { "retry-after": "2" }), json({ ok: true })]);
    await expect(sendJson(t, opts)).resolves.toEqual({ ok: true });
    expect(t.sleeps).toEqual([100, 1000]);
    const init = t.fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("gives up on 429 after maxRetries", async () => {
    const t = transport([json({}, 429), json({}, 429), json({}, 429), json({ error: "Too many requests" }, 429)]);
    await expect(send(t, opts)).rejects.toMatchObject({ status: 429, message: expect.stringContaining("Too many requests") });
    expect(t.sleeps).toHaveLength(3);
  });

  it("does not retry 5xx for non-idempotent requests", async () => {
    const t = transport([json({ error: "boom", error_code: "BadRequest" }, 500)]);
    const err = await send(t, opts).catch((e) => e);
    expect(err).toBeInstanceOf(YoucamApiError);
    expect(err).toMatchObject({ status: 500, code: "BadRequest", endpoint: "POST /x" });
  });

  it("retries 5xx and network errors for idempotent requests", async () => {
    const t = transport([json({}, 503), new Error("ECONNRESET"), new Response("ok", { status: 200 })]);
    const res = await send(t, { method: "GET", url: "https://api.test/y", idempotent: true, endpoint: "GET /y" });
    expect(await res.text()).toBe("ok");
    expect(t.sleeps).toHaveLength(2);
  });

  it("wraps network errors and non-JSON error bodies", async () => {
    const t1 = transport([new Error("offline")]);
    await expect(send(t1, opts)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("offline") });
    const t2 = transport([new Response("<html>", { status: 400, statusText: "Bad Request" })]);
    await expect(send(t2, opts)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("400 Bad Request") });
  });

  it("passes raw bodies through", async () => {
    const t = transport([new Response(null, { status: 200 })]);
    const body = new Uint8Array([1, 2]);
    await send(t, { method: "PUT", url: "https://u.test", body, headers: { "Content-Type": "image/png" }, idempotent: true, endpoint: "PUT" });
    expect((t.fetchMock.mock.calls[0][1] as RequestInit).body).toBe(body);
  });
});

describe("RateLimiter", () => {
  it("allows a burst, then paces to stay within limit per window", async () => {
    let now = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      now += ms;
    };
    const rl = new RateLimiter(250, 300_000, () => now, 20);
    for (let i = 0; i < 20; i++) await rl.acquire(sleep);
    expect(waits).toEqual([]);
    await rl.acquire(sleep);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBe(Math.ceil(300_000 / 230));
    // Over a long run the average rate never exceeds 250 / 300 s.
    for (let i = 0; i < 300; i++) await rl.acquire(sleep);
    expect(321 - 20).toBeLessThanOrEqual(Math.ceil((now / 300_000) * 230) + 1);
  });

  it("serves concurrent callers in order and is used by send()", async () => {
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now, 1);
    const order: number[] = [];
    const sleep = async (ms: number) => {
      now += ms;
    };
    await Promise.all([1, 2, 3].map((n) => rl.acquire(sleep).then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(now).toBeGreaterThanOrEqual(2000);

    const roomy = new RateLimiter(250, 300_000, () => now, 20);
    const acquire = vi.spyOn(roomy, "acquire");
    const t = { ...transport([json({}), new Response(null)]), limiter: roomy };
    await send(t, { method: "GET", url: "https://api.test/a", idempotent: true, endpoint: "GET /a" });
    await send(t, { method: "PUT", url: "https://s3.test/b", idempotent: true, endpoint: "PUT", rateLimited: false });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(sharedRateLimiter().limit).toBe(250);
    expect(sharedRateLimiter().windowMs).toBe(300_000);
    expect(sharedRateLimiter()).toBe(sharedRateLimiter());
  });
});
