import { afterEach, describe, expect, it, vi } from "vitest";
import { LOAD_TIMEOUT_MS, Live2DLoadError, SHADER_FILES, SHADER_PATH, prefetchShaders } from "../live2d/load";

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
