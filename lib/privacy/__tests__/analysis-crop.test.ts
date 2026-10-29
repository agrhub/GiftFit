/**
 * The analyses read a face crop, the try-ons the full frame (ADR-025 design; ADR-058: the full selfie was refused as
 * "tilted too far downward", the crop of the same AI model had passed). A refused crop gets one full-frame retry.
 */
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { YoucamClient } from "@/lib/youcam/client";
import { CostGuardError, YoucamTaskError } from "@/lib/youcam/errors";
import type { ImageInput } from "@/lib/youcam/types";
import { analysisCrop, analysisCropBox } from "../analysis-crop";
import { youcamCapturePorts } from "../capture";

const jpeg = async (width: number, height: number) => new Uint8Array(await sharp({ create: { width, height, channels: 3, background: "#c68e6b" } }).jpeg().toBuffer());
const sizeOf = async (img: ImageInput) => ("bytes" in img ? sharp(img.bytes).metadata().then((m) => `${m.width}x${m.height}`) : "url");

describe("analysisCropBox", () => {
  it("cuts the guide's face region of a 3:4 selfie: face ~60% of the width, forehead to chin", () => {
    // The crop that passed for the hero AI model (ADR-037) was about x 190–710, y 110–710 of 896×1200.
    expect(analysisCropBox(896, 1200)).toEqual({ left: 179, top: 135, width: 538, height: 619 });
  });

  it("stays inside the frame and keeps the full frame when the photo is too small", () => {
    const b = analysisCropBox(1200, 700)!;
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.top + b.height).toBeLessThanOrEqual(700);
    expect(b.left + b.width).toBeLessThanOrEqual(1200);
    expect(analysisCropBox(500, 660)).toBeNull();
  });
});

describe("analysisCrop", () => {
  it("returns a JPEG of the crop box; undecodable bytes are an error the port turns into the full frame", async () => {
    const crop = await analysisCrop({ bytes: await jpeg(896, 1200) });
    expect(crop?.contentType).toBe("image/jpeg");
    expect(await sizeOf(crop!)).toBe("538x619");
    await expect(analysisCrop({ bytes: new Uint8Array([1, 2, 3]) })).rejects.toThrow();
  });
});

describe("youcamCapturePorts.analyze", () => {
  const UNITS: Record<string, number> = { "skin-tone-analysis": 20, "face-attr-analysis": 10 };
  const refused = (feature: string) => new YoucamTaskError("The face is tilted too far downward for accurate analysis.", feature, "t1");
  /** A fake client: `refuse(feature, isCrop)` decides which calls YouCam refuses; charged units count passed calls only (refused tasks are refunded). */
  const fakeClient = (refuse: (feature: string, crop: boolean) => Error | null) => {
    const calls: { feature: string; size: string }[] = [];
    let charged = 0;
    const task = (feature: string) => async (img: ImageInput) => {
      const size = await sizeOf(img);
      calls.push({ feature, size });
      const e = refuse(feature, size !== "896x1200");
      if (e) throw e;
      charged += UNITS[feature];
      return { feature, taskId: `t-${feature}`, cacheKey: `k-${feature}`, unitsCharged: UNITS[feature], result: { color: { skin_color: "#c68e6b" }, faceshape: "Oval" } };
    };
    const client = { facialColorTones: task("skin-tone-analysis"), faceAttributes: task("face-attr-analysis"), purge: vi.fn(async () => undefined) } as unknown as YoucamClient;
    return { client, calls, charged: () => charged };
  };
  const full = async () => ({ bytes: await jpeg(896, 1200), contentType: "image/jpeg" as const });
  const sent = (calls: { feature: string; size: string }[], feature: string) => calls.filter((c) => c.feature === feature).map((c) => c.size);

  it("analyses the face crop; the full frame is never sent when the crop passes (30 units)", async () => {
    const f = fakeClient(() => null);
    expect((await youcamCapturePorts(f.client).analyze(await full())).faceShape).toBe("Oval");
    expect(f.calls.map((c) => c.size)).toEqual(["538x619", "538x619"]);
    expect(f.charged()).toBe(30);
  });

  it("both halves refused on the crop: each runs once on the full frame (30 units)", async () => {
    const f = fakeClient((feature, crop) => (crop ? refused(feature) : null));
    await youcamCapturePorts(f.client).analyze(await full());
    expect(sent(f.calls, "skin-tone-analysis")).toEqual(["538x619", "896x1200"]);
    expect(sent(f.calls, "face-attr-analysis")).toEqual(["538x619", "896x1200"]);
    expect(f.charged()).toBe(30);
  });

  it.each(["skin-tone-analysis", "face-attr-analysis"])("split: only %s is refused on the crop, so only it runs on the full frame (30 units)", async (bad) => {
    const f = fakeClient((feature, crop) => (crop && feature === bad ? refused(feature) : null));
    await youcamCapturePorts(f.client).analyze(await full());
    const good = bad === "skin-tone-analysis" ? "face-attr-analysis" : "skin-tone-analysis";
    expect(sent(f.calls, good)).toEqual(["538x619"]);
    expect(sent(f.calls, bad)).toEqual(["538x619", "896x1200"]);
    expect(f.charged()).toBe(30);
  });

  it("a half refused on both: the capture fails, the passed half is purged; never more than 30 units", async () => {
    const f = fakeClient((feature) => (feature === "face-attr-analysis" ? refused(feature) : null));
    await expect(youcamCapturePorts(f.client).analyze(await full())).rejects.toBeInstanceOf(YoucamTaskError);
    expect(sent(f.calls, "face-attr-analysis")).toEqual(["538x619", "896x1200"]);
    expect(sent(f.calls, "skin-tone-analysis")).toEqual(["538x619"]);
    expect(f.charged()).toBe(20);
  });

  it("a cost-guard refusal is not retried", async () => {
    const f = fakeClient((feature) => new CostGuardError("YouCam call refused: run cap", "recording_off", feature, UNITS[feature]));
    await expect(youcamCapturePorts(f.client).analyze(await full())).rejects.toBeInstanceOf(CostGuardError);
    expect(f.calls).toHaveLength(2);
  });
});
