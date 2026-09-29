// lab/fixtures/gen/src/prng.ts
// xmur3 string hash feeding mulberry32. Deterministic across platforms.

export interface Prng {
  next(): number;            // [0, 1)
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePrng(seed: string): Prng {
  const rand = mulberry32(xmur3(seed)());
  return {
    next: rand,
    int: (maxExclusive: number) => Math.floor(rand() * maxExclusive),
    pick: <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!,
  };
}
