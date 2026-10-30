/**
 * Deterministic, seedable randomness for decoy selection and carousel order.
 * Not cryptographic: the seed itself must be unguessable by the recipient (derive it from the
 * Fit Request id plus a server secret), and then every output is reproducible for audits and tests.
 */

/** FNV-1a 32-bit hash of a string. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: returns a function yielding floats in [0, 1). */
export function seededRandom(seed: string): () => number {
  let a = hashString(seed) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle driven by a seeded PRNG; returns a new array. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice();
  const rand = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Stable per-item tie-breaker in [0, 1) for a seed. */
export function seededKey(seed: string, id: string): number {
  return hashString(`${seed}\u0000${id}`) / 4294967296;
}
