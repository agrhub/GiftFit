import { describe, expect, it } from "vitest";
import { type QrCode, encodeQr, formatBits, gfMultiply, maskApplies, numDataCodewords, rsDivisor, rsRemainder, versionBits } from "../qr";

/**
 * Independent reader for the round-trip test: spec tables (ISO 18004 Annex E alignment centres,
 * Table 9 block structure) rather than the encoder's own helpers.
 */
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
// [total codewords, ec per block, blocks] for level M, versions 1..10 (spec Table 9).
const M_BLOCKS: Record<number, [number, number, number]> = { 1: [26, 10, 1], 2: [44, 16, 1], 3: [70, 26, 1], 4: [100, 18, 2], 5: [134, 24, 2], 6: [172, 16, 4], 7: [196, 18, 4], 8: [242, 22, 4], 9: [292, 22, 5], 10: [346, 26, 5] };

function isReserved(v: number, size: number, x: number, y: number): boolean {
  if ((x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8)) return true;
  if (x === 6 || y === 6) return true;
  if (v >= 7 && ((x >= size - 11 && x < size - 8 && y < 6) || (y >= size - 11 && y < size - 8 && x < 6))) return true;
  const a = ALIGN[v];
  for (const cx of a)
    for (const cy of a) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === a[a.length - 1]) || (cx === a[a.length - 1] && cy === 6)) continue;
      if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
    }
  return false;
}

function readQr(qr: QrCode): string {
  const { size, version: v, modules } = qr;
  // Format info, first copy, then find which (level, mask) it is.
  let fmt = 0;
  [0, 1, 2, 3, 4, 5].forEach((i) => (fmt |= Number(modules[i][8]) << i));
  fmt |= Number(modules[7][8]) << 6;
  fmt |= Number(modules[8][8]) << 7;
  fmt |= Number(modules[8][7]) << 8;
  for (let i = 9; i < 15; i++) fmt |= Number(modules[8][14 - i]) << i;
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((m) => formatBits("M", m) === fmt);
  expect(mask).toBeDefined();
  const masked = (x: number, y: number) => [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0, (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][mask!];
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const y = upward ? size - 1 - k : k;
      for (const x of [col, col - 1]) if (!isReserved(v, size, x, y)) bits.push(Number(modules[y][x] !== masked(x, y)));
    }
    upward = !upward;
  }
  const [total, ec, nBlocks] = M_BLOCKS[v];
  const words = Array.from({ length: total }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  const dataTotal = total - ec * nBlocks;
  const shortData = Math.floor(dataTotal / nBlocks);
  const longCount = dataTotal % nBlocks;
  const blocks = Array.from({ length: nBlocks }, (_, b) => ({ data: [] as number[], ec: [] as number[], len: shortData + (b >= nBlocks - longCount ? 1 : 0) }));
  let k = 0;
  for (let i = 0; i < shortData + 1; i++) for (const b of blocks) if (i < b.len) b.data.push(words[k++]);
  for (let i = 0; i < ec; i++) for (const b of blocks) b.ec.push(words[k++]);
  // Every block's codeword polynomial must vanish at alpha^0..alpha^(ec-1).
  for (const b of blocks) {
    const cw = [...b.data, ...b.ec];
    let alpha = 1;
    for (let i = 0; i < ec; i++) {
      const syn = cw.reduce((acc, c) => gfMultiply(acc, alpha) ^ c, 0);
      expect(syn).toBe(0);
      alpha = gfMultiply(alpha, 2);
    }
  }
  const data = blocks.flatMap((b) => b.data);
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >> i) & 1));
  const take = (n: number, at: number) => stream.slice(at, at + n).reduce((a, b) => (a << 1) | b, 0);
  expect(take(4, 0)).toBe(0b0100);
  const countBits = v <= 9 ? 8 : 16;
  const len = take(countBits, 4);
  const bytes = Array.from({ length: len }, (_, i) => take(8, 4 + countBits + i * 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe("QR encoder", () => {
  it("Reed–Solomon matches the published 1-M 'HELLO WORLD' vector", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("GF(256) multiply is commutative and has identity 1", () => {
    expect(gfMultiply(0x53, 0xca)).toBe(gfMultiply(0xca, 0x53));
    expect(gfMultiply(1, 0xab)).toBe(0xab);
    expect(gfMultiply(2, 0x80)).toBe(0x1d);
  });

  it("format and version bits match the standard tables", () => {
    expect(formatBits("M", 0).toString(2).padStart(15, "0")).toBe("101010000010010");
    expect(formatBits("L", 0).toString(2).padStart(15, "0")).toBe("111011111000100");
    expect(formatBits("Q", 0).toString(2).padStart(15, "0")).toBe("011010101011111");
    expect(formatBits("H", 0).toString(2).padStart(15, "0")).toBe("001011010001001");
    expect(versionBits(7).toString(2).padStart(18, "0")).toBe("000111110010010100");
  });

  it("data capacities match the standard (byte-mode codewords)", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => numDataCodewords(v, "M"))).toEqual([16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
    expect([1, 5, 10].map((v) => numDataCodewords(v, "L"))).toEqual([19, 108, 274]);
    expect([1, 5, 10].map((v) => numDataCodewords(v, "H"))).toEqual([9, 46, 122]);
  });

  it("encodes a Fit Request link with finder patterns, timing and the dark module", () => {
    const url = "https://giftfit.example/r/" + "A".repeat(43);
    const qr = encodeQr(url);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.version).toBeLessThanOrEqual(6);
    const m = qr.modules;
    for (const [x0, y0] of [
      [0, 0],
      [qr.size - 7, 0],
      [0, qr.size - 7],
    ]) {
      // 7x7 finder: dark ring, light ring, dark 3x3 core.
      expect(m[y0][x0]).toBe(true);
      expect(m[y0 + 1][x0 + 1]).toBe(false);
      expect(m[y0 + 3][x0 + 3]).toBe(true);
    }
    for (let i = 8; i < qr.size - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    expect(m[qr.size - 8][8]).toBe(true);
  });

  it("writes the chosen mask into both format-info copies", () => {
    const qr = encodeQr("https://giftfit.example/r/token");
    const bits = formatBits(qr.ecc, qr.mask);
    const read = [0, 1, 2, 3, 4, 5].map((i) => qr.modules[i][8]);
    expect(read).toEqual([0, 1, 2, 3, 4, 5].map((i) => ((bits >>> i) & 1) === 1));
    const second = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => qr.modules[8][qr.size - 1 - i]);
    expect(second).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ((bits >>> i) & 1) === 1));
    expect(maskApplies(qr.mask, 0, 0)).toBeTypeOf("boolean");
  });

  it("round-trips through an independent reader (format, zigzag, RS syndromes, byte segment)", () => {
    let checked = 0;
    for (const text of ["https://giftfit.example/r/DvN_Z4fqUgZybqoS5nHY2q73qKXVnHn7gMjbj5z58Is", "hi", "https://aurum.example/g/" + "x".repeat(120), "Gift ✓ für dich"]) {
      const qr = encodeQr(text, "M");
      if (qr.ecc !== "M") continue; // the reader only knows level M tables
      expect(readQr(qr)).toBe(text);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("rejects text that does not fit version 10", () => {
    expect(() => encodeQr("x".repeat(400))).toThrow(RangeError);
  });
});
