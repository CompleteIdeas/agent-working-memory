import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { StagingBuffer } from '../../src/engine/staging.js';
import { EvictionEngine } from '../../src/engine/eviction.js';
import { RetractionEngine } from '../../src/engine/retraction.js';
import { EvalEngine } from '../../src/engine/eval.js';
import { evaluateSalience } from '../../src/core/salience.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/types/agent.js';
import { unlinkSync } from 'node:fs';

const TEST_DB = 'test-lifecycle.db';
const AGENT_ID = 'test-agent-001';

let store: EngramStore;
let activation: ActivationEngine;
let connections: ConnectionEngine;
let staging: StagingBuffer;
let eviction: EvictionEngine;
let retraction: RetractionEngine;
let evalEngine: EvalEngine;

beforeEach(() => {
  try { unlinkSync(TEST_DB); } catch {}
  store = new EngramStore(TEST_DB);
  activation = new ActivationEngine(store);
  connections = new ConnectionEngine(store, activation);
  staging = new StagingBuffer(store, activation);
  eviction = new EvictionEngine(store);
  retraction = new RetractionEngine(store);
  evalEngine = new EvalEngine(store);
});

afterEach(() => {
  store.close();
  try { unlinkSync(TEST_DB); } catch {}
});

describe('Full memory lifecycle', () => {
  it('write → activate → retrieve cycle works', async () => {
    // Write a memory
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'async error handling',
      content: 'Promise.allSettled is safer than Promise.all when you need partial results',
      tags: ['javascript', 'async', 'error-handling'],
      salience: 0.7,
      confidence: 0.8,
    });

    expect(engram.id).toBeDefined();
    expect(engram.stage).toBe('active');

    // Activate with related context
    const results = await activation.activate({
      agentId: AGENT_ID,
      context: 'handling async errors in javascript promises',
      useReranker: false,
      useExpansion: false,
    });

    expect(results.length).toBe(1);
    expect(results[0].engram.id).toBe(engram.id);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].why).toContain('text=');
  });

  it('access count increases on activation', async () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'test memory',
      content: 'unique keyword xyzzy for testing activation',
      salience: 0.5,
    });

    await activation.activate({ agentId: AGENT_ID, context: 'xyzzy', useReranker: false, useExpansion: false });
    await activation.activate({ agentId: AGENT_ID, context: 'xyzzy', useReranker: false, useExpansion: false });

    const engrams = store.getEngramsByAgent(AGENT_ID);
    expect(engrams[0].accessCount).toBe(2);
  });

  it('salience filter routes to correct disposition', () => {
    // High salience → active
    const high = evaluateSalience({
      content: 'critical discovery',
      eventType: 'causal',
      surprise: 0.9,
      causalDepth: 0.8,
      resolutionEffort: 0.7,
    });
    expect(high.disposition).toBe('active');

    // Low salience + duplicate → discard
    const low = evaluateSalience({
      content: 'mundane observation',
      eventType: 'observation',
      novelty: 0.1, // duplicate info
    });
    expect(low.disposition).toBe('discard');
  });

  it('multiple memories ranked by relevance', async () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'database indexing',
      content: 'B-tree indexes speed up range queries on sorted data',
      tags: ['database', 'performance'],
      salience: 0.6,
    });

    store.createEngram({
      agentId: AGENT_ID,
      concept: 'cooking tip',
      content: 'Salt pasta water generously for better flavor',
      tags: ['cooking'],
      salience: 0.3,
    });

    store.createEngram({
      agentId: AGENT_ID,
      concept: 'query optimization',
      content: 'Use EXPLAIN ANALYZE to find slow database queries and missing indexes',
      tags: ['database', 'performance', 'sql'],
      salience: 0.7,
    });

    const results = await activation.activate({
      agentId: AGENT_ID,
      context: 'database query performance optimization indexes',
      limit: 5,
      useReranker: false,
      useExpansion: false,
    });

    // Database-related memories should score higher than cooking
    expect(results.length).toBeGreaterThanOrEqual(2);
    const dbResults = results.filter(r =>
      r.engram.concept.includes('database') || r.engram.concept.includes('query')
    );
    const cookingResults = results.filter(r => r.engram.concept.includes('cooking'));
    // DB results should have higher scores than cooking if cooking appears at all
    if (cookingResults.length > 0 && dbResults.length > 0) {
      expect(dbResults[0].score).toBeGreaterThan(cookingResults[0].score);
    }
    expect(dbResults.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Hebbian association formation', () => {
  it('co-activated engrams form associations', async () => {
    const e1 = store.createEngram({
      agentId: AGENT_ID,
      concept: 'typescript generics',
      content: 'generics enable type-safe reusable typescript code components',
      salience: 0.6,
    });

    const e2 = store.createEngram({
      agentId: AGENT_ID,
      concept: 'type inference',
      content: 'typescript type inference reduces need for explicit type annotations',
      salience: 0.6,
    });

    // Activate with context that should hit both
    await activation.activate({
      agentId: AGENT_ID,
      context: 'typescript type generics inference code',
      useReranker: false,
      useExpansion: false,
    });

    // Check that associations formed
    const assocs = store.getAssociationsFor(e1.id);
    const linkedToE2 = assocs.some(
      a => a.fromEngramId === e2.id || a.toEngramId === e2.id
    );
    expect(linkedToE2).toBe(true);
  });
});

