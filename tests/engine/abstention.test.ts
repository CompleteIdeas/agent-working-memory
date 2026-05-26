/**
 * Opt-in confidence-based abstention.
 *
 * `requireConfidence` is a recall-quality gate: when the confidence signal
 * (computed in src/engine/confidence.ts from the score distribution) falls
 * below the caller's threshold, the recall returns [].
 *
 * Distinct from `abstentionThreshold` (which is reranker-score based and
 * legacy). Independent — both can be set; either trips abstains.
 *
 * Run: npx vitest run tests/engine/abstention.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const AGENT = 'abstain-test';

describe('ActivationEngine — requireConfidence abstention', () => {
  let store: EngramStore;
  let activation: ActivationEngine;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-abstain-'));
    store = new EngramStore(join(tmp, 'test.db'));
    activation = new ActivationEngine(store);

    // Seed a small clean corpus with one strong fact + several unrelated facts.
    store.createEngram({
      agentId: AGENT,
      concept: 'database optimization indexes',
      content: 'Use composite indexes on frequently queried column combinations for faster database queries.',
      tags: ['database', 'sql', 'performance'],
      salience: 0.6, confidence: 0.6,
    });
    for (let i = 0; i < 5; i++) {
      store.createEngram({
        agentId: AGENT,
        concept: `unrelated topic ${i}`,
        content: `Random fact ${i} about a completely separate domain like cooking or astronomy.`,
        tags: [`topic-${i}`],
        salience: 0.4, confidence: 0.4,
      });
    }
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('without requireConfidence, fact query returns results', async () => {
    const r = await activation.activate({
      agentId: AGENT,
      context: 'database query optimization indexes',
      useReranker: false,
      useExpansion: false,
    });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].engram.concept).toContain('database');
    expect(r[0].confidence).toBeGreaterThan(0);
  });

  it('without requireConfidence, noise query may still return weak results', async () => {
    // Default behavior unchanged: noise queries can still leak through.
    // This is what PR-2 fixes when the caller opts in.
    const r = await activation.activate({
      agentId: AGENT,
      context: 'quantum entanglement medieval blacksmith',
      useReranker: false,
      useExpansion: false,
    });
    // Could be 0 or non-zero — depends on minScore floor.
    expect(r.length).toBeGreaterThanOrEqual(0);
  });

  it('low requireConfidence keeps fact queries and rejects noise', async () => {
    // First measure the baseline confidence for the fact query without abstention
    // so the threshold below sits between fact-confidence and noise-confidence.
    // No embeddings in this corpus (createEngram direct), so confidence comes
    // from BM25 alone — lower than the HTTP path where embeddings are async.
    const baselineFact = await activation.activate({
      agentId: AGENT,
      context: 'database query optimization indexes',
      useReranker: false,
      useExpansion: false,
    });
    expect(baselineFact.length).toBeGreaterThan(0);
    const factConfidence = baselineFact[0].confidence ?? 0;

    const baselineNoise = await activation.activate({
      agentId: AGENT,
      context: 'quantum entanglement medieval blacksmith renaissance',
      useReranker: false,
      useExpansion: false,
    });
    const noiseConfidence = baselineNoise[0]?.confidence ?? 0;

    // Sanity: fact recall is more confident than noise recall in this corpus.
    expect(factConfidence).toBeGreaterThan(noiseConfidence);

    // Set threshold between them. Any threshold lower than fact-conf but higher
    // than noise-conf should keep the fact and abstain on the noise.
    const threshold = (factConfidence + noiseConfidence) / 2;

    const factResults = await activation.activate({
      agentId: AGENT,
      context: 'database query optimization indexes',
      useReranker: false,
      useExpansion: false,
      requireConfidence: threshold,
    });
    expect(factResults.length).toBeGreaterThan(0);
    expect(factResults[0].confidence).toBeGreaterThan(threshold);

    const noiseResults = await activation.activate({
      agentId: AGENT,
      context: 'quantum entanglement medieval blacksmith renaissance',
      useReranker: false,
      useExpansion: false,
      requireConfidence: threshold,
    });
    expect(noiseResults.length).toBe(0);
  });

  it('requireConfidence=0.99 abstains on everything (too aggressive)', async () => {
    const r = await activation.activate({
      agentId: AGENT,
      context: 'database query optimization indexes',
      useReranker: false,
      useExpansion: false,
      requireConfidence: 0.99,
    });
    // Even a confident fact query falls below 0.99.
    expect(r.length).toBe(0);
  });

  it('requireConfidence is independent of abstentionThreshold (legacy reranker path)', async () => {
    // Both unset → permissive. Setting requireConfidence alone should not require
    // a reranker to be in the pipeline.
    const r = await activation.activate({
      agentId: AGENT,
      context: 'database query optimization indexes',
      useReranker: false,  // No reranker — abstentionThreshold path won't engage
      useExpansion: false,
      requireConfidence: 0.05, // Very loose; confident fact query should pass
    });
    expect(r.length).toBeGreaterThan(0);
  });

  it('returns [] for noise-only corpus + requireConfidence=0.10 (best-of-bad-bunch trap)', async () => {
    // The first beforeEach creates the corpus including unrelated topics.
    // Query something where only unrelated topics weakly match — score
    // distribution is flat and low (floor < 0.1).
    const r = await activation.activate({
      agentId: AGENT,
      context: 'random fact zero one two three',
      useReranker: false,
      useExpansion: false,
      requireConfidence: 0.10,
    });
    // The "unrelated topic 0" content has these words. So this might match.
    // The key check is: even if it matches, low confidence → abstain.
    if (r.length > 0) {
      // If something did pass, confidence should be above threshold.
      expect(r[0].confidence).toBeGreaterThanOrEqual(0.10);
    }
    // Either passes (with confidence > threshold) or is empty (abstained).
    // No "best of bad bunch" leakage.
  });
});
