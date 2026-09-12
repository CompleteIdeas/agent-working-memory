import { describe, it, expect } from 'vitest';
import { baseLevelActivation } from '../src/core/decay.js';

/**
 * 0.14.4: the benchmark drifted because ACT-R decay aged a frozen snapshot by the
 * wall clock. These pin the two facts the fix depends on:
 *   1. decay IS clock-sensitive at the magnitudes the eval saw (so pinning matters);
 *   2. the same (accessCount, age) always gives the same score (so pinning works).
 * The engine-level `query.now` plumbing is exercised end to end by
 * tests/realstore-eval/runner.ts, which prints "clock pinned to <snapshot ts>".
 */
describe('ACT-R decay and the eval clock', () => {
  it('a 20-hour age difference moves the decay term measurably for young memories', () => {
    const young = baseLevelActivation(2, 18);
    const youngLater = baseLevelActivation(2, 18 + 20 / 24);
    expect(youngLater).toBeLessThan(young);
    expect(young - youngLater).toBeGreaterThan(0.01);   // enough to flip near-tie top-1s
  });

  it('...and barely at all for old ones — which is why the gap was small but real', () => {
    const old = baseLevelActivation(3, 97);
    const oldLater = baseLevelActivation(3, 97 + 20 / 24);
    expect(old - oldLater).toBeGreaterThan(0);
    expect(old - oldLater).toBeLessThan(0.005);
  });

  it('is a pure function of (accessCount, ageDays): pinning the clock pins the score', () => {
    expect(baseLevelActivation(5, 30)).toBe(baseLevelActivation(5, 30));
    expect(baseLevelActivation(0, 0.5)).toBe(baseLevelActivation(0, 0.5));
  });
});
