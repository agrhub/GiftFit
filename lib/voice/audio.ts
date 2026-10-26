/**
 * Push-to-talk clip checks for POST /api/voice/stt (owner: A13, ADR-052). The clip is held in memory
 * only for the one Speech-to-Text call: it is never written to disk, logged or copied elsewhere.
 *
 * Limits: ≤ 1 MiB and ≤ 15 s (the widget auto-stops at 15 s; containers may report a few frames more,
 * hence the small tolerance). Accepted containers are what browsers' MediaRecorder produces and what
 * Speech-to-Text V2 auto-decodes: WebM/Opus (Chrome, Edge, Firefox, Safari 18.4+), Ogg/Opus, MP4/AAC
 * (older Safari). The duration is read from the container itself (never trusted from the client):
 * WebM block timestamps, the Ogg last granule position, MP4 mvhd or fragment sample durations.
 */

export const MAX_CLIP_BYTES = 1024 * 1024;
export const MAX_CLIP_SECONDS = 15;
/** Container rounding / last-frame slack on top of MAX_CLIP_SECONDS. */
export const CLIP_SECONDS_TOLERANCE = 0.5;

export type ClipContainer = "webm" | "ogg" | "mp4";

const MIME_TO_CONTAINER: Record<string, ClipContainer> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
};

/** The container a Content-Type declares (parameters like `;codecs=opus` ignored), else null. */
export function containerFromContentType(contentType: string | null | undefined): ClipContainer | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return MIME_TO_CONTAINER[base] ?? null;
}

