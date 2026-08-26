/**
 * Embedding dimension-mismatch detection.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `cosineSimilarity` returns 0 when vector lengths differ. That is mathematically
 * correct and was, until 0.13.7, completely silent — across 7 call sites including
 * the recall scoring loop (`activation.ts`) and vector search (`sqlite.ts`).
 *
 * The failure it hides: a half-migrated corpus (AWM_EMBED_MODEL changed without a
 * re-embed, or a migration interrupted) makes every un-migrated memory score exactly
 * 0.0 on the vector channel. Recall still answers — BM25 is unaffected — so nothing
 * errors, nothing logs, and quality just quietly collapses for part of the store.
 *
 * This is the same shape as the eval-side bug that read as "bge-base is catastrophic"
 * when the real cause was a re-embed killed at 4,109/8,703. The eval scripts got a
 * completeness assertion; production had nothing until now.
 *
 * The contract under test is deliberately narrow, because the function runs in a hot
 * loop over every candidate on every recall:
 *   - it must NOT throw (that would turn degraded quality into an outage)
 *   - it must still return 0 (the maths is undefined)
 *   - it must COUNT the mismatch so /health and memory_whoami can report it
 *   - an empty vector must NOT count — that is a legitimate not-yet-embedded state
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  cosineSimilarity,
  embeddingHealth,
  __resetEmbeddingHealth,
} from '../../src/core/embeddings.js';

describe('embedding dimension integrity', () => {
  beforeEach(() => __resetEmbeddingHealth());
  afterEach(() => vi.restoreAllMocks());

  it('reports a clean corpus as having no mismatches', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(embeddingHealth().dimensionMismatches).toBe(0);
  });

  it('counts a dimension mismatch instead of silently scoring 0', () => {
    const a384 = new Array(384).fill(0.05);
    const b768 = new Array(768).fill(0.05);

    // The score is still 0 — that part of the old behaviour is correct and kept.
    expect(cosineSimilarity(a384, b768)).toBe(0);

    // But it is no longer invisible.
    const h = embeddingHealth();
    expect(h.dimensionMismatches).toBe(1);
    expect(h.sample).toEqual({ expected: 384, got: 768 });
  });

  it('does not throw — a hot-loop throw would escalate degraded quality to an outage', () => {
    const a = new Array(384).fill(0.1);
    const b = new Array(768).fill(0.1);
    expect(() => {
      for (let i = 0; i < 1000; i++) cosineSimilarity(a, b);
    }).not.toThrow();
    expect(embeddingHealth().dimensionMismatches).toBe(1000);
  });

  it('warns exactly once per process, never once per call', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = new Array(384).fill(0.1);
    const b = new Array(768).fill(0.1);

    for (let i = 0; i < 500; i++) cosineSimilarity(a, b);

    // 500 mismatches, 1 warning. Flooding stderr from the recall loop would be its
    // own outage, and a warning per call is a warning nobody reads.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('EMBEDDING DIMENSION MISMATCH');
    expect(embeddingHealth().dimensionMismatches).toBe(500);
  });

  it('does NOT count an empty vector — that is not-yet-embedded, not a mismatch', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);

    // A store mid-write legitimately holds engrams with no embedding yet. Counting
    // those would make the signal permanently noisy and therefore useless.
    expect(embeddingHealth().dimensionMismatches).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports the configured dimension so the operator knows which side is wrong', () => {
    cosineSimilarity(new Array(384).fill(0.1), new Array(512).fill(0.1));
    const h = embeddingHealth();
    expect(h.expectedDimensions).toBeGreaterThan(0);
    expect(h.sample).not.toBeNull();
  });
});
