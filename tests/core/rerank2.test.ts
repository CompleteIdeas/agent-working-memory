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

  describe('near-ties — the blend (recency) decides when the cross-encoder cannot', () => {
    // MWA, 0.18.1: three same-topic facts from October, December and March
    // scored within hundredths for "what did the club most recently choose",
    // and the newest came last. `score` is the Phase 7 blend, which carries decay.
    const b = (id: string, rerankerScore: number, score: number) => ({ id, phaseScores: { rerankerScore }, score });

    const withEps = (eps: string | undefined, fn: () => void) => {
      const saved = process.env.AWM_RERANK2_TIE_EPS;
      if (eps === undefined) delete process.env.AWM_RERANK2_TIE_EPS; else process.env.AWM_RERANK2_TIE_EPS = eps;
      try { fn(); } finally {
        if (saved === undefined) delete process.env.AWM_RERANK2_TIE_EPS; else process.env.AWM_RERANK2_TIE_EPS = saved;
      }
    };

    it('by default the reranker order stands even on near-ties (an epsilon of 0.03 measured -14pp s@1)', () => {
      withEps(undefined, () => {
        const out = reorderByReranker([b('dec', 0.81, 0.60), b('oct', 0.80, 0.55), b('mar', 0.79, 0.70)], 10);
        expect(ids(out)).toBe('dec,oct,mar');
      });
    });

    it('with an experimental epsilon, near-equal reranker scores go to the blend', () => {
      withEps('0.03', () => {
        const out = reorderByReranker([b('dec', 0.81, 0.60), b('oct', 0.80, 0.55), b('mar', 0.79, 0.70)], 10);
        expect(ids(out)).toBe('mar,dec,oct');
      });
    });

    it('a clear reranker lead wins over a better blend whatever the epsilon', () => {
      withEps('0.03', () => {
        const out = reorderByReranker([b('a', 0.60, 0.90), b('b', 0.90, 0.50)], 10);
        expect(ids(out)).toBe('b,a');
      });
    });
  });

  describe('stale penalty — a superseded or expired memory cannot win the window', () => {
    // Phase 8c marks superseded / expired / not-yet-valid rows with
    // stalePenalty 0.15. Before 2026-10-19 this stage ignored it and sorted by
    // raw reranker score, so the MWA probe saw the superseded "flat list" at
    // rank 1 above its successor "Team heading" (reranker 0.087 blended, but
    // the cross-encoder liked its wording). This pins the fix.
    const stale = (id: string, rerankerScore: number) =>
      ({ id, phaseScores: { rerankerScore, stalePenalty: 0.15 } });

    it('sorts a stale row below a current one the cross-encoder liked less', () => {
      const out = reorderByReranker([stale('old', 0.95), r('new', 0.60), r('other', 0.40)], 10);
      expect(ids(out)).toBe('new,other,old');
    });

    it('keeps reranker order among current rows', () => {
      const out = reorderByReranker([r('a', 0.5), stale('old', 0.99), r('b', 0.9)], 10);
      expect(ids(out)).toBe('b,a,old');
    });

    it('still orders stale rows among themselves by reranker score', () => {
      const out = reorderByReranker([stale('x', 0.3), stale('y', 0.8)], 10);
      expect(ids(out)).toBe('y,x');
    });

    it('a stale row with a huge reranker lead still loses: the factor is multiplicative, not a tie-break', () => {
      // 0.99 × 0.15 = 0.1485 < 0.20
      const out = reorderByReranker([stale('old', 0.99), r('new', 0.20)], 10);
      expect(ids(out)).toBe('new,old');
    });
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

  it('is ON unless explicitly disabled (default since 2026-10-19)', () => {
    // It was opt-in from 2026-08-24; a config that forgot the string ran
    // degraded for 47 days unnoticed. The code now does the measured-good
    // thing when nothing is set, and `0` is the escape hatch.
    delete process.env.AWM_RERANK2;
    expect(rerank2Enabled()).toBe(true);
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
