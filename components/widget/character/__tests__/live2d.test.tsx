// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../live2d/load", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live2d/load")>();
  return { ...actual, hasWebGL2: vi.fn(() => true), loadLive2D: vi.fn() };
});

import { Character } from "../Character";
import * as load from "../live2d/load";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const actual = await vi.importActual<typeof import("../live2d/load")>("../live2d/load");
const mocked = vi.mocked(load);

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  mocked.hasWebGL2.mockReturnValue(true);
  mocked.loadLive2D.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.head.querySelectorAll("script[data-giftfit-live2d-core]").forEach((s) => s.remove());
  delete (window as { Live2DCubismCore?: unknown }).Live2DCubismCore;
});

const base = { state: "idle" as const, onActivate: () => {} };

describe("pickCharacter", () => {
  it("chooses Live2D only with WebGL 2 and motion allowed", () => {
    expect(actual.pickCharacter({ reducedMotion: false, webgl: true })).toBe("live2d");
    expect(actual.pickCharacter({ reducedMotion: true, webgl: true })).toBe("svg");
    expect(actual.pickCharacter({ reducedMotion: false, webgl: false })).toBe("svg");
  });

  it("reports no WebGL 2 where the context type does not exist (jsdom, servers)", () => {
    expect(actual.hasWebGL2()).toBe(false);
  });
});

