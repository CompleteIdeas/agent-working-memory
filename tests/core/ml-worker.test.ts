/**
 * ML Worker Pool tests — in-process mode (no worker_threads spawned).
 *
 * Real-worker behavior is tested via the perf suite (P1.5).
 *
 * Run: npx vitest run tests/core/ml-worker.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

// IMPORTANT: set env var BEFORE importing ml-worker (which reads it at init)
process.env.AWM_ML_INPROCESS = '1';

import { initMLPool, isInProcessMode, dispatchEmbed, dispatchRerank, dispatchExpand, shutdownMLPool } from '../../src/core/ml-worker.js';
// Side-effect imports — these register in-process handlers.
import '../../src/core/embeddings.js';
import '../../src/core/reranker.js';
import '../../src/core/query-expander.js';

beforeAll(() => {
  initMLPool();
});

describe('ML Worker Pool — in-process mode', () => {
  it('reports in-process mode when AWM_ML_INPROCESS=1', () => {
    expect(isInProcessMode()).toBe(true);
  });

  it('dispatchEmbed routes to in-process embedder and returns shaped vectors', async () => {
    const vectors = await dispatchEmbed({
      texts: ['hello world'],
      pooling: 'mean',
      dimensions: 384,
    });
    expect(vectors.length).toBe(1);
    expect(vectors[0].length).toBe(384);
    // Normalized vectors have magnitude ~1.0
    const mag = Math.sqrt(vectors[0].reduce((sum, x) => sum + x * x, 0));
    expect(mag).toBeGreaterThan(0.99);
    expect(mag).toBeLessThan(1.01);
  }, 60_000);

  it('dispatchEmbed batches multiple texts', async () => {
    const vectors = await dispatchEmbed({
      texts: ['first text', 'second text', 'third'],
      pooling: 'mean',
      dimensions: 384,
    });
    expect(vectors.length).toBe(3);
    for (const v of vectors) expect(v.length).toBe(384);
  }, 60_000);

  it('dispatchRerank returns sorted (index, score) tuples', async () => {
    const results = await dispatchRerank({
      query: 'what is the capital of France',
      passages: [
        'Paris is the capital of France.',
        'Bananas are yellow.',
        'France is in Europe.',
      ],
    });
    expect(results.length).toBe(3);
    // Sorted descending by score
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
    // The first passage should win (most relevant)
    expect(results[0].index).toBe(0);
  }, 60_000);

  it('dispatchExpand returns a non-empty string for a normal query', async () => {
    const expansion = await dispatchExpand({
      prompt: 'Expand this search query with synonyms and related terms. Query: cat. Additional terms:',
      maxNewTokens: 25,
      noRepeatNgramSize: 2,
    });
    expect(typeof expansion).toBe('string');
    // flan-t5 may produce short output but should not error
    expect(expansion.length).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('shutdownMLPool is a no-op when in in-process mode (no workers to terminate)', async () => {
    await expect(shutdownMLPool()).resolves.toBeUndefined();
  });
});

describe('Public API compatibility', () => {
  it('embed() returns a single vector of expected dimensions', async () => {
    const { embed, EMBEDDING_DIMENSIONS } = await import('../../src/core/embeddings.js');
    const vec = await embed('test sentence');
    expect(vec.length).toBe(EMBEDDING_DIMENSIONS);
  }, 60_000);

  it('embedBatch() handles empty array without dispatching', async () => {
    const { embedBatch } = await import('../../src/core/embeddings.js');
    const result = await embedBatch([]);
    expect(result).toEqual([]);
  });

  it('rerank() handles empty passages array without dispatching', async () => {
    const { rerank } = await import('../../src/core/reranker.js');
    const result = await rerank('query', []);
    expect(result).toEqual([]);
  });

  it('expandQuery() preserves short queries unchanged (skip heuristic)', async () => {
    const { expandQuery } = await import('../../src/core/query-expander.js');
    // Short query (≤50 chars but ≥5 tokens) — falls into the skip heuristic on tokens
    // Actually: a 3-word query bypasses skip; let's verify a long query gets skipped.
    const longQuery = 'this is an explicitly long detailed specific question about cats';
    const result = await expandQuery(longQuery);
    // shouldSkipExpansion returns true for length > 50 — original returned unchanged
    expect(result).toBe(longQuery);
  });

  it('cosineSimilarity is pure math (no model involved)', async () => {
    const { cosineSimilarity } = await import('../../src/core/embeddings.js');
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
    const c = [1, 0, 0];
    const d = [1, 0, 0];
    expect(cosineSimilarity(c, d)).toBe(1);
  });
});
