import { describe, it, expect, afterEach } from 'vitest';
import { reorderByReranker, rerank2Enabled, rerank2WindowSize } from '../../src/core/rerank2.js';

/** Minimal stand-in for an activation result: an id plus a cross-encoder score. */
const r = (id: string, rerankerScore: number) => ({ id, phaseScores: { rerankerScore } });
const ids = (xs: Array<{ id: string }>) => xs.map(x => x.id).join(',');

describe('reorderByReranker', () => {
  it('re-sorts the window by reranker score', () => {
    // Blend order a,b,c — cross-encoder prefers b. This is the 38.6%-of-queries
    // disagreement the second stage exists to resolve.
    const out = reorderByReranker([r('a', 0.90), r('b', 0.99), r('c', 0.80)], 10);
    expect(ids(out)).toBe('b,a,c');
  });

  it('leaves the tail beyond k untouched', () => {
    const out = reorderByReranker(
      [r('a', 0.5), r('b', 0.9), r('c', 0.99), r('d', 0.98)], 2);
    // Only a,b are in the window; c,d keep their positions despite higher scores.
    expect(ids(out)).toBe('b,a,c,d');
  });

  it('never mutates the input array', () => {
    const input = [r('a', 0.5), r('b', 0.9)];
    const snapshot = ids(input);
    reorderByReranker(input, 10);
    expect(ids(input)).toBe(snapshot);
  });

  it('is a no-op when the order is already correct', () => {
    const out = reorderByReranker([r('a', 0.99), r('b', 0.5)], 10);
    expect(ids(out)).toBe('a,b');
  });

  describe('soundness guards — must return the input UNCHANGED', () => {
    // The reranker is wrapped in try/catch and a 10s timeout upstream. When it
    // does not run, every rerankerScore stays 0 — sorting on that would destroy
    // a perfectly good composite ordering. This is a real path, not theoretical.
    it('bails out when the reranker did not score the window', () => {
      const out = reorderByReranker([r('a', 0), r('b', 0), r('c', 0)], 10);
      expect(ids(out)).toBe('a,b,c');
    });

    it('bails out when even ONE item in the window is unscored', () => {
      const out = reorderByReranker([r('a', 0.5), r('b', 0), r('c', 0.99)], 10);
      expect(ids(out)).toBe('a,b,c');
    });

    it('bails out on NaN rather than producing an arbitrary order', () => {
      const out = reorderByReranker([r('a', 0.5), r('b', NaN), r('c', 0.9)], 10);
      expect(ids(out)).toBe('a,b,c');
    });

    it('ignores unscored items that sit OUTSIDE the window', () => {
      // Only the window needs valid scores; a zero further down is irrelevant.
      const out = reorderByReranker([r('a', 0.5), r('b', 0.9), r('c', 0)], 2);
      expect(ids(out)).toBe('b,a,c');
    });

    it('handles k larger than the array', () => {
      const out = reorderByReranker([r('a', 0.5), r('b', 0.9)], 999);
      expect(ids(out)).toBe('b,a');
    });

    it('handles empty, single-item, and k<=1 inputs', () => {
      expect(reorderByReranker([], 10)).toEqual([]);
      expect(ids(reorderByReranker([r('a', 0.5)], 10))).toBe('a');
      expect(ids(reorderByReranker([r('a', 0.5), r('b', 0.9)], 1))).toBe('a,b');
      expect(ids(reorderByReranker([r('a', 0.5), r('b', 0.9)], 0))).toBe('a,b');
    });
  });

  it('preserves every element — reordering must not drop or duplicate results', () => {
    const input = Array.from({ length: 25 }, (_, i) => r(`e${i}`, ((i * 37) % 100) / 100 + 0.01));
    const out = reorderByReranker(input, 10);
    expect(out).toHaveLength(input.length);
    expect(new Set(out.map(x => x.id)).size).toBe(input.length);
  });
});

describe('configuration', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.AWM_RERANK2 = saved.AWM_RERANK2;
    process.env.AWM_RERANK2_K = saved.AWM_RERANK2_K;
    if (saved.AWM_RERANK2 === undefined) delete process.env.AWM_RERANK2;
    if (saved.AWM_RERANK2_K === undefined) delete process.env.AWM_RERANK2_K;
  });

  it('is OFF unless explicitly enabled', () => {
    delete process.env.AWM_RERANK2;
    expect(rerank2Enabled()).toBe(false);
    process.env.AWM_RERANK2 = '0';
    expect(rerank2Enabled()).toBe(false);
    process.env.AWM_RERANK2 = '1';
    expect(rerank2Enabled()).toBe(true);
  });

  it('defaults the window to 10 and honours an override', () => {
    delete process.env.AWM_RERANK2_K;
    expect(rerank2WindowSize()).toBe(10);
    process.env.AWM_RERANK2_K = '5';
    expect(rerank2WindowSize()).toBe(5);
  });
});
