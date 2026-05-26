/**
 * Connection-discovery deferral — v0.8.2.
 *
 * Verifies the invariants:
 *   - enqueue() no longer triggers processQueue() inline; queue grows.
 *   - enqueueAndMaybeFlush() drains inline when the agent has fewer than
 *     COLD_START_THRESHOLD active engrams.
 *   - enqueueAndMaybeFlush() does NOT drain inline once the pool is past
 *     the threshold — the queue accumulates for the next consolidation.
 *   - ConsolidationEngine.consolidate() drains the queue (Phase 0).
 *
 * Run: npx vitest run tests/engine/connections-defer.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { ConsolidationEngine } from '../../src/engine/consolidation.js';

const AGENT = 'defer-test';

function newRig() {
  const tmp = mkdtempSync(join(tmpdir(), 'awm-defer-'));
  const store = new EngramStore(join(tmp, 'test.db'));
  const activation = new ActivationEngine(store);
  const connection = new ConnectionEngine(store, activation);
  const consolidation = new ConsolidationEngine(store, connection);
  return { tmp, store, activation, connection, consolidation };
}

function teardown(rig: ReturnType<typeof newRig>) {
  rig.store.close();
  try { rmSync(rig.tmp, { recursive: true, force: true }); } catch { /* noop */ }
}

describe('ConnectionEngine — deferred discovery (v0.8.2)', () => {
  let rig: ReturnType<typeof newRig>;

  beforeEach(() => { rig = newRig(); });
  afterEach(() => teardown(rig));

  it('enqueue() does not trigger inline processing', async () => {
    const e = await rig.store.createEngram({
      agentId: AGENT, concept: 'plain enqueue', content: 'no inline drain',
      tags: [], salience: 0.5, confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.01)),
    });
    rig.connection.enqueue(e.id);
    // No await — queue stays put until processQueue() is called.
    expect(rig.connection.queueSize()).toBe(1);
  });

  it('enqueueAndMaybeFlush() drains inline for cold-start agents', async () => {
    // Empty pool: cold-start drain should fire.
    const e = await rig.store.createEngram({
      agentId: AGENT, concept: 'cold start', content: 'inline drain expected',
      tags: [], salience: 0.5, confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.02)),
    });
    rig.connection.enqueueAndMaybeFlush(e.id, AGENT);
    // Inline drain is fire-and-forget. Poll the queue size — should be 0 quickly.
    for (let i = 0; i < 100 && rig.connection.queueSize() > 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(rig.connection.queueSize()).toBe(0);
  });

  it('enqueueAndMaybeFlush() defers once pool exceeds COLD_START_THRESHOLD', async () => {
    // Seed 15 engrams (> default threshold of 10) so the cold-start gate
    // declines to drain inline.
    for (let i = 0; i < 15; i++) {
      await rig.store.createEngram({
        agentId: AGENT, concept: `seed ${i}`, content: `body ${i}`,
        tags: [`s-${i}`], salience: 0.5, confidence: 0.5,
        embedding: Array(384).fill(0).map((_, j) => Math.sin(i * 0.1 + j * 0.01)),
      });
    }
    const e = await rig.store.createEngram({
      agentId: AGENT, concept: 'beyond threshold', content: 'defer me',
      tags: [], salience: 0.5, confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.cos(i * 0.03)),
    });
    rig.connection.enqueueAndMaybeFlush(e.id, AGENT);
    // Brief wait so the cold-start check resolves and decides to defer.
    await new Promise(r => setTimeout(r, 50));
    expect(rig.connection.queueSize()).toBe(1);
  });

  it('ConsolidationEngine drains the queue at the start of consolidate()', async () => {
    for (let i = 0; i < 15; i++) {
      await rig.store.createEngram({
        agentId: AGENT, concept: `seed ${i}`, content: `body ${i}`,
        tags: [`s-${i}`], salience: 0.5, confidence: 0.5,
        embedding: Array(384).fill(0).map((_, j) => Math.sin(i * 0.1 + j * 0.01)),
      });
    }
    const e = await rig.store.createEngram({
      agentId: AGENT, concept: 'awaiting consolidation', content: 'drain via consolidate',
      tags: [], salience: 0.5, confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.cos(i * 0.04)),
    });
    rig.connection.enqueue(e.id);
    expect(rig.connection.queueSize()).toBe(1);

    await rig.consolidation.consolidate(AGENT);
    expect(rig.connection.queueSize()).toBe(0);
  });

  it('processQueue() is reentrant-safe', async () => {
    const e = await rig.store.createEngram({
      agentId: AGENT, concept: 'reentry', content: 'no double-drain',
      tags: [], salience: 0.5, confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.05)),
    });
    rig.connection.enqueue(e.id);
    const [a, b] = await Promise.all([
      rig.connection.processQueue(),
      rig.connection.processQueue(),
    ]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(rig.connection.queueSize()).toBe(0);
  });
});
