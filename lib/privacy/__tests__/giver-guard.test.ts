import { describe, expect, it, vi } from "vitest";
import type { FitResult } from "@/lib/contracts/giftfit";
import { GiverLeakError, assertGiverSafe, findGiverLeaks, giverJson } from "../giver-guard";

const report: { items: FitResult[]; hearted: number; status: string } = {
  status: "completed",
  hearted: 2,
  items: [
    {
      skuId: "8f4c2a10-0000-4000-8000-000000000001",
      score: 94,
      breakdown: { hearts: 50, metal: 20, style: 16, budgetOccasion: 8 },
      reasons: ["They loved it.", "Warm undertone estimate suits yellow gold.", "Oval face: drop earrings flatter."],
      caution: "Long drops can catch on scarves.",
    },
  ],
};

const leaksOf = (p: unknown, opts = {}) => findGiverLeaks(p, opts).map((l) => `${l.path}|${l.rule}`);

describe("assertGiverSafe", () => {
  it("passes a Fit Report with scores, reasons and hearts", () => {
    expect(findGiverLeaks(report)).toEqual([]);
    expect(assertGiverSafe(report)).toBe(report);
  });

  it.each([
    ["skin_color key", { skin_color: "#c68e6b" }, "$.skin_color|forbidden_key"],
    ["colors object", { colors: { skin: "x" } }, "$.colors|forbidden_key"],
    ["hex in a reason string", { reasons: ["Your skin #C68E6B is warm"] }, "$.reasons[0]|hex_color"],
    ["8-digit hex", { note: "tone #c68e6bff" }, "$.note|hex_color"],
    ["CIELAB object under an innocent key", { x: { L: 61.2, a: 14.1, b: 21.3 } }, "$.x|lab_values"],
    ["lab key", { lab: [61, 14, 21] }, "$.lab|forbidden_key"],
    ["hue angle", { hueDeg: 56 }, "$.hueDeg|forbidden_key"],
    ["structured undertone", { undertoneEstimate: "warm" }, "$.undertoneEstimate|forbidden_key"],
    ["face shape key", { faceShape: "Oval" }, "$.faceShape|forbidden_key"],
    ["raw API faceshape key", { result: { faceshape: "Oval" } }, "$.result.faceshape|forbidden_key"],
    ["cheekbones", { cheekbones: "high" }, "$.cheekbones|forbidden_key"],
    ["face attributes inside arrays", { items: [{ noseWidth: "narrow" }] }, "$.items[0].noseWidth|forbidden_key"],
    ["selfie key", { selfieUrl: "x" }, "$.selfieUrl|forbidden_key"],
    ["resultRef key", { resultRef: "store:tryon/x/tryon-1-a" }, "$.resultRef|forbidden_key"],
    ["signed try-on path", { a: "/api/recipient/tryon/1?exp=1&sig=x" }, "$.a|recipient_image"],
    ["vercel blob URL", { a: "https://abc.private.blob.vercel-storage.com/tryon/x.png" }, "$.a|recipient_image"],
    ["YouCam result URL", { a: "https://yce-api-01.makeupar.com/result/abc" }, "$.a|recipient_image"],
    ["data URI", { a: "data:image/png;base64,AAAA" }, "$.a|recipient_image"],
    ["photo store reference", { a: "store:recipient/req/selfie-1-x" }, "$.a|recipient_image"],
    ["image URL on a report", { picture2: "https://cdn.example.com/p/1.jpg" }, "$.picture2|forbidden_key"],
    ["bare image URL", { link: "https://cdn.example.com/p/1.webp?w=200" }, "$.link|image_url"],
    ["fitzpatrick", { fitzpatrick: "V" }, "$.fitzpatrick|forbidden_key"],
  ])("flags %s", (_name, payload, expected) => {
    expect(leaksOf(payload)).toContain(expected);
    expect(() => assertGiverSafe(payload)).toThrow(GiverLeakError);
  });

  it("allows product images only on catalog routes and only under product image keys", () => {
    const sku = { id: "s1", title: "Halo Drop", images: ["/catalog/halo-drop.png"], attributes: { vto_image: "/catalog/halo-drop-vto.png", metal: "yellow_gold" } };
    expect(leaksOf(sku)).toEqual(["$.images[0]|image_url", "$.attributes.vto_image|image_url"]);
    expect(leaksOf(sku, { allowProductImages: true })).toEqual([]);
    expect(leaksOf({ caption: "/catalog/x.png" }, { allowProductImages: true })).toEqual(["$.caption|image_url"]);
    // Recipient imagery is refused even under a product key on a catalog route.
    expect(leaksOf({ images: ["/api/recipient/tryon/1?exp=1&sig=2"] }, { allowProductImages: true })).toEqual(["$.images[0]|recipient_image"]);
  });

  it("handles cycles and primitives", () => {
    const a: Record<string, unknown> = { score: 1 };
    a.self = a;
    expect(findGiverLeaks(a)).toEqual([]);
    expect(findGiverLeaks(null)).toEqual([]);
    expect(findGiverLeaks("#ffffff")).toHaveLength(1);
  });
});

