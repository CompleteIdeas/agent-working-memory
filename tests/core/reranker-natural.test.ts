// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * 0.22 natural-language re-ranker switch (src/core/reranker.ts). The routing must be inert
 * unless AWM_RERANKER_MODEL_NATURAL names a different model, and the daemon must be told
 * about it so a spawned daemon loads the same pair. No model is loaded here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

async function fresh(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const r = await import('../../src/core/reranker.js');
  const w = await import('../../src/core/ml-worker.js');
  return { r, cfg: w.registeredInferenceConfig() };
}

afterEach(() => { delete process.env.AWM_RERANKER_MODEL_NATURAL; delete process.env.AWM_RERANKER_MODEL; vi.resetModules(); });

describe('natural-language re-ranker switch', () => {
  it('is off by default: one model, nothing new in the daemon config', async () => {
    const { r, cfg } = await fresh({ AWM_RERANKER_MODEL_NATURAL: undefined });
    expect(r.naturalRerankerModel()).toBeNull();
    expect(r.naturalRerankerActive()).toBe(false);
    expect(cfg.rerankModelNatural).toBeUndefined();
  });

  it("'off' and the main model's own id both mean off", async () => {
    expect((await fresh({ AWM_RERANKER_MODEL_NATURAL: 'off' })).r.naturalRerankerModel()).toBeNull();
    expect((await fresh({ AWM_RERANKER_MODEL_NATURAL: 'Xenova/ms-marco-MiniLM-L-6-v2' })).r.naturalRerankerModel()).toBeNull();
  });

  it('names the natural model and passes it to the daemon', async () => {
    const { r, cfg } = await fresh({ AWM_RERANKER_MODEL_NATURAL: 'cross-encoder/ettin-reranker-17m-v1' });
    expect(r.naturalRerankerModel()).toBe('cross-encoder/ettin-reranker-17m-v1');
    expect(r.naturalRerankerActive()).toBe(true);
    expect(cfg.rerankModelNatural).toBe('cross-encoder/ettin-reranker-17m-v1');
  });
});