/** The container the bytes actually are (magic numbers), else null. */
export function sniffContainer(b: Uint8Array): ClipContainer | null {
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "ogg";
  if (b.length >= 8 && ascii(b, 4, 4) === "ftyp") return "mp4";
  return null;
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = "";
  for (let i = at; i < at + len && i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return s;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// ---- WebM / Matroska (EBML) ------------------------------------------------------------------------

const EBML_ID = {
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
} as const;
const EBML_MASTERS = new Set<number>([EBML_ID.segment, EBML_ID.info, EBML_ID.cluster, EBML_ID.blockGroup]);

function readVint(b: Uint8Array, pos: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  if (pos >= b.length) return null;
  const first = b[pos];
  if (first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1;
  if (len > 8 || pos + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readUint(b: Uint8Array, pos: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i += 1) v = v * 256 + b[pos + i];
  return v;
}

/** Seconds covered by a WebM clip (last block timestamp; the Info Duration when present), else null. */
export function webmDurationSeconds(b: Uint8Array): number | null {
  let pos = 0;
  let scale = 1_000_000; // ns per timecode tick (Matroska default)
  let infoDuration: number | null = null;
  let clusterTc = 0;
  let maxTc = -1;
  let guard = 0;
  while (pos < b.length && guard++ < 200_000) {
    const id = readVint(b, pos, true);
    if (!id) break;
    const size = readVint(b, pos + id.len, false);
    if (!size) break;
    const start = pos + id.len + size.len;
    if (EBML_MASTERS.has(id.value)) {
      pos = start; // descend (sizes may be "unknown" in live MediaRecorder output)
      continue;
    }
    if (size.unknown || start + size.value > b.length) break; // truncated: use what was seen
    if (id.value === EBML_ID.timecodeScale) scale = readUint(b, start, size.value) || scale;
    else if (id.value === EBML_ID.duration) infoDuration = size.value === 8 ? view(b).getFloat64(start) : size.value === 4 ? view(b).getFloat32(start) : null;
    else if (id.value === EBML_ID.timecode) clusterTc = readUint(b, start, size.value);
    else if (id.value === EBML_ID.simpleBlock || id.value === EBML_ID.block) {
      const track = readVint(b, start, false);
      if (track && start + track.len + 2 <= b.length) {
        const rel = view(b).getInt16(start + track.len);
        maxTc = Math.max(maxTc, clusterTc + rel);
      }
    }
    pos = start + size.value;
  }
  const fromBlocks = maxTc >= 0 ? (maxTc * scale) / 1e9 : null;
  const fromInfo = infoDuration !== null && Number.isFinite(infoDuration) && infoDuration > 0 ? (infoDuration * scale) / 1e9 : null;
  if (fromBlocks === null) return fromInfo;
  return fromInfo === null ? fromBlocks : Math.max(fromBlocks, fromInfo);
}

// ---- Ogg / Opus ------------------------------------------------------------------------------------

/** Seconds of an Ogg Opus clip: (last granule position − pre-skip) / 48 kHz, else null. */
export function oggOpusDurationSeconds(b: Uint8Array): number | null {
  const v = view(b);
  let preSkip = -1;
  for (let i = 0; i + 12 <= b.length && i < 4096; i += 1) {
    if (ascii(b, i, 8) === "OpusHead") {
      preSkip = v.getUint16(i + 10, true);
      break;
    }
  }
  if (preSkip < 0) return null; // not Opus (granules would not be 48 kHz samples)
  let granule = -1;
  for (let i = b.length - 27; i >= 0; i -= 1) {
    if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) {
      const lo = v.getUint32(i + 6, true);
      const hi = v.getUint32(i + 10, true);
      if (hi === 0xffffffff && lo === 0xffffffff) continue; // page with no completed packet
      granule = hi * 2 ** 32 + lo;
      break;
    }
  }
  if (granule < 0) return null;
  return Math.max(0, granule - preSkip) / 48_000;
}

// ---- MP4 / AAC -------------------------------------------------------------------------------------

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  const v = view(b);
  let pos = from;
  while (pos + 8 <= to) {
    let size = v.getUint32(pos);
    const type = ascii(b, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) return;
      size = v.getUint32(pos + 8) * 2 ** 32 + v.getUint32(pos + 12);
      header = 16;
    } else if (size === 0) size = to - pos;
    if (size < header) return;
    const end = Math.min(pos + size, to);
    yield { type, start: pos + header, end };
    pos += size;
  }
}

function child(b: Uint8Array, parent: Box, type: string): Box | undefined {
  for (const c of boxes(b, parent.start, parent.end)) if (c.type === type) return c;
  return undefined;
}

/** mvhd / mdhd: { timescale, duration } (full box, version 0 or 1). */
function timeHeader(b: Uint8Array, box: Box): { timescale: number; duration: number } | null {
  const v = view(b);
  if (box.end - box.start < 24) return null;
  const version = b[box.start];
  if (version === 1) {
    if (box.end - box.start < 36) return null;
    return { timescale: v.getUint32(box.start + 20), duration: v.getUint32(box.start + 24) * 2 ** 32 + v.getUint32(box.start + 28) };
  }
  return { timescale: v.getUint32(box.start + 12), duration: v.getUint32(box.start + 16) };
}

/** Seconds of an MP4 clip: mvhd duration, or (fragmented MediaRecorder output) the summed sample durations. */
export function mp4DurationSeconds(b: Uint8Array): number | null {
  const v = view(b);
  const top: Box = { type: "", start: 0, end: b.length };
  const moov = child(b, top, "moov");
  if (!moov) return null;
  const mvhd = child(b, moov, "mvhd");
  const mv = mvhd ? timeHeader(b, mvhd) : null;
  if (mv && mv.timescale > 0 && mv.duration > 0 && mv.duration < 0xffffffff) return mv.duration / mv.timescale;
  // Fragmented: track timescale from the first trak's mdhd, default duration from mvex/trex.
  const trak = child(b, moov, "trak");
  const mdia = trak && child(b, trak, "mdia");
  const mdhd = mdia && child(b, mdia, "mdhd");
  const md = mdhd ? timeHeader(b, mdhd) : null;
  if (md && md.timescale > 0 && md.duration > 0 && md.duration < 0xffffffff) return md.duration / md.timescale;
  const timescale = md?.timescale || 0;
  if (!timescale) return null;
  const mvex = child(b, moov, "mvex");
  const trex = mvex && child(b, mvex, "trex");
  const trexDefault = trex && trex.end - trex.start >= 16 ? v.getUint32(trex.start + 12) : 0;
  let total = 0;
  let sawFragment = false;
  for (const moof of boxes(b, 0, b.length)) {
    if (moof.type !== "moof") continue;
    for (const traf of boxes(b, moof.start, moof.end)) {
      if (traf.type !== "traf") continue;
      let defaultDur = trexDefault;
      const tfhd = child(b, traf, "tfhd");
      if (tfhd) {
        const flags = v.getUint32(tfhd.start) & 0xffffff;
        let p = tfhd.start + 8; // version/flags + track_ID
        if (flags & 0x01) p += 8;
        if (flags & 0x02) p += 4;
        if (flags & 0x08 && p + 4 <= tfhd.end) defaultDur = v.getUint32(p);
      }
      for (const trun of boxes(b, traf.start, traf.end)) {
        if (trun.type !== "trun" || trun.end - trun.start < 8) continue;
        sawFragment = true;
        const flags = v.getUint32(trun.start) & 0xffffff;
        const count = v.getUint32(trun.start + 4);
        let p = trun.start + 8;
        if (flags & 0x01) p += 4;
        if (flags & 0x04) p += 4;
        const perSample = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
        if (!(flags & 0x100)) {
          total += count * defaultDur;
          continue;
        }
        for (let i = 0; i < count && p + perSample <= trun.end; i += 1, p += perSample) total += v.getUint32(p);
      }
    }
  }
  return sawFragment ? total / timescale : null;
}

/** Container duration in seconds, or null when it cannot be read. */
export function clipDurationSeconds(container: ClipContainer, b: Uint8Array): number | null {
  try {
    const s = container === "webm" ? webmDurationSeconds(b) : container === "ogg" ? oggOpusDurationSeconds(b) : mp4DurationSeconds(b);
    return s !== null && Number.isFinite(s) && s >= 0 ? s : null;
  } catch {
    return null;
  }
}

export type ClipCheck =
  | { ok: true; container: ClipContainer; seconds: number | null; bytes: number }
  | { ok: false; status: 400; error: "bad_audio" | "too_long" | "too_large" };

/** Validates a clip's declared type, real container, size and duration. */
export function checkClip(contentType: string | null, bytes: Uint8Array): ClipCheck {
  const declared = containerFromContentType(contentType);
  if (!declared) return { ok: false, status: 400, error: "bad_audio" };
  if (bytes.length > MAX_CLIP_BYTES) return { ok: false, status: 400, error: "too_large" };
  if (bytes.length < 16) return { ok: false, status: 400, error: "bad_audio" };
  const actual = sniffContainer(bytes);
  if (actual !== declared) return { ok: false, status: 400, error: "bad_audio" };
  const seconds = clipDurationSeconds(actual, bytes);
  if (seconds !== null && seconds > MAX_CLIP_SECONDS + CLIP_SECONDS_TOLERANCE) return { ok: false, status: 400, error: "too_long" };
  return { ok: true, container: actual, seconds, bytes: bytes.length };
}

export type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; error: "too_large" | "bad_audio" };

/**
 * Reads a request body into memory, stopping as soon as it passes `max` bytes (Content-Length is
 * checked first). Nothing is written anywhere.
 */
export async function readBodyLimited(req: Request, max: number = MAX_CLIP_BYTES): Promise<BodyRead> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { ok: false, error: "too_large" };
  if (!req.body) return { ok: false, error: "bad_audio" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "bad_audio" };
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes: out };
}
