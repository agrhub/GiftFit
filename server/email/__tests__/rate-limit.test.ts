import { afterEach, describe, expect, it } from "vitest";
import { assertEmailRate, EmailRateLimitError, getEmailRateLimiter, MemoryEmailRateLimiter, setEmailRateLimiter, type EmailRateLimiter } from "../rate-limit";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);

afterEach(() => setEmailRateLimiter(undefined));

describe("MemoryEmailRateLimiter", () => {
  it("allows 5 sends per giver per hour, then 429 with Retry-After", async () => {
    const rl = new MemoryEmailRateLimiter();
    for (let i = 0; i < 5; i++) expect(await rl.take({ giverKey: "g1", ipKey: `ip${i}` }, T0 + i * 1000)).toEqual({ ok: true });
    const d = await rl.take({ giverKey: "g1", ipKey: "ipX" }, T0 + 10_000);
    expect(d).toEqual({ ok: false, scope: "email_giver", retryAfterSec: 3590 });
    // The oldest hit leaves the window after an hour.
    expect(await rl.take({ giverKey: "g1", ipKey: "ipX" }, T0 + HOUR + 1)).toEqual({ ok: true });
  });

  it("caps a giver at 20 per day even when spread across hours", async () => {
    const rl = new MemoryEmailRateLimiter();
    let n = 0;
    for (let h = 0; h < 4; h++) for (let i = 0; i < 5; i++) expect((await rl.take({ giverKey: "g", ipKey: `ip${n++}` }, T0 + h * HOUR + i)).ok).toBe(true);
    const d = await rl.take({ giverKey: "g", ipKey: "fresh" }, T0 + 5 * HOUR);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.scope).toBe("email_giver");
      expect(d.retryAfterSec).toBe(19 * 3600);
    }
  });

  it("allows 10 per IP per hour across givers", async () => {
    const rl = new MemoryEmailRateLimiter();
    for (let i = 0; i < 10; i++) expect((await rl.take({ giverKey: `g${i}`, ipKey: "ip" }, T0 + i)).ok).toBe(true);
    expect(await rl.take({ giverKey: "g-new", ipKey: "ip" }, T0 + 20)).toMatchObject({ ok: false, scope: "email_ip" });
    expect((await rl.take({ giverKey: "g-new", ipKey: "other-ip" }, T0 + 20)).ok).toBe(true);
  });

  it("a refused send burns no quota in the other bucket", async () => {
    const rl = new MemoryEmailRateLimiter();
    for (let i = 0; i < 10; i++) await rl.take({ giverKey: `g${i}`, ipKey: "busy-ip" }, T0);
    // g-victim is refused by the IP bucket five times...
    for (let i = 0; i < 5; i++) expect((await rl.take({ giverKey: "g-victim", ipKey: "busy-ip" }, T0 + 1)).ok).toBe(false);
    // ...and still has its full giver quota from another IP.
    for (let i = 0; i < 5; i++) expect((await rl.take({ giverKey: "g-victim", ipKey: "calm-ip" }, T0 + 2)).ok).toBe(true);
  });

  it("requires both keys", async () => {
    await expect(new MemoryEmailRateLimiter().take({ giverKey: "", ipKey: "x" })).rejects.toThrow();
  });
});

describe("assertEmailRate / swappable limiter", () => {
  it("throws a 429-style EmailRateLimitError", async () => {
    setEmailRateLimiter(new MemoryEmailRateLimiter({ email_giver: [{ limit: 1, windowMs: HOUR }], email_ip: [{ limit: 10, windowMs: HOUR }] }));
    await assertEmailRate({ giverKey: "g", ipKey: "i" }, T0);
    const err = await assertEmailRate({ giverKey: "g", ipKey: "i" }, T0 + 1).catch((e) => e);
    expect(err).toBeInstanceOf(EmailRateLimitError);
    expect(err.status).toBe(429);
    const res = (err as EmailRateLimitError).toResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(await res.json()).toEqual({ error: "rate_limited", scope: "email_giver" });
  });

  it("uses whatever implementation is installed (e.g. Firestore counters)", async () => {
    const calls: string[] = [];
    const fake: EmailRateLimiter = {
      async take(keys) {
        calls.push(keys.giverKey);
        return { ok: false, scope: "email_ip", retryAfterSec: 7 };
      },
    };
    setEmailRateLimiter(fake);
    expect(getEmailRateLimiter()).toBe(fake);
    await expect(assertEmailRate({ giverKey: "g", ipKey: "i" })).rejects.toMatchObject({ scope: "email_ip", retryAfterSec: 7 });
    expect(calls).toEqual(["g"]);
    setEmailRateLimiter(undefined);
    expect(getEmailRateLimiter()).toBeInstanceOf(MemoryEmailRateLimiter);
  });
});
