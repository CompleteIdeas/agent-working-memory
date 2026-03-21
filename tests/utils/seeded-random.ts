/**
 * Seedable PRNG for deterministic test runs.
 *
 * Uses mulberry32 — a simple, fast 32-bit PRNG.
 * Pass AWM_TEST_SEED env var to fix the seed; otherwise uses Date.now().
 *
 * Usage:
 *   import { createRng } from '../utils/seeded-random.js';
 *   const rng = createRng();
 *   rng();          // 0-1 float (replaces Math.random())
 *   rng.seed        // the seed used (logged for reproducibility)
 */

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeededRng {
  (): number;
  seed: number;
}

export function createRng(explicitSeed?: number): SeededRng {
  const seed = explicitSeed
    ?? (process.env.AWM_TEST_SEED ? parseInt(process.env.AWM_TEST_SEED, 10) : Date.now());
  const fn = mulberry32(seed) as SeededRng;
  fn.seed = seed;
  console.log(`[rng] seed=${seed}${process.env.AWM_TEST_SEED ? ' (from AWM_TEST_SEED)' : ' (random — set AWM_TEST_SEED to reproduce)'}`);
  return fn;
}