describe('Retraction (negative memory)', () => {
  it('retracting marks engram and creates correction', async () => {
    const wrong = store.createEngram({
      agentId: AGENT_ID,
      concept: 'http status codes',
      content: 'HTTP 418 means server timeout',
      salience: 0.5,
      confidence: 0.7,
    });

    const result = retraction.retract({
      agentId: AGENT_ID,
      targetEngramId: wrong.id,
      reason: 'Incorrect — 418 is I\'m a Teapot',
      counterContent: 'HTTP 418 is "I\'m a Teapot" (RFC 2324). Server timeout is HTTP 408.',
    });

    expect(result.retractedId).toBe(wrong.id);
    expect(result.correctionId).toBeDefined();

    // Original should be retracted
    const retracted = store.getEngram(wrong.id)!;
    expect(retracted.retracted).toBe(true);

    // Correction should exist and be active
    const correction = store.getEngram(result.correctionId!)!;
    expect(correction.stage).toBe('active');
    expect(correction.concept).toContain('correction:');

    // Retracted engrams should not appear in normal activation
    const results = await activation.activate({
      agentId: AGENT_ID,
      context: 'http status codes timeout teapot',
      useReranker: false,
      useExpansion: false,
    });
    const foundRetracted = results.find(r => r.engram.id === wrong.id);
    expect(foundRetracted).toBeUndefined();

    // But correction should appear
    const foundCorrection = results.find(r => r.engram.id === result.correctionId);
    expect(foundCorrection).toBeDefined();
  });
});

describe('Eviction', () => {
  it('evicts lowest-value engrams when over capacity', () => {
    const config = { ...DEFAULT_AGENT_CONFIG, maxActiveEngrams: 3 };

    // Create 5 engrams
    for (let i = 0; i < 5; i++) {
      store.createEngram({
        agentId: AGENT_ID,
        concept: `memory ${i}`,
        content: `content for memory number ${i}`,
        salience: i * 0.2, // 0.0, 0.2, 0.4, 0.6, 0.8
        confidence: 0.5,
      });
    }

    expect(store.getActiveCount(AGENT_ID)).toBe(5);

    const result = eviction.enforceCapacity(AGENT_ID, config);
    expect(result.evicted).toBe(2); // 5 - 3 = 2 to remove
    expect(store.getActiveCount(AGENT_ID)).toBe(3);
  });
});

describe('Feedback and confidence updates', () => {
  it('positive feedback increases confidence', () => {
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'test',
      content: 'test content',
      confidence: 0.5,
      salience: 0.5,
    });

    store.logRetrievalFeedback(null, engram.id, true, 'was helpful');
    store.updateConfidence(engram.id, 0.5 + DEFAULT_AGENT_CONFIG.feedbackPositiveBoost);

    const updated = store.getEngram(engram.id)!;
    expect(updated.confidence).toBeGreaterThan(0.5);
  });

  it('negative feedback decreases confidence', () => {
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'test',
      content: 'test content',
      confidence: 0.5,
      salience: 0.5,
    });

    store.updateConfidence(engram.id, 0.5 - DEFAULT_AGENT_CONFIG.feedbackNegativePenalty);

    const updated = store.getEngram(engram.id)!;
    expect(updated.confidence).toBeLessThan(0.5);
  });
});

