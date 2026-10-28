// @vitest-environment jsdom
/**
 * Voice in the widget panel, end to end in jsdom with fake Web Audio, MediaRecorder and fetch:
 * voice OFF by default and remembered, spoken replies (server TTS → AnalyserNode → talking), the
 * "AI voice" label while playing, mute/interrupt cancelling, and the mic → transcript → Concierge path.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetApp } from "@/components/widget/WidgetApp";
import { MIC_NOTICE_KEY, VOICE_ON_KEY } from "../prefs";

// ---- fake Web Audio
const sources: FakeSource[] = [];
class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(buf: Float32Array) {
    const playing = sources.some((s) => s.started && !s.stopped);
    for (let i = 0; i < buf.length; i++) buf[i] = playing ? (i % 2 ? 0.3 : -0.3) : 0;
  }
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start = vi.fn(() => {
    this.started = true;
  });
  stop = vi.fn(() => {
    this.stopped = true;
  });
  end() {
    this.stopped = true;
    this.onended?.();
  }
}
class FakeContext {
  state = "running";
  destination = new FakeNode();
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createAnalyser() {
    return new FakeAnalyser();
  }
  createBufferSource() {
    const s = new FakeSource();
    sources.push(s);
    return s;
  }
  createMediaStreamSource() {
    return new FakeNode();
  }
  async decodeAudioData(b: ArrayBuffer) {
    return { length: b.byteLength };
  }
  createBuffer() {
    return { copyToChannel: vi.fn() };
  }
}

// ---- fake microphone
class FakeRecorder {
  static isTypeSupported = (t: string) => t === "audio/webm;codecs=opus";
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["opus"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const REPLY = "Here are three gold pieces she may love. Each one is light and easy to wear.";

function ndjson(lines: unknown[]) {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
const calls = (path: string) => fetchMock.mock.calls.filter((c) => String(c[0]) === path);

beforeEach(() => {
  sources.length = 0;
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }], getAudioTracks: () => [] })) },
  });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/fit/report") return Response.json({ status: "pending" });
    if (url === "/api/concierge") return ndjson([{ type: "start", source: "mock" }, { type: "text", delta: REPLY }, { type: "final", suggestions: [], source: "mock", degraded: false }]);
    if (url === "/api/voice/tts") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav", "x-voice-engine": "mock" } });
    if (url === "/api/voice/stt") return Response.json({ text: "Gift for my sister under $150", lang: "en", bytes: (init?.body as Blob).size });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

const app = () => render(<WidgetApp store="aurum" parentOrigin={null} allowedLangs={["en", "vi"]} baseUrl="https://giftfit.example" />);
const character = () => screen.getByTestId("widget-panel").querySelector("header [data-state]")!;

async function ask(text: string) {
  const input = screen.getByLabelText("Your message");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findAllByText(REPLY);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
}

describe("widget voice", () => {
  it("is off by default: replies are not spoken and no voice request is made", async () => {
    app();
    expect(screen.getByTestId("voice-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("voice-ai-label")).toBeNull();
    await ask("Anniversary gift for my wife");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls("/api/voice/tts")).toHaveLength(0);
  });

  it("turned on: speaks the finished reply through Web Audio, character talks, AI voice label shows; mute stops it and is remembered", async () => {
    app();
    fireEvent.click(screen.getByTestId("voice-toggle"));
    expect(localStorage.getItem(VOICE_ON_KEY)).toBe("1");
    expect(screen.getByTestId("voice-ai-label").textContent).toContain("AI voice");

    await ask("Anniversary gift for my wife");
    await waitFor(() => expect(sources.some((s) => s.started)).toBe(true));
    const tts = calls("/api/voice/tts");
    // First sentence alone (quick start), the rest prefetched as the next chunk.
    expect(JSON.parse(String((tts[0][1] as RequestInit).body))).toEqual({ text: "Here are three gold pieces she may love.", lang: "en" });
    expect(((tts[0][1] as RequestInit).headers as Record<string, string>)["x-voice-session"]).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(character().getAttribute("data-state")).toBe("talking"));
    expect(screen.getByTestId("voice-ai-label").hasAttribute("data-playing")).toBe(true);

    // The popover names the engine (mock in tests) and says it is AI.
    fireEvent.click(screen.getByTestId("voice-ai-label"));
    expect(screen.getByTestId("voice-ai-info").textContent).toMatch(/computer-generated, not a real person[^]*test tone/);

    // Mute while speaking: playback stops, the preference sticks, the next reply stays silent.
    fireEvent.click(screen.getByTestId("voice-toggle"));
    expect(sources[0].stop).toHaveBeenCalled();
    expect(localStorage.getItem(VOICE_ON_KEY)).toBe("0");
    await waitFor(() => expect(character().getAttribute("data-state")).not.toBe("talking"));
    const before = calls("/api/voice/tts").length;
    await ask("Something cheaper please");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls("/api/voice/tts")).toHaveLength(before);

    cleanup();
    localStorage.setItem(VOICE_ON_KEY, "1");
    app();
    await waitFor(() => expect(screen.getByTestId("voice-toggle").getAttribute("aria-pressed")).toBe("true"));
  });

  it("a new message interrupts the reply being spoken", async () => {
    localStorage.setItem(VOICE_ON_KEY, "1");
    app();
    await waitFor(() => expect(screen.getByTestId("voice-toggle").getAttribute("aria-pressed")).toBe("true"));
    await ask("First question");
    await waitFor(() => expect(sources.some((s) => s.started)).toBe(true));
    const input = screen.getByLabelText("Your message");
    fireEvent.change(input, { target: { value: "Second question" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sources[0].stop).toHaveBeenCalled();
  });

  it("natural voice: offered on desktop WebGPU once voice is on, with the size; nothing downloads before the click", async () => {
    const files = ["onnx/duration_predictor.onnx", "onnx/text_encoder.onnx", "onnx/vector_estimator.onnx", "onnx/vocoder.onnx", "onnx/tts.json", "onnx/unicode_indexer.json", "voice_styles/M1.json"];
    const manifest = { revision: "aafc6e32", files: files.map((path) => ({ path, size: 50_000_000, sha256: "b".repeat(64), parts: [{ path: `${path}.part000`, size: 50_000_000, sha256: "b".repeat(64) }] })) };
    const inner = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (String(url).endsWith("/voice/supertonic/aafc6e32/manifest.json") ? Response.json(manifest) : inner(url, init)));
    Object.defineProperty(navigator, "gpu", { configurable: true, value: { requestAdapter: async () => ({}) } });
    const posted: unknown[] = [];
    class FakeWorker {
      onmessage = null;
      onerror = null;
      postMessage(m: unknown) {
        posted.push(m);
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    try {
      app();
      expect(screen.queryByTestId("natural-voice")).toBeNull(); // voice is off: nothing offered, nothing fetched
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/voice/supertonic/"))).toBe(false);
      fireEvent.click(screen.getByTestId("voice-toggle"));
      const card = await screen.findByTestId("natural-voice");
      expect(card.textContent).toContain("350 MB");
      expect(card.textContent).toContain("separate copy for each shop");
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/voice/supertonic/")).map((c) => String(c[0]).split("/").pop())).toEqual(["manifest.json"]);
      expect(posted).toHaveLength(0);
      fireEvent.click(screen.getByTestId("natural-download"));
      expect(posted[0]).toMatchObject({ type: "init", allowDownload: true });
      expect(screen.getByTestId("natural-voice").getAttribute("data-status")).toBe("downloading");
      fireEvent.click(screen.getByTestId("natural-cancel"));
      expect(posted.at(-1)).toMatchObject({ type: "cancel" });
    } finally {
      delete (navigator as { gpu?: unknown }).gpu;
    }
  });

  it("natural voice is not offered in a language Supertonic doesn't speak (zh), even on desktop WebGPU", async () => {
    Object.defineProperty(navigator, "gpu", { configurable: true, value: { requestAdapter: async () => ({}) } });
    vi.stubGlobal("Worker", class { onmessage = null; onerror = null; postMessage() {} terminate() {} });
    try {
      localStorage.setItem(VOICE_ON_KEY, "1");
      render(<WidgetApp store="aurum" parentOrigin={null} preferredLang="zh" allowedLangs={["zh"]} baseUrl="https://giftfit.example" />);
      await waitFor(() => expect(screen.getByTestId("voice-toggle").getAttribute("aria-pressed")).toBe("true"));
      expect(screen.getByLabelText("你的消息")).toBeTruthy();
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByTestId("natural-voice")).toBeNull();
    } finally {
      delete (navigator as { gpu?: unknown }).gpu;
    }
  });

  it("mic: listening while recording, the transcript is sent as the shopper's message, and voice turns on", async () => {
    localStorage.setItem(MIC_NOTICE_KEY, "1");
    app();
    const mic = await screen.findByTestId("voice-mic");
    let now = 5_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fireEvent.pointerDown(mic);
    await waitFor(() => expect(mic.getAttribute("data-phase")).toBe("recording"));
    expect(character().getAttribute("data-state")).toBe("listening");
    now += 2000;
    fireEvent.pointerUp(mic);
    await screen.findByTestId("widget-voice-turn");
    expect(screen.getByTestId("widget-voice-turn").textContent).toContain("Gift for my sister under $150");
    const stt = calls("/api/voice/stt")[0][1] as RequestInit;
    expect((stt.headers as Record<string, string>)["x-voice-lang"]).toBe("en");
    await waitFor(() => expect(calls("/api/concierge")).toHaveLength(1));
    expect(String((calls("/api/concierge")[0][1] as RequestInit).body)).toContain("Gift for my sister under $150");
    expect(localStorage.getItem(VOICE_ON_KEY)).toBe("1");
    // …and its reply is spoken.
    await waitFor(() => expect(calls("/api/voice/tts").length).toBeGreaterThan(0));
    act(() => sources[0]?.end());
  });
});