describe("Character fallback", () => {
  it("shows the SVG mascot without WebGL and never loads Live2D", () => {
    mocked.hasWebGL2.mockReturnValue(false);
    render(<Character {...base} reducedMotion={false} />);
    expect(screen.queryByTestId("live2d-canvas")).toBeNull();
    expect(screen.getByTestId("mascot-art")).toBeTruthy();
    expect(mocked.loadLive2D).not.toHaveBeenCalled();
  });

  it("shows the SVG mascot under reduced motion and never loads Live2D", () => {
    render(<Character {...base} reducedMotion />);
    expect(screen.queryByTestId("live2d-canvas")).toBeNull();
    expect(mocked.loadLive2D).not.toHaveBeenCalled();
  });

  it.each([
    ["core", "Core not found"],
    ["model", "Mark.model3.json: HTTP 404"],
    ["timeout", "too slow"],
  ] as const)("falls back to the mascot when Live2D fails (%s)", async (reason, message) => {
    mocked.loadLive2D.mockRejectedValue(new actual.Live2DLoadError(reason, message));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onFallback = vi.fn();
    render(<Character {...base} reducedMotion={false} tip="Hello" onFallback={onFallback} />);
    expect(screen.getByTestId("live2d-canvas")).toBeTruthy(); // tried Live2D first, mascot art as placeholder
    expect(screen.getByTestId("mascot-art")).toBeTruthy();
    await waitFor(() => expect(onFallback).toHaveBeenCalledWith(reason));
    expect(screen.queryByTestId("live2d-canvas")).toBeNull();
    expect(screen.getByTestId("mascot-art")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open gift assistant" })).toBeTruthy();
  });

  it("swaps the placeholder for the canvas once Live2D is drawing, and disposes it on unmount", async () => {
    const dispose = vi.fn();
    mocked.loadLive2D.mockResolvedValue({ dispose });
    const { unmount } = render(<Character {...base} reducedMotion={false} />);
    await waitFor(() => expect(screen.queryByTestId("mascot-art")).toBeNull());
    expect(screen.getByTestId("live2d-canvas").className).toMatch(/block/);
    const [, frame, signal] = mocked.loadLive2D.mock.calls[0];
    expect(frame()).toEqual({ state: "idle", mouth: 0 });
    unmount();
    expect(signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalled();
  });

  it("feeds the mouth amplitude to the render loop while talking", async () => {
    mocked.loadLive2D.mockResolvedValue({ dispose: () => {} });
    render(<Character {...base} state="talking" mouth={1} reducedMotion={false} />);
    await waitFor(() => expect(mocked.loadLive2D).toHaveBeenCalled());
    const frame = mocked.loadLive2D.mock.calls[0][1];
    let f = frame();
    for (let i = 0; i < 40; i++) f = frame();
    expect(f.state).toBe("talking");
    expect(f.mouth).toBeGreaterThan(0);
    expect(f.mouth).toBeLessThanOrEqual(1);
  });
});

describe("loaders", () => {
  it("loadCore rejects with reason 'core' when the script 404s, and can retry", async () => {
    const p = actual.loadCore("/live2d/core/missing.js");
    const s = document.head.querySelector("script[data-giftfit-live2d-core]") as HTMLScriptElement;
    expect(s.getAttribute("src")).toBe("/live2d/core/missing.js");
    s.dispatchEvent(new Event("error"));
    await expect(p).rejects.toMatchObject({ reason: "core" });
    expect(document.head.querySelector("script[data-giftfit-live2d-core]")).toBeNull();

    const again = actual.loadCore();
    const s2 = document.head.querySelector("script[data-giftfit-live2d-core]") as HTMLScriptElement;
    expect(s2.getAttribute("src")).toBe("/live2d/core/live2dcubismcore.min.js");
    (window as { Live2DCubismCore?: unknown }).Live2DCubismCore = {};
    s2.dispatchEvent(new Event("load"));
    await expect(again).resolves.toBeUndefined();
  });

  it("only ever loads Core from our own origin", () => {
    expect(actual.CORE_SRC).toBe("/live2d/core/live2dcubismcore.min.js");
    const src = readFileSync(path.join(HERE, "../live2d/load.ts"), "utf8");
    expect(src).not.toMatch(/cubism\.live2d\.com/);
  });

  it("fetchAsset maps a 404 to reason 'model'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(actual.fetchAsset("/live2d/models/Mark/Mark.model3.json")).rejects.toMatchObject({ reason: "model" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    await expect(actual.fetchAsset("/x")).rejects.toMatchObject({ reason: "model" });
  });

  it("withTimeout rejects with 'timeout' after the limit and disposes a late arrival", async () => {
    vi.useFakeTimers();
    let resolveLate!: (v: { dispose(): void }) => void;
    const late = { dispose: vi.fn() };
    const p = actual.withTimeout(new Promise<{ dispose(): void }>((r) => (resolveLate = r)), actual.LOAD_TIMEOUT_MS, (v) => v.dispose());
    const assertion = expect(p).rejects.toMatchObject({ reason: "timeout" });
    await act(async () => {
      vi.advanceTimersByTime(actual.LOAD_TIMEOUT_MS);
    });
    await assertion;
    resolveLate(late);
    await Promise.resolve();
    expect(late.dispose).toHaveBeenCalled();
    expect(actual.LOAD_TIMEOUT_MS).toBe(45_000);
  });

  it("withTimeout does not fail a load while the tab is hidden (rAF is paused there)", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    let settled = false;
    const p = actual.withTimeout(new Promise<never>(() => {}), 1000);
    p.catch(() => {}).finally(() => (settled = true));
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(settled).toBe(false);
    hidden.mockReturnValue(false);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await expect(p).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("one fixed model (no model-URL surface)", () => {
  const dir = path.join(HERE, "..");
  const sources = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(tsx?|js)$/.test(f) && !f.includes("__tests__") && statSync(path.join(dir, f)).isFile())
    .map((f) => [f, readFileSync(path.join(dir, f), "utf8")] as const);

  it("has no prop, option or parameter that names a model", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const [file, src] of sources) {
      expect(src, file).not.toMatch(/\bmodel(Url|URL|Src|Path|Dir|File|Name)?\??\s*:\s*string/);
      expect(src, file).not.toMatch(/searchParams|location\.(search|hash)|addEventListener\(\s*["']message/);
    }
  });

  it("keeps the model path a constant and loadLive2D takes no URL", () => {
    expect(actual.MODEL_DIR + actual.MODEL_FILE).toBe("/live2d/models/Mark/Mark.model3.json");
    expect(actual.loadLive2D.length).toBe(3); // (canvas, frame, signal)
  });

  it("ignores any extra model prop a caller might pass", async () => {
    mocked.loadLive2D.mockResolvedValue({ dispose: () => {} });
    const sneaky = { model: "https://example.com/other.model3.json", modelUrl: "https://example.com/x.model3.json" };
    render(<Character {...base} reducedMotion={false} {...(sneaky as object)} />);
    await waitFor(() => expect(mocked.loadLive2D).toHaveBeenCalled());
    const [canvas, frame, signal] = mocked.loadLive2D.mock.calls[0];
    expect(mocked.loadLive2D.mock.calls[0]).toHaveLength(3);
    expect(canvas.outerHTML).not.toContain("example.com");
    expect(JSON.stringify(frame())).not.toContain("example.com");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(document.body.innerHTML).not.toContain("example.com");
  });
});
