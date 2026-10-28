// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { afterFirstPaintIdle, CORE_SRC, fetchAsset, MODEL_DIR, MODEL_FILE, modelFiles, scheduleLive2DWarmup, SHADER_FILES, SHADER_PATH, warmLive2D } from "../live2d/load";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const MODEL3 = {
  FileReferences: { Moc: "Mark.moc3", Textures: ["Mark.2048/texture_00.png"], Physics: "Mark.physics3.json", Motions: { Idle: [{ File: "motions/mark_m01.motion3.json" }, { File: "motions/mark_m02.motion3.json" }] } },
};

describe("Live2D warm-up", () => {
  it("runs only after the first paint and then when idle", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    const idles: IdleRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("requestIdleCallback", (cb: IdleRequestCallback) => idles.push(cb));
    const task = vi.fn();
    afterFirstPaintIdle(task);
    vi.runAllTimers();
    expect(task).not.toHaveBeenCalled(); // nothing before the first frame
    frames.shift()!(0);
    expect(idles).toHaveLength(0); // the frame has not been painted yet
    vi.runAllTimers();
    expect(task).not.toHaveBeenCalled();
    idles.shift()!({ didTimeout: false, timeRemaining: () => 10 });
    expect(task).toHaveBeenCalledOnce();
  });

  it("can be cancelled before it runs", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.stubGlobal("requestIdleCallback", undefined);
    const task = vi.fn();
    afterFirstPaintIdle(task)();
    vi.runAllTimers();
    expect(task).not.toHaveBeenCalled();
  });

  it("does not throw and downloads nothing without WebGL 2 (jsdom)", () => {
    vi.useFakeTimers();
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    expect(() => {
      scheduleLive2DWarmup();
      vi.runAllTimers();
    }).not.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it("lists the model's own files only, never a path outside the model folder", () => {
    expect(modelFiles(MODEL3)).toEqual(["Mark.moc3", "Mark.2048/texture_00.png", "Mark.physics3.json", "motions/mark_m01.motion3.json", "motions/mark_m02.motion3.json"]);
    expect(modelFiles({ FileReferences: { Moc: "../../core/x.js", Textures: [7] } })).toEqual([]);
    expect(modelFiles(null)).toEqual([]);
  });

  it("starts every download at once and hands the bytes to fetchAsset without a second request", async () => {
    const f = vi.fn(async (url: string) => new Response(url.endsWith(MODEL_FILE) ? JSON.stringify(MODEL3) : "bytes", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await warmLive2D();
    const urls = f.mock.calls.map((c) => c[0]);
    expect(urls).toContain(CORE_SRC);
    expect(urls).toEqual(expect.arrayContaining([...SHADER_FILES.map((n) => SHADER_PATH + n), MODEL_DIR + MODEL_FILE, ...modelFiles(MODEL3).map((n) => MODEL_DIR + n)]));
    const before = f.mock.calls.length;
    const moc = await fetchAsset(MODEL_DIR + "Mark.moc3");
    expect(new TextDecoder().decode(moc)).toBe("bytes");
    expect(f.mock.calls.length).toBe(before);
    await fetchAsset(MODEL_DIR + "Mark.moc3"); // handed over once; later reads fetch again
    expect(f.mock.calls.length).toBe(before + 1);
  });
});
