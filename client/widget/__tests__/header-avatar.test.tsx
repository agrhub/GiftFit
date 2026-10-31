// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../character/live2d/load", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../character/live2d/load")>();
  return { ...actual, hasWebGL2: vi.fn(() => true), live2dFailed: vi.fn(() => false) };
});

import { MARK_AVATAR_SRC, MarkAvatar } from "../character/MarkAvatar";
import * as load from "../character/live2d/load";
import { WidgetApp, type WidgetPreview } from "../WidgetApp";

const mocked = vi.mocked(load);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  mocked.hasWebGL2.mockReturnValue(true);
  mocked.live2dFailed.mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const preview = (character: WidgetPreview["settings"]["character"]): WidgetPreview => ({
  key: "AbCdEfGhIjKlMnOpQrStUv",
  domain: "lumen-jewelry.example",
  storeName: "Lumen Fine Jewelry",
  giftable: false,
  products: [],
  settings: { character },
});

const header = () => screen.getByTestId("widget-panel").querySelector("header")!;

describe("panel header avatar", () => {
  it("shows the Mark-kun still by default, in the same 56 px slot", () => {
    render(<WidgetApp store="aurum" parentOrigin={null} allowedLangs={["en"]} baseUrl="https://giftfit.example" />);
    const avatar = screen.getByTestId("widget-avatar-mark");
    expect(header().contains(avatar)).toBe(true);
    expect(avatar.querySelector("img")!.getAttribute("src")).toBe(MARK_AVATAR_SRC);
    expect(avatar.parentElement!.className).toContain("h-14 w-14");
    expect(header().querySelector('[data-testid="mascot-art"]')).toBeNull();
  });

  it("keeps the SVG mascot when the preview owner chose the mascot", () => {
    render(<WidgetApp store="preview:AbCdEfGhIjKlMnOpQrStUv" preview={preview("mascot")} parentOrigin={null} allowedLangs={["en"]} baseUrl="https://giftfit.example" />);
    expect(screen.queryByTestId("widget-avatar-mark")).toBeNull();
    expect(header().querySelector('[data-testid="mascot-art"]')).toBeTruthy();
  });

  it("shows Mark-kun on a preview whose owner chose him", () => {
    render(<WidgetApp store="preview:AbCdEfGhIjKlMnOpQrStUv" preview={preview("mark-kun")} parentOrigin={null} allowedLangs={["en"]} baseUrl="https://giftfit.example" />);
    expect(screen.getByTestId("widget-avatar-mark")).toBeTruthy();
  });

  it("swaps to the SVG mascot when the image fails to load", () => {
    render(<WidgetApp store="aurum" parentOrigin={null} allowedLangs={["en"]} baseUrl="https://giftfit.example" />);
    fireEvent.error(screen.getByTestId("widget-avatar-mark").querySelector("img")!);
    expect(screen.queryByTestId("widget-avatar-mark")).toBeNull();
    expect(header().querySelector('[data-testid="mascot-art"]')).toBeTruthy();
  });
});

describe("MarkAvatar", () => {
  const fallback = <span data-testid="fallback" />;

  it.each([
    ["the store chose the mascot", { mascot: true }],
    ["motion is reduced (Live2D is off)", { reducedMotion: true }],
  ])("shows the fallback when %s", (_, o) => {
    render(<MarkAvatar reducedMotion={false} {...o} onActivate={() => {}} fallback={fallback} />);
    expect(screen.getByTestId("fallback")).toBeTruthy();
    expect(screen.queryByTestId("widget-avatar-mark")).toBeNull();
  });

  it("shows the fallback without WebGL 2 or after Live2D failed in this frame", () => {
    mocked.hasWebGL2.mockReturnValue(false);
    render(<MarkAvatar reducedMotion={false} onActivate={() => {}} fallback={fallback} />);
    expect(screen.getByTestId("fallback")).toBeTruthy();
    cleanup();
    mocked.hasWebGL2.mockReturnValue(true);
    mocked.live2dFailed.mockReturnValue(true);
    render(<MarkAvatar reducedMotion={false} onActivate={() => {}} fallback={fallback} />);
    expect(screen.getByTestId("fallback")).toBeTruthy();
  });

  it("follows the voice: a ring while listening, a mouth only while talking", () => {
    const { rerender } = render(<MarkAvatar reducedMotion={false} onActivate={() => {}} fallback={fallback} />);
    const avatar = screen.getByTestId("widget-avatar-mark");
    expect(avatar.getAttribute("data-state")).toBe("idle");
    expect(screen.queryByTestId("widget-avatar-mouth")).toBeNull();

    rerender(<MarkAvatar reducedMotion={false} state="listening" onActivate={() => {}} fallback={fallback} />);
    expect(avatar.getAttribute("data-state")).toBe("listening");
    expect((avatar.querySelector("img")!.parentElement as HTMLElement).style.animation).toContain("gf-avatar-listen");
    expect(screen.queryByTestId("widget-avatar-mouth")).toBeNull();

    rerender(<MarkAvatar reducedMotion={false} state="talking" mouth={0.6} onActivate={() => {}} fallback={fallback} />);
    expect(avatar.getAttribute("data-state")).toBe("talking");
    expect(screen.getByTestId("widget-avatar-mouth").style.transform).toContain("scaleY(0.6)");

    // No level to follow (e.g. speech the browser can't analyse): a steady rhythm instead.
    rerender(<MarkAvatar reducedMotion={false} state="talking" onActivate={() => {}} fallback={fallback} />);
    expect(screen.getByTestId("widget-avatar-mouth").style.animation).toContain("gf-avatar-talk");

    rerender(<MarkAvatar reducedMotion={false} state="idle" onActivate={() => {}} fallback={fallback} />);
    expect(screen.queryByTestId("widget-avatar-mouth")).toBeNull();
  });

  it("is a named button that activates", () => {
    const onActivate = vi.fn();
    render(<MarkAvatar reducedMotion={false} label="Gift assistant" onActivate={onActivate} fallback={fallback} />);
    fireEvent.click(screen.getByRole("button", { name: "Gift assistant" }));
    expect(onActivate).toHaveBeenCalledOnce();
    expect(screen.getByTestId("widget-avatar-mark").querySelector("img")!.getAttribute("alt")).toBe("");
  });
});
