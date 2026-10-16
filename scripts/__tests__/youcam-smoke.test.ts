import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFixtureMemo } from "../../lib/youcam/mock";
import { isBodyRejection, main, parseArgs, readImage, sniffContentType, variantOrder } from "../youcam-smoke";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "youcam-smoke-"));
  vi.stubEnv("GIFTFIT_DATA_DIR", dir);
  vi.stubEnv("DATABASE_URL", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  clearFixtureMemo();
  await fs.rm(dir, { recursive: true, force: true });
});

const SELFIE = "fixtures/youcam/images/placeholder-selfie.png";

describe("youcam-smoke helpers", () => {
  it("parses options", () => {
    expect(
      parseArgs([SELFIE, "--face-crop", "c.jpg", "--earring", "e.png", "--necklace", "https://x/n.png", "--variant", "b", "--min-balance", "500", "--keep-tasks", "--preflight", "--out", "o.json"]),
    ).toEqual({
      image: SELFIE,
      faceCrop: "c.jpg",
      earring: "e.png",
      necklace: "https://x/n.png",
      variant: "B",
      minBalance: 500,
      keepTasks: true,
      preflight: true,
      out: "o.json",
    });
    expect(parseArgs([SELFIE])).toMatchObject({ minBalance: 1000, keepTasks: false, earring: expect.stringContaining("product-earring.png") });
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--variant", "D"])).toThrow(/A, B or C/);
    expect(() => parseArgs(["--earring"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--min-balance", "lots"])).toThrow(/number/);
  });

  it("sniffs images, orders variants and recognises body rejections", async () => {
    expect(sniffContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffContentType(new Uint8Array([0x47, 0x49, 0x46]))).toBeUndefined();
    await expect(readImage("https://shop.test/a.png", "x")).resolves.toEqual({ url: "https://shop.test/a.png" });
    expect(variantOrder("A")).toEqual(["A", "B", "C"]);
    expect(variantOrder("C")).toEqual(["C", "A", "B"]);
    expect(isBodyRejection({ id: "x", kind: "earring", ok: false, error: "bad", code: "InvalidParameters" })).toBe(true);
    expect(isBodyRejection({ id: "x", kind: "earring", ok: false, error: "no face", code: "PHOTO_DETECTION_FAIL" })).toBe(false);
    expect(isBodyRejection({ id: "x", kind: "earring", ok: true, url: "u", taskId: "t", cacheKey: "k", unitsCharged: 1, cached: false, mock: false })).toBe(false);
  });
});

describe("youcam-smoke main (mock only)", () => {
  it("runs the first-real-call sequence in mock mode without spending units", async () => {
    vi.stubEnv("YOUCAM_MOCK", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = path.join(dir, "summary.json");
    // A real run may already have written fixtures/youcam/real/ on this machine (gitignored);
    // what matters is that a mock run neither creates nor modifies it.
    const realFile = path.join("fixtures", "youcam", "real", "skin-tone-analysis.json");
    const mtimeBefore = await fs.stat(realFile).then((s) => s.mtimeMs).catch(() => null);
    expect(await main([SELFIE, "--out", out])).toBe(0);
    const summary = JSON.parse(await fs.readFile(out, "utf8"));
    expect(summary).toMatchObject({
      mode: "mock",
      synthetic: true,
      recipient: { faceShape: "Oval" },
      jewelryBody: { variant: "A", verified: false, tried: [{ variant: "A", outcome: "accepted" }] },
      units: { expected: 32, charged: 0 },
    });
    expect(Object.keys(summary.taskIds)).toEqual(["skin-tone-analysis", "face-attr-analysis", "2d-vto/earring", "2d-vto/necklace"]);
    expect(JSON.parse(log.mock.calls[0][0] as string).units.charged).toBe(0);
    const stderr = err.mock.calls.flat().join("\n");
    for (const step of ["[1]", "[2-3] 4 file(s)", "[4]", "[5]", "[6] earring variant A", "[7] necklace variant A", "[8]", "[9] deleted 4"]) {
      expect(stderr).toContain(step);
    }
    expect(await fs.stat(realFile).then((s) => s.mtimeMs).catch(() => null)).toBe(mtimeBefore);
    expect(await main([SELFIE, "--preflight"])).toBe(2);
    expect(await main([SELFIE, "--keep-tasks", "--face-crop", SELFIE, "--variant", "C"])).toBe(0);
  });

  it("rejects missing or non-image input", async () => {
    vi.stubEnv("YOUCAM_MOCK", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main([])).toBe(2);
    const txt = path.join(dir, "x.txt");
    await fs.writeFile(txt, "hello");
    expect(await main([txt])).toBe(2);
    expect(await main(["https://x/face.jpg"])).toBe(2);
  });
});
