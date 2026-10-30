/**
 * Minimal QR Code encoder (owner: A4). Byte mode, versions 1–10, error correction L/M/Q/H.
 * Written here because the brief forbids new packages; follows ISO/IEC 18004 (the same structure
 * as Project Nayuki's reference encoder). A Fit Request link is ~80 bytes, which fits version 5–6
 * at level M. Pure and deterministic; unit-tested against published vectors.
 */

export type EccLevel = "L" | "M" | "Q" | "H";

const ECC_ORDINAL: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Format-information bits for each level (L=01, M=00, Q=11, H=10). */
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index 0 unused. Versions 1..10 only.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
];
export const MAX_VERSION = 10;

export interface QrCode {
  version: number;
  size: number;
  ecc: EccLevel;
  mask: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

export function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function numDataCodewords(ver: number, ecc: EccLevel): number {
  const e = ECC_ORDINAL[ecc];
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
}

// ---- Reed–Solomon over GF(2^8) with polynomial 0x11D ----

export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---- Data encoding ----

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function encodeData(bytes: readonly number[], ver: number, ecc: EccLevel): number[] | null {
  const capacityBits = numDataCodewords(ver, ecc) * 8;
  const countBits = ver <= 9 ? 8 : 16;
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  if (bits.length > capacityBits) return null;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  for (let pad = 0xec; out.length < capacityBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function addEccAndInterleave(data: readonly number[], ver: number, ecc: EccLevel): number[] {
  const e = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ---- Matrix ----

export function formatBits(ecc: EccLevel, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

class Matrix {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFunction(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFunctionPatterns(m: Matrix, ver: number, ecc: EccLevel) {
  const size = m.size;
  for (let i = 0; i < size; i++) {
    m.setFunction(6, i, i % 2 === 0);
    m.setFunction(i, 6, i % 2 === 0);
  }
  const finder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) m.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const pos = alignmentPositions(ver, size);
  const n = pos.length;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.setFunction(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  drawFormat(m, ecc, 0);
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.setFunction(a, b, bit);
      m.setFunction(b, a, bit);
    }
  }
}

function drawFormat(m: Matrix, ecc: EccLevel, mask: number) {
  const bits = formatBits(ecc, mask);
  const size = m.size;
  for (let i = 0; i <= 5; i++) m.setFunction(8, i, getBit(bits, i));
  m.setFunction(8, 7, getBit(bits, 6));
  m.setFunction(8, 8, getBit(bits, 7));
  m.setFunction(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i++) m.setFunction(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) m.setFunction(8, size - 15 + i, getBit(bits, i));
  m.setFunction(8, size - 8, true);
}

function drawCodewords(m: Matrix, data: readonly number[]) {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.isFunction[y][x] && i < data.length * 8) {
          m.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
  }
}

export function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number) {
  for (let y = 0; y < m.size; y++)
    for (let x = 0; x < m.size; x++) if (!m.isFunction[y][x] && maskApplies(mask, x, y)) m.modules[y][x] = !m.modules[y][x];
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

/** ISO penalty rules N1–N4 (N3 as a plain pattern scan). Lower is better. */
export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
    for (let i = 0; i + 11 <= size; i++) for (const pat of FINDER_LIKE) if (pat.every((v, k) => get(i + k) === v)) score += 40;
  };
  for (let y = 0; y < size; y++) line((i) => modules[y][i]);
  for (let x = 0; x < size; x++) line((i) => modules[i][x]);
  let dark = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x + 1 < size && y + 1 < size) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
  const total = size * size;
  score += Math.ceil(Math.abs(dark * 20 - total * 10) / total - 1) * 10;
  return score;
}

/** Encode text (UTF-8, byte mode) at the smallest version that fits; raises ECC when it is free. */
export function encodeQr(text: string, minEcc: EccLevel = "M"): QrCode {
  const bytes = utf8Bytes(text);
  for (let ver = 1; ver <= MAX_VERSION; ver++) {
    if (!encodeData(bytes, ver, minEcc)) continue;
    let ecc = minEcc;
    for (const higher of ["M", "Q", "H"] as EccLevel[]) if (ECC_ORDINAL[higher] > ECC_ORDINAL[ecc] && encodeData(bytes, ver, higher)) ecc = higher;
    const data = encodeData(bytes, ver, ecc)!;
    const codewords = addEccAndInterleave(data, ver, ecc);
    const size = ver * 4 + 17;
    let best: { mask: number; modules: boolean[][]; score: number } | null = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = new Matrix(size);
      drawFunctionPatterns(m, ver, ecc);
      drawCodewords(m, codewords);
      applyMask(m, mask);
      drawFormat(m, ecc, mask);
      const score = penalty(m.modules);
      if (!best || score < best.score) best = { mask, modules: m.modules, score };
    }
    return { version: ver, size, ecc, mask: best!.mask, modules: best!.modules };
  }
  throw new RangeError(`Text too long for a version ${MAX_VERSION} QR code`);
}
