// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMouthFromAudio } from "../useMouthFromAudio";

let frames: FrameRequestCallback[] = [];
const flush = (now: number) => {
  const run = frames;
  frames = [];
  for (const f of run) f(now);
};

let amplitude = 0;
const contexts: FakeContext[] = [];

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(buf: Float32Array) {
    for (let i = 0; i < buf.length; i++) buf[i] = i % 2 ? amplitude : -amplitude;
  }
}
class FakeContext {
  destination = new FakeNode();
  analysers: FakeAnalyser[] = [];
  close = vi.fn(async () => {});
  resume = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => new FakeNode());
  createMediaElementSource = vi.fn(() => new FakeNode());
  constructor() {
    contexts.push(this);
  }
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a;
  }
}

const stream = (tracks = 1) => ({ getAudioTracks: () => Array.from({ length: tracks }, () => ({})) }) as unknown as MediaStream;

beforeEach(() => {
  frames = [];
  amplitude = 0;
  contexts.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("AudioContext", FakeContext);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useMouthFromAudio", () => {
  it("returns 0 for null and does not touch Web Audio", () => {
    const { result } = renderHook(() => useMouthFromAudio(null));
    expect(result.current).toBe(0);
    expect(contexts).toHaveLength(0);
  });

  it("is a no-op without Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    const s = stream();
    const { result } = renderHook(() => useMouthFromAudio(s));
    expect(result.current).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it("ignores a stream with no audio track", () => {
    const s = stream(0);
    renderHook(() => useMouthFromAudio(s));
    expect(contexts).toHaveLength(0);
  });

  it("maps a MediaStream's RMS to a smoothed 0..1 level and closes its context on cleanup", () => {
    const s = stream();
    const { result, unmount } = renderHook(() => useMouthFromAudio(s));
    const ctx = contexts[0];
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(ctx.analysers[0].connect).not.toHaveBeenCalled(); // analyser only: no echo to the speakers

    amplitude = 0.2;
    act(() => flush(16));
    const first = result.current;
    expect(first).toBeGreaterThan(0);
    for (let t = 32; t < 600; t += 16) act(() => flush(t));
    expect(result.current).toBeGreaterThan(first);
    expect(result.current).toBeLessThanOrEqual(1);
    expect(result.current).toBeCloseTo(Math.min(1, (0.2 - 0.012) * 5), 2);

    amplitude = 0;
    for (let t = 600; t < 2000; t += 16) act(() => flush(t));
    expect(result.current).toBe(0);

    unmount();
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("routes a media element once, keeps it audible, and never closes its shared context", () => {
    const el = document.createElement("audio");
    const first = renderHook(() => useMouthFromAudio(el));
    first.unmount();
    const second = renderHook(() => useMouthFromAudio(el)); // e.g. StrictMode's second effect run
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0];
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
    const source = ctx.createMediaElementSource.mock.results[0].value as FakeNode;
    expect(source.connect).toHaveBeenCalledWith(ctx.destination);
    expect(source.disconnect).toHaveBeenCalledWith(ctx.analysers[0]);
    expect(ctx.close).not.toHaveBeenCalled();

    el.dispatchEvent(new Event("play"));
    expect(ctx.resume).toHaveBeenCalled();
    second.unmount();
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("reads an AnalyserNode the voice player owns (P8.3) without creating or closing a context", () => {
    const analyser = new FakeAnalyser() as unknown as AnalyserNode;
    amplitude = 0.25;
    const { result, unmount } = renderHook(() => useMouthFromAudio(analyser));
    for (let t = 16; t < 400; t += 16) act(() => flush(t));
    expect(result.current).toBeGreaterThan(0.5);
    expect(contexts).toHaveLength(0);
    unmount();
    expect((analyser as unknown as FakeAnalyser).disconnect).not.toHaveBeenCalled();
  });

  it("resets to 0 when the source goes away", () => {
    amplitude = 0.3;
    const { result, rerender } = renderHook(({ a }) => useMouthFromAudio(a), { initialProps: { a: stream() as MediaStream | null } });
    for (let t = 16; t < 400; t += 16) act(() => flush(t));
    expect(result.current).toBeGreaterThan(0.5);
    rerender({ a: null });
    expect(result.current).toBe(0);
    expect(contexts[0].close).toHaveBeenCalled();
  });
});
