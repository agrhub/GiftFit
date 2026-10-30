import { afterEach, describe, expect, it, vi } from "vitest";
import { LOAD_TIMEOUT_MS, Live2DLoadError, SHADER_FILES, SHADER_PATH, limitBlendShaders, prefetchShaders } from "../live2d/load";

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (body: (url: string) => Response) => {
  const f = vi.fn(async (url: string) => body(url));
  vi.stubGlobal("fetch", f);
  return f;
};

describe("shader guard (registerShader only after every source is available)", () => {
  it("fetches all 13 shader sources from the fixed path before the Framework compiles", async () => {
    const f = stubFetch(() => new Response("void main() {}", { status: 200 }));
    await prefetchShaders();
    expect(SHADER_FILES).toHaveLength(13);
    expect(f.mock.calls.map((c) => c[0]).sort()).toEqual(SHADER_FILES.map((n) => SHADER_PATH + n).sort());
  });

  it("rejects when any source is missing or empty, so the SVG mascot takes over", async () => {
    stubFetch((url) => (url.endsWith("fragshadersrccopy.frag") ? new Response("", { status: 404 }) : new Response("x", { status: 200 })));
    await expect(prefetchShaders()).rejects.toBeInstanceOf(Live2DLoadError);
    stubFetch((url) => new Response(url.endsWith("vertshadersrcblend.vert") ? "" : "x", { status: 200 }));
    await expect(prefetchShaders()).rejects.toMatchObject({ reason: "error" });
  });

  it("treats slow loads as slow, not failed: the timeout is only an outer bound", () => {
    expect(LOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("blend shaders (only the pairs the model draws with)", () => {
  // The Framework's lists: 18 colour blends after None (incl. the two "Compatible" ones) and 5 alpha blends.
  const fresh = () => ({ _colorBlendValues: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], _alphaBlendValues: [0, 1, 2, 3, 4] });
  const model = (o: { enabled: boolean; drawables?: Array<[number, number]>; offscreens?: Array<[number, number]> }) => {
    const d = o.drawables ?? [];
    const off = o.offscreens ?? [];
    return {
      isBlendModeEnabled: () => o.enabled,
      getDrawableCount: () => d.length,
      getDrawableColorBlend: (i: number) => d[i][0],
      getDrawableAlphaBlend: (i: number) => d[i][1],
      getOffscreenCount: () => off.length,
      getOffscreenColorBlend: (i: number) => off[i][0],
      getOffscreenAlphaBlend: (i: number) => off[i][1],
    } as unknown as Parameters<typeof limitBlendShaders>[1];
  };

  it("compiles no blend pair for a model without Cubism 5.3 blend modes (Mark)", () => {
    const s = fresh();
    limitBlendShaders(s, model({ enabled: false, drawables: [[3, 2]] }));
    expect(s._colorBlendValues).toEqual([]);
    expect(s._alphaBlendValues).toEqual([]);
  });

  it("keeps every colour and alpha blend a drawable or offscreen uses", () => {
    const s = fresh();
    limitBlendShaders(s, model({ enabled: true, drawables: [[0, 0], [5, 0]], offscreens: [[9, 2]] }));
    expect(s._colorBlendValues).toEqual([0, 5, 9]);
    expect(s._alphaBlendValues).toEqual([0, 2]);
  });
});