describe('Eval metrics', () => {
  it('computes metrics without errors on empty agent', () => {
    const metrics = evalEngine.computeMetrics(AGENT_ID);
    expect(metrics.agentId).toBe(AGENT_ID);
    expect(metrics.activeEngramCount).toBe(0);
    expect(metrics.avgConfidence).toBe(0);
  });

  it('computes metrics after activity', async () => {
    store.createEngram({ agentId: AGENT_ID, concept: 'a', content: 'hello world', salience: 0.6 });
    store.createEngram({ agentId: AGENT_ID, concept: 'b', content: 'goodbye world', salience: 0.5 });

    await activation.activate({ agentId: AGENT_ID, context: 'hello world', useReranker: false, useExpansion: false });

    const metrics = evalEngine.computeMetrics(AGENT_ID);
    expect(metrics.activeEngramCount).toBe(2);
    expect(metrics.avgConfidence).toBeGreaterThan(0);
    expect(metrics.activationCount).toBe(1);
    expect(metrics.avgLatencyMs).toBeGreaterThan(0);
    expect(metrics.p95LatencyMs).toBeGreaterThan(0);
  });
});

describe('Diagnostic search', () => {
  it('finds engrams by text', () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'unique concept alpha',
      content: 'unique content bravo',
      salience: 0.5,
    });

    const byContent = store.search({ agentId: AGENT_ID, text: 'bravo' });
    expect(byContent.length).toBe(1);

    const byConcept = store.search({ agentId: AGENT_ID, concept: 'unique concept alpha' });
    expect(byConcept.length).toBe(1);
  });

  it('finds engrams by tags', () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'tagged memory',
      content: 'content',
      tags: ['rust', 'performance'],
      salience: 0.5,
    });

    const results = store.search({ agentId: AGENT_ID, tags: ['rust'] });
    expect(results.length).toBe(1);
  });

  it('excludes retracted by default in search', () => {
    const e = store.createEngram({
      agentId: AGENT_ID,
      concept: 'will retract',
      content: 'wrong info',
      salience: 0.5,
    });
    store.retractEngram(e.id, null);

    const without = store.search({ agentId: AGENT_ID, retracted: false });
    expect(without.length).toBe(0);

    const with_ = store.search({ agentId: AGENT_ID, retracted: true });
    expect(with_.length).toBe(1);
  });
});

describe('BM25 full-text search', () => {
  it('finds engrams via FTS5 BM25 ranking', () => {
    store.createEngram({
      agentId: AGENT_ID,
      concept: 'machine learning',
      content: 'gradient descent optimizes neural network weights by computing loss gradients',
      tags: ['ml', 'optimization'],
      salience: 0.7,
    });

    store.createEngram({
      agentId: AGENT_ID,
      concept: 'cooking pasta',
      content: 'boil water then add pasta and cook for ten minutes',
      tags: ['cooking'],
      salience: 0.3,
    });

    const results = store.searchBM25(AGENT_ID, 'gradient neural network optimization');
    expect(results.length).toBe(1);
    expect(results[0].concept).toBe('machine learning');
  });
});

describe('Agent isolation', () => {
  it('agents cannot see each other\'s memories', async () => {
    store.createEngram({
      agentId: 'agent-A',
      concept: 'secret A',
      content: 'agent A private data',
      salience: 0.5,
    });

    store.createEngram({
      agentId: 'agent-B',
      concept: 'secret B',
      content: 'agent B private data',
      salience: 0.5,
    });

    const aResults = await activation.activate({ agentId: 'agent-A', context: 'private data secret', useReranker: false, useExpansion: false });
    const bResults = await activation.activate({ agentId: 'agent-B', context: 'private data secret', useReranker: false, useExpansion: false });

    expect(aResults.every(r => r.engram.agentId === 'agent-A')).toBe(true);
    expect(bResults.every(r => r.engram.agentId === 'agent-B')).toBe(true);
  });
});
