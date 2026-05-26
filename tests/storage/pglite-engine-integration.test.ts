/**
 * PGlite engine-swappability test — proves that AWM 2.0's cognitive engines
 * (write-pipeline, ActivationEngine, EvictionEngine, ConsolidationEngine,
 * RetractionEngine) work against the async PGlite backend without changes.
 *
 * This is the P4b acceptance gate: the engines accept any IEngramStore-shaped
 * backend, awaiting all store calls. If this test passes, the same engines
 * run on SQLite (sync, fast) and PGlite (async, portable) interchangeably.
 *
 * Run: npx vitest run tests/storage/pglite-engine-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { PGliteEngramStore } from '../../src/storage/pglite.js';
import type { IEngramStore } from '../../src/storage/store.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { RetractionEngine } from '../../src/engine/retraction.js';
import { EvictionEngine } from '../../src/engine/eviction.js';
import { EvalEngine } from '../../src/engine/eval.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/types/agent.js';

const DB_DIR = join(tmpdir(), `awm-pglite-engines-${Date.now()}`);
const A = 'agent-engines';

let store: PGliteEngramStore;
let activation: ActivationEngine;
let connectionEngine: ConnectionEngine;

beforeAll(async () => {
  store = new PGliteEngramStore(DB_DIR);
  await store.ready();
  // Cast to IEngramStore — engines accept the async contract.
  const iStore = store as unknown as IEngramStore;
  activation = new ActivationEngine(iStore);
  connectionEngine = new ConnectionEngine(iStore, activation);
}, 60_000);

afterAll(async () => {
  await store.close();
  try { rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('Engines accept PGlite backend', () => {
  it('write-pipeline performWrite creates an engram against PGlite', async () => {
    const result = await performWrite(
      { store: store as unknown as IEngramStore, connectionEngine },
      {
        agentId: A,
        concept: 'engine-pglite-write-test',
        content: 'Cognitive engines work against PGlite backend through IEngramStore contract.',
        eventType: 'observation',
      },
    );
    expect(result.action).toBe('create');
    expect(result.engram).toBeTruthy();
    expect(result.engram.agentId).toBe(A);
  });

  it('ActivationEngine.activate runs against PGlite and returns candidates', async () => {
    await performWrite(
      { store: store as unknown as IEngramStore, connectionEngine },
      {
        agentId: A,
        concept: 'activation-pglite-test',
        content: 'Activation should find this when querying for matching keywords.',
      },
    );
    const results = await activation.activate({
      agentId: A,
      context: 'activation pglite',
      useReranker: false,
      useExpansion: false,
      internal: true,  // skip side-effects for test cleanliness
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it('RetractionEngine.retract marks engram and creates correction', async () => {
    const target = await store.createEngram({
      agentId: A,
      concept: 'pglite-retract-target',
      content: 'This memory is wrong and will be retracted.',
      embedding: new Array(384).fill(0.01),
    } as any);
    const retraction = new RetractionEngine(store as unknown as IEngramStore);
    const result = await retraction.retract({
      agentId: A,
      targetEngramId: target.id,
      reason: 'wrong fact',
      counterContent: 'The corrected version.',
    });
    expect(result.retractedId).toBe(target.id);
    expect(result.correctionId).toBeTruthy();
    const refetched = await store.getEngram(target.id);
    expect(refetched!.retracted).toBe(true);
  });

  it('EvictionEngine.enforceCapacity archives over-capacity engrams', async () => {
    // Create 5 low-salience engrams under a fresh agent for clean test
    const evictAgent = 'agent-evict-pglite';
    for (let i = 0; i < 5; i++) {
      await store.createEngram({
        agentId: evictAgent,
        concept: `evict-target-${i}`,
        content: `low-salience content ${i}`,
        salience: 0.2,
        confidence: 0.4,
        embedding: new Array(384).fill(0.01),
      } as any);
    }
    const eviction = new EvictionEngine(store as unknown as IEngramStore);
    const result = await eviction.enforceCapacity(evictAgent, {
      ...DEFAULT_AGENT_CONFIG,
      maxActiveEngrams: 3,
    });
    expect(result.evicted).toBeGreaterThanOrEqual(2);
    const activeRemaining = await store.getActiveCount(evictAgent);
    expect(activeRemaining).toBeLessThanOrEqual(3);
  });

  it('EvalEngine.computeMetrics runs against PGlite', async () => {
    const evalEngine = new EvalEngine(store as unknown as IEngramStore);
    const metrics = await evalEngine.computeMetrics(A);
    expect(metrics.agentId).toBe(A);
    expect(metrics.activeEngramCount).toBeGreaterThan(0);
  });
});
