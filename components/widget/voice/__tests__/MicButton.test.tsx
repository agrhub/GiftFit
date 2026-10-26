// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/lib/i18n";
import { MicButton, type MicPhase } from "../MicButton";
import { MIC_NOTICE_KEY } from "../prefs";
import type { Recording } from "../recorder";

let now = 1_000_000;
const tr = translator("en");

function fakeRecording() {
  const r = {
    stream: { getAudioTracks: () => [] } as unknown as MediaStream,
    mimeType: "audio/webm;codecs=opus",
    startedAt: now,
    stop: vi.fn(async () => new Blob(["opus-bytes"], { type: "audio/webm;codecs=opus" })),
    cancel: vi.fn(),
  };
  return r as Recording & { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
}

function setup(o: { record?: () => Promise<Recording>; fetchImpl?: typeof fetch; lang?: "en" | "vi"; requestMic?: () => Promise<void> } = {}) {
  const recordings: Array<ReturnType<typeof fakeRecording>> = [];
  const record =
    o.record ??
    vi.fn(async () => {
      const r = fakeRecording();
      recordings.push(r);
      return r;
    });
  const fetchMock = vi.fn(async () => Response.json({ text: "Gift for my mum, about $100", lang: "en" }));
  const onStart = vi.fn();
  const onTranscript = vi.fn();
  const requestMic = o.requestMic ?? vi.fn(async () => {});
  const phases: MicPhase[] = [];
  render(
    <MicButton
      tr={tr}
      lang={o.lang ?? "en"}
      sessionId="sess-abc12345"
      fetchImpl={o.fetchImpl ?? (fetchMock as unknown as typeof fetch)}
      record={record}
      requestMic={requestMic}
      onStart={onStart}
      onPhase={(p) => phases.push(p)}
      onTranscript={onTranscript}
    />,
  );
  return { record, recordings, fetchMock, onStart, onTranscript, phases, requestMic, btn: () => screen.getByTestId("voice-mic") };
}

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("MicButton", () => {
  it("first use: the notice once; Continue only arms the mic (permission, no recording); the shopper's own tap records", async () => {
    const s = setup({ lang: "vi" });
    fireEvent.pointerDown(s.btn());
    expect(screen.getByTestId("voice-mic-notice").textContent).toContain("Google Cloud Speech-to-Text");
    expect(s.record).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("voice-mic-notice-ok"));
    expect(localStorage.getItem(MIC_NOTICE_KEY)).toBe("1");
    // Armed: permission asked, a "how to talk" hint, nothing recorded, the mic focused for Space.
    expect(await screen.findByTestId("voice-mic-ready")).toBeTruthy();
    expect(s.requestMic).toHaveBeenCalledTimes(1);
    expect(s.record).not.toHaveBeenCalled();
    expect(s.btn().getAttribute("data-phase")).toBe("idle");
    expect(s.btn().getAttribute("aria-label")).toBe("Hold to talk");
    expect(document.activeElement).toBe(s.btn());
    expect(s.onStart).toHaveBeenCalledTimes(1);

    // The natural next tap STARTS recording (it can no longer cut a clip begun on Continue).
    fireEvent.pointerDown(s.btn());
    now += 100;
    fireEvent.pointerUp(s.btn()); // quick tap → tap mode
    await waitFor(() => expect(s.btn().getAttribute("data-phase")).toBe("recording"));
    expect(s.btn().getAttribute("aria-label")).toBe("Stop and send");
    expect(s.btn().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("voice-mic-status").textContent).toContain("Listening");
    expect(screen.queryByTestId("voice-mic-ready")).toBeNull();
    now += 2000;
    fireEvent.pointerDown(s.btn()); // second tap: stop and send
    await waitFor(() => expect(s.onTranscript).toHaveBeenCalledWith("Gift for my mum, about $100"));
    const [url, init] = s.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/voice/stt");
    expect(init.headers).toMatchObject({ "x-voice-lang": "vi", "x-voice-session": "sess-abc12345", "Content-Type": "audio/webm;codecs=opus" });
    expect(init.body).toBeInstanceOf(Blob);
    expect(s.phases).toEqual(expect.arrayContaining(["notice", "starting", "recording", "transcribing", "idle"]));
    expect(s.recordings).toHaveLength(1);
    cleanup();

    // Second mount: no notice any more.
    const t = setup();
    fireEvent.pointerDown(t.btn());
    expect(screen.queryByTestId("voice-mic-notice")).toBeNull();
    await waitFor(() => expect(t.record).toHaveBeenCalled());
  });

  it("push-to-talk: records while held, sends on release", async () => {
    localStorage.setItem(MIC_NOTICE_KEY, "1");
    const s = setup();
    fireEvent.pointerDown(s.btn());
    await waitFor(() => expect(s.btn().getAttribute("data-phase")).toBe("recording"));
    now += 1500;
    fireEvent.pointerUp(s.btn());
    await waitFor(() => expect(s.onTranscript).toHaveBeenCalledTimes(1));
    expect(s.recordings[0].stop).toHaveBeenCalled();
  });

  it("Space held while focused is push-to-talk", async () => {
    localStorage.setItem(MIC_NOTICE_KEY, "1");
    const s = setup();
    fireEvent.keyDown(s.btn(), { key: " " });
    await waitFor(() => expect(s.btn().getAttribute("data-phase")).toBe("recording"));
    now += 1200;
    fireEvent.keyUp(s.btn(), { key: " " });
    await waitFor(() => expect(s.onTranscript).toHaveBeenCalledTimes(1));
  });

  it("stops by itself at 15 s", async () => {
    localStorage.setItem(MIC_NOTICE_KEY, "1");
    const s = setup();
    fireEvent.pointerDown(s.btn());
    await waitFor(() => expect(s.btn().getAttribute("data-phase")).toBe("recording"));
    now += 15_000;
    await waitFor(() => expect(s.recordings[0].stop).toHaveBeenCalled(), { timeout: 2000 });
    await waitFor(() => expect(s.onTranscript).toHaveBeenCalledTimes(1));
  });

  it("a clip that is too short is not sent", async () => {
    localStorage.setItem(MIC_NOTICE_KEY, "1");
    const s = setup();
    fireEvent.pointerDown(s.btn());
    await waitFor(() => expect(s.btn().getAttribute("data-phase")).toBe("recording"));
    now += 100;
    fireEvent.pointerUp(s.btn()); // quick tap → tap mode
    expect(s.btn().getAttribute("data-phase")).toBe("recording");
    now += 150;
    fireEvent.pointerDown(s.btn());
    await waitFor(() => expect(screen.getByTestId("voice-mic-status").textContent).toContain("too short"));
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it("a blocked microphone on Continue is explained right away", async () => {
    const s = setup({ requestMic: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })) });
    fireEvent.pointerDown(s.btn());
    fireEvent.click(screen.getByTestId("voice-mic-notice-ok"));
    await waitFor(() => expect(screen.getByTestId("voice-mic-status").textContent).toContain("microphone is blocked"));
    expect(s.record).not.toHaveBeenCalled();
  });

  it("explains a blocked microphone and falls back to typing", async () => {
    localStorage.setItem(MIC_NOTICE_KEY, "1");
    const s = setup({ record: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })) });
    fireEvent.pointerDown(s.btn());
    await waitFor(() => expect(screen.getByTestId("voice-mic-status").textContent).toContain("microphone is blocked"));
    expect(s.btn().getAttribute("data-phase")).toBe("idle");
  });

  it("says when the voice limit is reached (429) and when nothing was heard", async () => {
    localStorage.setItem(MIC_NOTICE_KEY, "1");
    const capped = vi.fn(async () => Response.json({ error: "voice_cap" }, { status: 429 }));
    const s = setup({ fetchImpl: capped as unknown as typeof fetch });
    fireEvent.pointerDown(s.btn());
    await waitFor(() => expect(s.btn().getAttribute("data-phase")).toBe("recording"));
    now += 1000;
    fireEvent.pointerUp(s.btn());
    await waitFor(() => expect(screen.getByTestId("voice-mic-status").textContent).toContain("voice limit"));
    expect(s.onTranscript).not.toHaveBeenCalled();
    cleanup();

    const empty = vi.fn(async () => Response.json({ text: "", lang: "en" }));
    const t = setup({ fetchImpl: empty as unknown as typeof fetch });
    fireEvent.pointerDown(t.btn());
    await waitFor(() => expect(t.btn().getAttribute("data-phase")).toBe("recording"));
    now += 1000;
    fireEvent.pointerUp(t.btn());
    await waitFor(() => expect(screen.getByTestId("voice-mic-status").textContent).toContain("didn't catch"));
  });

  it("Escape discards the recording", async () => {
    localStorage.setItem(MIC_NOTICE_KEY, "1");
    const s = setup();
    fireEvent.pointerDown(s.btn());
    await waitFor(() => expect(s.btn().getAttribute("data-phase")).toBe("recording"));
    act(() => {
      fireEvent.keyDown(s.btn(), { key: "Escape" });
    });
    expect(s.btn().getAttribute("data-phase")).toBe("idle");
    expect(s.recordings[0].cancel).toHaveBeenCalled();
    expect(s.fetchMock).not.toHaveBeenCalled();
  });
});
