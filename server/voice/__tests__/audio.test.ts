import { describe, expect, it } from "vitest";
import {
  checkClip,
  clipDurationSeconds,
  containerFromContentType,
  MAX_CLIP_BYTES,
  mp4DurationSeconds,
  oggOpusDurationSeconds,
  readBodyLimited,
  sniffContainer,
  webmDurationSeconds,
} from "../audio";
import { fragmentedMp4Clip, mp4Clip, oggOpusClip, webmClip } from "./containers";

const steps = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

describe("container types", () => {
  it("maps MediaRecorder content types and ignores parameters", () => {
    expect(containerFromContentType("audio/webm;codecs=opus")).toBe("webm");
    expect(containerFromContentType("audio/ogg; codecs=opus")).toBe("ogg");
    expect(containerFromContentType("AUDIO/MP4")).toBe("mp4");
    expect(containerFromContentType("audio/wav")).toBeNull();
    expect(containerFromContentType("application/octet-stream")).toBeNull();
    expect(containerFromContentType(null)).toBeNull();
  });

  it("sniffs the real container from magic bytes", () => {
    expect(sniffContainer(webmClip([{ tc: 0, rels: [0] }]))).toBe("webm");
    expect(sniffContainer(oggOpusClip(1))).toBe("ogg");
    expect(sniffContainer(mp4Clip(1))).toBe("mp4");
    expect(sniffContainer(new TextEncoder().encode("RIFF....WAVEfmt "))).toBeNull();
  });
});

describe("duration probes", () => {
  it("WebM: last block timestamp across clusters (unknown-size segment and clusters)", () => {
    const clip = webmClip([
      { tc: 0, rels: steps(0, 9980, 20) },
      { tc: 10_000, rels: steps(0, 4980, 20) },
    ]);
    expect(webmDurationSeconds(clip)).toBeCloseTo(14.98, 2);
  });

  it("WebM: honours TimecodeScale and the Info Duration when longer", () => {
    expect(webmDurationSeconds(webmClip([{ tc: 0, rels: [0, 500] }], { scaleNs: 2_000_000 }))).toBeCloseTo(1.0, 3);
    expect(webmDurationSeconds(webmClip([{ tc: 0, rels: [0, 500] }], { infoDurationTicks: 20_000 }))).toBeCloseTo(20, 3);
  });

  it("WebM: a truncated clip still reports what it saw", () => {
    const clip = webmClip([{ tc: 0, rels: steps(0, 3000, 20) }]);
    expect(webmDurationSeconds(clip.subarray(0, clip.length - 3))).toBeCloseTo(2.98, 2);
  });

  it("Ogg Opus: last granule minus pre-skip at 48 kHz; non-Opus is unknown", () => {
    expect(oggOpusDurationSeconds(oggOpusClip(4.5))).toBeCloseTo(4.5, 3);
    const vorbis = oggOpusClip(4.5);
    vorbis.set(new TextEncoder().encode("VorbHead"), 28);
    expect(oggOpusDurationSeconds(vorbis)).toBeNull();
  });

  it("MP4: mvhd duration, or summed fragment sample durations (Safari)", () => {
    expect(mp4DurationSeconds(mp4Clip(4.2))).toBeCloseTo(4.2, 3);
    // 3 explicit samples of 48000 + 10 default samples of 1024 at 48 kHz
    expect(mp4DurationSeconds(fragmentedMp4Clip([48_000, 48_000, 48_000], 10))).toBeCloseTo(3 + 10240 / 48_000, 4);
  });

  it("garbage never throws", () => {
    const junk = new Uint8Array(512).map((_, i) => (i * 37) & 0xff);
    for (const c of ["webm", "ogg", "mp4"] as const) expect(() => clipDurationSeconds(c, junk)).not.toThrow();
  });
});

describe("checkClip", () => {
  it("accepts a ≤ 15 s clip of the declared type", () => {
    const r = checkClip("audio/webm;codecs=opus", webmClip([{ tc: 0, rels: steps(0, 4980, 20) }]));
    expect(r).toMatchObject({ ok: true, container: "webm" });
    if (r.ok) expect(r.seconds).toBeCloseTo(4.98, 2);
  });

  it("rejects longer than 15 s (with a small container tolerance)", () => {
    expect(checkClip("audio/ogg", oggOpusClip(15.4)).ok).toBe(true);
    expect(checkClip("audio/ogg", oggOpusClip(16))).toEqual({ ok: false, status: 400, error: "too_long" });
    expect(checkClip("audio/mp4", mp4Clip(20))).toEqual({ ok: false, status: 400, error: "too_long" });
  });

  it("rejects a type mismatch, an unsupported type, tiny bodies and oversize bodies", () => {
    expect(checkClip("audio/mp4", oggOpusClip(1))).toMatchObject({ error: "bad_audio" });
    expect(checkClip("audio/wav", oggOpusClip(1))).toMatchObject({ error: "bad_audio" });
    expect(checkClip("audio/webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toMatchObject({ error: "bad_audio" });
    const big = new Uint8Array(MAX_CLIP_BYTES + 1);
    big.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(checkClip("audio/webm", big)).toMatchObject({ error: "too_large" });
  });

  it("accepts a recognised container whose duration cannot be read (reserved as 15 s by the caller)", () => {
    const r = checkClip("audio/mp4", new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode("ftypM4A "), 0, 0, 0, 0]));
    expect(r).toMatchObject({ ok: true, seconds: null });
  });
});

describe("readBodyLimited", () => {
  const req = (body: BodyInit, headers: Record<string, string> = {}) => new Request("https://x.test/api/voice/stt", { method: "POST", body, headers });

  it("reads a body under the limit", async () => {
    const r = await readBodyLimited(req(new Uint8Array([1, 2, 3])), 10);
    expect(r).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  it("refuses by Content-Length before reading, and while streaming", async () => {
    expect(await readBodyLimited(req(new Uint8Array(4), { "content-length": "4000" }), 10)).toEqual({ ok: false, error: "too_large" });
    expect(await readBodyLimited(req(new Uint8Array(11)), 10)).toEqual({ ok: false, error: "too_large" });
  });
});
