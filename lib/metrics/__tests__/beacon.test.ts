// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveRequest } from "@/components/gift/savedRequests";
import { giverTokenFromPath, recordGiftPurchases } from "../purchase-beacon";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

afterEach(() => window.localStorage.clear());

describe("purchase beacon", () => {
  it("extracts the giver token from a saved report path only", () => {
    expect(giverTokenFromPath(`/g/${TOKEN}`)).toBe(TOKEN);
    expect(giverTokenFromPath(`/r/${TOKEN}`)).toBeUndefined();
    expect(giverTokenFromPath("/g/short")).toBeUndefined();
  });

  it("posts the bought ids once per saved Fit Request, and nothing without one", () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    recordGiftPurchases(["a"], fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();

    saveRequest({ giverReportPath: `/g/${TOKEN}`, recipientPath: "/r/x", expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: new Date().toISOString(), occasion: "birthday", titles: [] });
    recordGiftPurchases(["a", "b", "a"], fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/retailer/purchase");
    expect(JSON.parse(init.body as string)).toEqual({ giverToken: TOKEN, skuIds: ["a", "b"] });
    expect(init.keepalive).toBe(true);
  });

  it("never throws", () => {
    saveRequest({ giverReportPath: `/g/${TOKEN}`, recipientPath: "/r/x", expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: new Date().toISOString(), occasion: "birthday", titles: [] });
    expect(() => recordGiftPurchases(["a"], (() => { throw new Error("boom"); }) as unknown as typeof fetch)).not.toThrow();
  });
});
