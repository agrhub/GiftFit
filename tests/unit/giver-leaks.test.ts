/**
 * The e2e leak scanner must actually fire: a scanner that never reports would make the giver
 * smoke tests vacuous. Synthetic payloads only (no real faces, no real hex from YouCam).
 */
import { describe, expect, it } from "vitest";
import { scanGiverResponse } from "../e2e/support/giver-leaks";

const scan = (payload: unknown, headers: Record<string, string> = {}) => scanGiverResponse(JSON.stringify(payload), headers);
const kinds = (payload: unknown) => scan(payload).map((l) => l.kind);

describe("scanGiverResponse", () => {
  it("passes a clean giver report", () => {
    expect(
      scan({
        requestId: "req_1",
        status: "ready",
        items: [{ skuId: "AUR-EAR-028", score: 82, breakdown: { hearts: 50, metal: 14 }, reasons: ["Hearted on try-on"], caution: "Estimate only" }],
        weightsVersion: "fit-v1.0",
        disclaimer: "AI try-on preview. Undertone and face shape are estimates.",
        sources: ["https://nrf.com/research/2024-consumer-returns"],
      }),
    ).toEqual([]);
  });

  it.each([
    ["absolute image URL", { img: "https://cdn.example.com/a/b.jpg" }],
    ["root-relative image", { img: "/uploads/selfie.png?x=1" }],
    ["data URI", { img: "data:image/png;base64,AAAA" }],
    ["blob storage", { u: "https://abc.public.blob.vercel-storage.com/recipient/x" }],
    ["YouCam result", { u: "https://yce-api-01.makeupar.com/result/abc" }],
    ["signed try-on path", { u: "/api/recipient/tryon/t1?exp=1&sig=2" }],
    ["mock asset", { u: "/api/youcam/mock-asset/earring.png" }],
  ])("flags %s", (_name, payload) => {
    expect(kinds(payload)).toContain("image_url");
  });

  it("allows catalog product images only when the caller opts in", () => {
    const p = { productImage: "/catalog/aurum/aur-ear-028.png" };
    expect(kinds(p)).toContain("image_url");
    expect(scanGiverResponse(JSON.stringify(p), {}, { allowProductImagePrefixes: ["/catalog/"] })).toEqual([]);
  });

  it.each([
    ["#hex in text", { reason: "matches your #c58c6a skin" }],
    ["#rrggbbaa", { c: "#C58C6AFF" }],
    ["bare hex under a colour key", { skinColour: "c58c6a" }],
    ["bare hex under a tone key", { tone: "8D5524" }],
  ])("flags %s", (_name, payload) => {
    expect(kinds(payload)).toContain("hex_color");
  });

  it("does not mistake ids or hashes for colours", () => {
    expect(scan({ requestId: "c58c6a", skuId: "AUR-EAR-028", hash: "deadbeefcafe" })).toEqual([]);
  });

  it.each(["faceshape", "face_shape", "faceShape", "eyeShape", "lip-shape", "landmarks", "skin_color", "undertone", "undertoneConfidence", "fitzpatrick", "monk", "hueDeg", "selfie", "resultRef"])(
    "flags the face/analysis key %s at any depth",
    (key) => {
      expect(kinds({ items: [{ nested: { [key]: "Oval" } }] })).toContain("face_attribute");
    },
  );

  it("flags Set-Cookie on a giver response", () => {
    expect(scan({}, { "set-cookie": "gf_recipient=abc; Path=/" }).map((l) => l.kind)).toEqual(["header"]);
  });

  it("scans non-JSON bodies as text", () => {
    expect(scanGiverResponse("<img src=\"data:image/png;base64,AA\"> #a1b2c3", {}).map((l) => l.kind).sort()).toEqual(["hex_color", "image_url"]);
  });
});

describe("recipientLabels allowance (ADR-021)", () => {
  it("accepts only the fixed label strings at the two allowed paths", () => {
    const ok = JSON.stringify({ recipientLabels: { undertone: "Warm undertone estimate", faceShape: "Oval face shape estimate" } });
    expect(scanGiverResponse(ok, {})).toEqual([]);
    for (const bad of [
      { recipientLabels: { undertone: "#c08a6b" } },
      { recipientLabels: { undertone: 0.82 } },
      { recipientLabels: { undertone: "warm" } },
      { recipientLabels: { faceShape: { label: "Oval", ratio: 1.46 } } },
      { undertone: "Warm undertone estimate" },
    ]) {
      expect(scanGiverResponse(JSON.stringify(bad), {}).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});

describe("undertone label variants (ADR-031/032)", () => {
  it("accepts estimate, low-confidence estimate and their-choice labels only", () => {
    for (const label of ["Warm undertone estimate", "Neutral undertone estimate (low confidence)", "Cool undertone (their choice)"]) {
      expect(scanGiverResponse(JSON.stringify({ recipientLabels: { undertone: label } }), {})).toEqual([]);
    }
    for (const bad of ["Prefers gold tones", "Cool undertone (her choice)", "Warm undertone estimate low confidence", "Warm undertone estimate (0.2)"]) {
      expect(scanGiverResponse(JSON.stringify({ recipientLabels: { undertone: bad } }), {}).length, bad).toBeGreaterThan(0);
    }
  });
});