describe("giverJson", () => {
  it("returns the payload, never cached, when safe", async () => {
    const res = giverJson(report, { status: 200 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual(report);
  });

  it("fails closed with a 500 that does not echo the payload", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = giverJson({ ...report, skin_color: "#c68e6b" });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("c68e6b");
    expect(body).toContain("internal_error");
    expect(String(err.mock.calls[0])).not.toContain("c68e6b");
  });
});

describe("recipientLabels (GiverReportStatus) vocabulary", () => {
  it("allows every vocabulary label at exactly the two contract paths", async () => {
    const { GIVER_FACE_SHAPE_LABELS, GIVER_UNDERTONE_LABELS, giverFaceShapeLabel, giverUndertoneLabel } = await import("../labels");
    expect(GIVER_UNDERTONE_LABELS.size).toBe(9);
    expect(GIVER_FACE_SHAPE_LABELS.size).toBeGreaterThanOrEqual(7);
    for (const undertone of GIVER_UNDERTONE_LABELS) expect(findGiverLeaks({ status: "completed", recipientLabels: { undertone } })).toEqual([]);
    for (const faceShape of GIVER_FACE_SHAPE_LABELS) expect(findGiverLeaks({ recipientLabels: { faceShape } })).toEqual([]);
    expect(giverUndertoneLabel("warm")).toBe("Warm undertone estimate");
    expect(giverUndertoneLabel("cool", { override: true })).toBe("Cool undertone (their choice)");
    expect(giverUndertoneLabel("neutral", { lowConfidence: true })).toBe("Neutral undertone estimate (low confidence)");
    expect(giverFaceShapeLabel("Oval")).toBe("Oval face shape estimate");
    expect(giverFaceShapeLabel("Unknown")).toBeUndefined();
    expect(findGiverLeaks({ ...report, recipientLabels: { undertone: "Warm undertone estimate", faceShape: "Oval face shape estimate" } })).toEqual([]);
  });

  it("giverRecipientLabels emits only vocabulary labels, gender-neutral when overridden", async () => {
    const { giverRecipientLabels } = await import("../labels");
    const shapes = ["Oval", "Round", "Square", "Heart", "InvTriangle", "Oblong", "Diamond", "Triangle", "Unknown"] as const;
    for (const faceShape of shapes)
      for (const undertoneEstimate of ["warm", "neutral", "cool"] as const)
        for (const undertoneConfidence of [0, 0.2, 0.9])
          for (const undertoneOverride of [undefined, "warm" as const, "neutral" as const, "cool" as const]) {
            const labels = giverRecipientLabels({ undertoneEstimate, undertoneConfidence, undertoneOverride, faceShape, heartedSkuIds: [] });
            expect(findGiverLeaks({ recipientLabels: labels }), JSON.stringify(labels)).toEqual([]);
            if (undertoneOverride) expect(labels?.undertone).toBe(`${undertoneOverride[0].toUpperCase()}${undertoneOverride.slice(1)} undertone (their choice)`);
            else if (undertoneConfidence === 0) expect(labels?.undertone).toBeUndefined();
            else expect(labels?.undertone).toMatch(/undertone estimate/);
          }
    expect(giverRecipientLabels(null)).toBeUndefined();
    expect(giverRecipientLabels({ undertoneEstimate: "neutral", undertoneConfidence: 0.2, undertoneOverride: "warm", faceShape: "Oval", heartedSkuIds: [] })).toEqual({
      undertone: "Warm undertone (their choice)",
      faceShape: "Oval face shape estimate",
    });
  });

  it("accepts A3's estimate labels; a gendered override label is refused until lib/fit says '(their choice)'", async () => {
    const { recipientLabels } = await import("@/lib/fit/api");
    const shapes = ["Oval", "Round", "Square", "Heart", "InvTriangle", "Oblong", "Diamond", "Triangle", "Unknown"] as const;
    for (const faceShape of shapes)
      for (const undertoneEstimate of ["warm", "neutral", "cool"] as const)
        for (const undertoneConfidence of [0.2, 0.9])
          for (const undertoneOverride of [undefined, "cool" as const]) {
            const labels = recipientLabels({ undertoneEstimate, undertoneConfidence, undertoneOverride, faceShape, heartedSkuIds: [] });
            for (const leak of findGiverLeaks({ recipientLabels: labels })) {
              // Only lib/fit's gendered override string may fail (A3's reportJson then drops the label).
              expect(leak.path, JSON.stringify(labels)).toBe("$.recipientLabels.undertone");
              expect(labels?.undertone).toMatch(/undertone \(their choice\)$/);
            }
          }
  }, 60_000); // cold import of lib/fit (SDK clients) is slow under parallel workers

  it("refuses gendered or unknown override strings", () => {
    for (const undertone of ["Cool undertone (her choice)", "Cool undertone (his choice)", "Prefers gold tones", "warm undertone (their choice)"]) {
      expect(findGiverLeaks({ recipientLabels: { undertone } }).length, undertone).toBeGreaterThan(0);
    }
  });

  it.each([
    ["hex", { undertone: "#c68e6b" }],
    ["hex inside a label", { undertone: "Warm undertone estimate #c68e6b" }],
    ["number", { undertone: 0.82 }],
    ["confidence text", { undertone: "Warm undertone estimate (confidence 0.82)" }],
    ["LAB object", { undertone: { L: 61, a: 14, b: 21 } }],
    ["free text", { faceShape: "faceAspectRatio 1.42" }],
    ["array", { faceShape: ["Oval face shape estimate"] }],
    ["lowercase variant", { undertone: "warm undertone estimate" }],
  ])("rejects %s under recipientLabels", (_n, labels) => {
    expect(findGiverLeaks({ recipientLabels: labels }).length).toBeGreaterThan(0);
  });

  it("allows the label keys nowhere else", () => {
    expect(leaksOf({ undertone: "Warm undertone estimate" })).toContain("$.undertone|forbidden_key");
    expect(leaksOf({ items: [{ recipientLabels: { undertone: "Warm undertone estimate" } }] })).toContain("$.items[0].recipientLabels.undertone|forbidden_key");
    expect(leaksOf({ recipientLabels: { undertoneConfidence: 0.8 } })).toContain("$.recipientLabels.undertoneConfidence|forbidden_key");
    expect(leaksOf({ recipientLabels: { skinHex: "#c68e6b" } }).length).toBeGreaterThan(0);
  });
});
