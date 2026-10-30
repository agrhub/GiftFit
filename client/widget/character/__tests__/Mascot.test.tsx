// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mascot } from "../Mascot";
import type { CharacterState } from "../types";

let frames: FrameRequestCallback[] = [];
const flushFrames = (now: number) => {
  const run = frames;
  frames = [];
  for (const f of run) f(now);
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const root = (c: HTMLElement) => c.querySelector(".gfm") as HTMLElement;

describe("Mascot states", () => {
  it.each<CharacterState>(["idle", "listening", "thinking", "talking"])("renders %s", (state) => {
    const { container } = render(<Mascot state={state} onActivate={() => {}} reducedMotion={false} />);
    expect(root(container).dataset.state).toBe(state);
    expect(root(container).classList.contains(`gfm-${state}`)).toBe(true);
    expect(!!container.querySelector(".gfm-dots")).toBe(state === "thinking");
    expect(!!container.querySelector(".gfm-mouth")).toBe(state === "talking");
    expect(!!container.querySelector(".gfm-smile")).toBe(state !== "talking");
  });

  it("hides the art from assistive tech and names the launcher (localisable)", () => {
    const { container } = render(<Mascot state="idle" onActivate={() => {}} reducedMotion={false} label="Mở trợ lý quà tặng" />);
    expect(screen.getByRole("button", { name: "Mở trợ lý quà tặng" })).toBeTruthy();
    expect(container.querySelector("svg.gfm-svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("activation", () => {
  it("calls onActivate on click, Enter and Space (once each)", () => {
    const onActivate = vi.fn();
    render(<Mascot state="idle" onActivate={onActivate} reducedMotion={false} />);
    const btn = screen.getByRole("button", { name: "Open gift assistant" });
    expect(btn.getAttribute("type")).toBe("button");
    fireEvent.click(btn);
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(btn, { key: "Enter", repeat: true });
    expect(onActivate).toHaveBeenCalledTimes(2);
    const space = fireEvent.keyDown(btn, { key: " " });
    expect(space).toBe(false); // default prevented: no page scroll, no native click
    expect(onActivate).toHaveBeenCalledTimes(2);
    fireEvent.keyUp(btn, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(btn, { key: "a" });
    fireEvent.keyUp(btn, { key: "Escape" });
    expect(onActivate).toHaveBeenCalledTimes(3);
  });
});

describe("tip bubble", () => {
  it("announces the whole tip once in a polite live region and types the visible copy", () => {
    vi.useFakeTimers();
    render(<Mascot state="talking" tip="Hi there" onActivate={() => {}} reducedMotion={false} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Hi there");
    const typed = () => (screen.getByTestId("character-tip-text").lastElementChild as HTMLElement).textContent;
    expect(typed()).toBe("");
    act(() => vi.advanceTimersByTime(28 * 3));
    expect(typed()).toBe("Hi ");
    act(() => vi.advanceTimersByTime(28 * 20));
    expect(typed()).toBe("Hi there");
    expect(screen.getByTestId("character-tip-text").getAttribute("aria-hidden")).toBe("true");
  });

  it("has no bubble for an empty tip, and is dismissible", () => {
    const onDismissTip = vi.fn();
    const { rerender } = render(<Mascot state="idle" tip="  " onActivate={() => {}} reducedMotion={false} />);
    expect(screen.queryByTestId("character-tip-text")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");

    rerender(<Mascot state="idle" tip="Need a hand?" onActivate={() => {}} reducedMotion={false} onDismissTip={onDismissTip} dismissLabel="Đóng" />);
    fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
    expect(onDismissTip).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("character-tip-text")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open gift assistant" }));

    rerender(<Mascot state="idle" tip="A new tip" onActivate={() => {}} reducedMotion={false} />);
    expect(screen.getByRole("status").textContent).toBe("A new tip");
  });
});

describe("reduced motion", () => {
  it("drops every animation class, shows the tip instantly and keeps a still mouth", () => {
    const { container } = render(<Mascot state="talking" tip="Instant" mouth={1} onActivate={() => {}} reducedMotion />);
    const r = root(container);
    expect(r.classList.contains("gfm-still")).toBe(true);
    expect(container.querySelector(".gfm-anim")).toBeNull();
    expect((screen.getByTestId("character-tip-text").lastElementChild as HTMLElement).textContent).toBe("Instant");
    expect(screen.getByRole("button", { name: "Open gift assistant" }).className).not.toMatch(/transition/);
    expect(frames).toHaveLength(0); // no mouth loop
    expect(container.querySelector(".gfm-mouth")?.getAttribute("ry")).toBe("2.14");
  });

  it("animates when motion is allowed", () => {
    const { container } = render(<Mascot state="idle" onActivate={() => {}} reducedMotion={false} />);
    expect(root(container).classList.contains("gfm-anim")).toBe(true);
  });
});

describe("mouth", () => {
  it("follows `mouth` smoothly while talking and clamps it", () => {
    const { container, rerender } = render(<Mascot state="talking" mouth={5} onActivate={() => {}} reducedMotion={false} />);
    const ry = () => Number(container.querySelector(".gfm-mouth")?.getAttribute("ry"));
    act(() => flushFrames(0));
    const first = ry();
    expect(first).toBeGreaterThan(0.7);
    expect(first).toBeLessThan(4.3);
    for (let t = 16; t < 1000; t += 16) act(() => flushFrames(t));
    expect(ry()).toBeCloseTo(4.3, 1); // 0.7 + 3.6 * clamp(5) = 4.3
    rerender(<Mascot state="talking" mouth={0} onActivate={() => {}} reducedMotion={false} />);
    for (let t = 1000; t < 2000; t += 16) act(() => flushFrames(t));
    expect(ry()).toBeCloseTo(0.7, 1);
  });

  it("uses the typing rhythm without `mouth`", () => {
    const { container } = render(<Mascot state="talking" onActivate={() => {}} reducedMotion={false} />);
    for (let t = 0; t < 400; t += 16) act(() => flushFrames(t));
    expect(Number(container.querySelector(".gfm-mouth")?.getAttribute("ry"))).toBeGreaterThan(0.9);
  });

  it("pauses when the document is hidden", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { container } = render(<Mascot state="talking" onActivate={() => {}} reducedMotion={false} />);
    expect(root(container).classList.contains("gfm-paused")).toBe(true);
    expect(frames).toHaveLength(0);
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(root(container).classList.contains("gfm-paused")).toBe(false);
    expect(frames.length).toBeGreaterThan(0);
  });
});
