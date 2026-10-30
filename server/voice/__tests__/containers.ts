/** Tiny synthetic WebM / Ogg Opus / MP4 clips for the duration probes (headers only, no real audio). */

const u8 = (...parts: Array<number[] | Uint8Array>) => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// ---- WebM ----
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const ebml = (id: number[], payload: number[] | Uint8Array) => u8(id, [0x80 | payload.length], payload);

/** A WebM clip whose clusters hold SimpleBlocks at `tc + rel` ms (live-recorder style: unknown sizes). */
export function webmClip(clusters: Array<{ tc: number; rels: number[] }>, opts: { scaleNs?: number; infoDurationTicks?: number } = {}): Uint8Array {
  const scale = opts.scaleNs ?? 1_000_000;
  const info = [...ebml([0x2a, 0xd7, 0xb1], [(scale >>> 16) & 0xff, (scale >>> 8) & 0xff, scale & 0xff])];
  if (opts.infoDurationTicks !== undefined) {
    const f = new DataView(new ArrayBuffer(8));
    f.setFloat64(0, opts.infoDurationTicks);
    info.push(...ebml([0x44, 0x89], new Uint8Array(f.buffer)));
  }
  const parts: Array<number[] | Uint8Array> = [ebml([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, ...ascii("webm")]), [0x18, 0x53, 0x80, 0x67], UNKNOWN, ebml([0x15, 0x49, 0xa9, 0x66], info)];
  for (const c of clusters) {
    parts.push([0x1f, 0x43, 0xb6, 0x75], UNKNOWN, ebml([0xe7], [(c.tc >>> 8) & 0xff, c.tc & 0xff]));
    for (const r of c.rels) parts.push(ebml([0xa3], [0x81, (r >>> 8) & 0xff, r & 0xff, 0x80, 0xfc, 0xff, 0xfe]));
  }
  return u8(...parts);
}

// ---- Ogg Opus ----
function oggPage(granule: number, data: number[]): number[] {
  const lo = granule % 2 ** 32;
  const hi = Math.floor(granule / 2 ** 32);
  return [...ascii("OggS"), 0, 0, ...le32(lo), ...le32(hi), ...le32(1), ...le32(0), ...le32(0), 1, data.length, ...data];
}

export function oggOpusClip(seconds: number, preSkip = 312): Uint8Array {
  const head = [...ascii("OpusHead"), 1, 1, preSkip & 0xff, preSkip >> 8, ...le32(48_000), 0, 0, 0];
  const tags = [...ascii("OpusTags"), ...le32(0), ...le32(0)];
  return u8(oggPage(0, head), oggPage(0, tags), oggPage(48_000, new Array(40).fill(1)), oggPage(Math.round(seconds * 48_000) + preSkip, new Array(40).fill(2)));
}

// ---- MP4 ----
const box = (type: string, ...payload: Array<number[] | Uint8Array>) => {
  const body = u8(...payload);
  return u8(be32(8 + body.length), ascii(type), body);
};
const full = (type: string, version: number, flags: number, ...payload: Array<number[] | Uint8Array>) => box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...payload);
const timeHeader = (type: "mvhd" | "mdhd", timescale: number, duration: number) => full(type, 0, 0, be32(0), be32(0), be32(timescale), be32(duration), new Array(type === "mvhd" ? 80 : 4).fill(0));

export function mp4Clip(seconds: number): Uint8Array {
  return u8(box("ftyp", ascii("M4A "), be32(0)), box("moov", timeHeader("mvhd", 1000, Math.round(seconds * 1000))), box("mdat", new Array(64).fill(0)));
}

/** Fragmented MP4 (Safari MediaRecorder style): durations only in moof/traf/trun. */
export function fragmentedMp4Clip(sampleDurations: number[], defaultCount: number, timescale = 48_000, defaultDur = 1024): Uint8Array {
  const moov = box(
    "moov",
    timeHeader("mvhd", 1000, 0),
    box("trak", box("mdia", timeHeader("mdhd", timescale, 0))),
    box("mvex", full("trex", 0, 0, be32(1), be32(1), be32(defaultDur), be32(0), be32(0))),
  );
  const explicit = box("moof", box("traf", full("tfhd", 0, 0, be32(1)), full("trun", 0, 0x100, be32(sampleDurations.length), ...sampleDurations.map(be32))));
  const implicit = box("moof", box("traf", full("tfhd", 0, 0, be32(1)), full("trun", 0, 0x200, be32(defaultCount), ...new Array(defaultCount).fill(0).map(() => be32(10)))));
  return u8(box("ftyp", ascii("iso5"), be32(0)), moov, explicit, box("mdat", [0, 0]), implicit, box("mdat", [0, 0]));
}
