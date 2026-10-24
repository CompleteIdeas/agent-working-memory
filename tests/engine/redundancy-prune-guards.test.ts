/**
 * Phase 6.5 redundancy pruning — guards added 2026-10-24 after the MWA experience pilot.
 *
 * The pass archives one of two low-confidence, rarely-accessed engrams whose embeddings
 * are closer than REDUNDANCY_THRESHOLD. As shipped it had no age guard and no class
 * guard, and its 0.75 threshold was calibrated for MiniLM-L6 while the store embeds
 * with bge-small-en-v1.5, whose unrelated pairs reach p99 0.757. A consolidate() run
 * straight after a batch write archived 25 distinct observation-kind memories (the
 * per-cycle cap) as duplicates of neighbours at 0.77–0.92 cosine.
 *
 * These tests pin the three guards:
 *   1. grace — nothing younger than FORGET_GRACE_DAYS is pruned;
 *   2. class — canonical/structural engrams are never pruned as redundant;
 *   3. threshold — a pair at 0.80 cosine is not redundant, a near-verbatim pair is.
 *
 * Embeddings are supplied directly so the test needs no model.
 *
 * Run: npx vitest run tests/engine/redundancy-prune-guards.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ConsolidationEngine } from '../../src/engine/consolidation.js';

const AGENT = 'redundancy-guard-test';
const DAY_MS = 24 * 60 * 60 * 1000;
const DIM = 384;

/** A unit vector; `tilt` mixes in a second orthogonal axis to set the cosine with the base. */
function vec(tilt = 0): number[] {
  const v = new Array(DIM).fill(0);
  v[0] = Math.cos(tilt);
  v[1] = Math.sin(tilt);
  return v;
}
/** Angle whose cosine is `c`. */
const angleFor = (c: number) => Math.acos(c);

function age(store: EngramStore, id: string, daysAgo: number) {
  const ts = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  (store as any).db.prepare(
    'UPDATE engrams SET created_at = ?, last_accessed = ? WHERE id = ?',
  ).run(ts, ts, id);
  (store as any).resetSlimCache?.();
}

describe('ConsolidationEngine — Phase 6.5 redundancy pruning guards', () => {
  let store: EngramStore;
  let consolidation: ConsolidationEngine;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-redund-'));
    store = new EngramStore(join(tmp, 'test.db'));
    consolidation = new ConsolidationEngine(store);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  async function make(concept: string, embedding: number[], memoryClass: 'canonical' | 'working' = 'working') {
    return await store.createEngram({
      agentId: AGENT,
      concept,
      content: `${concept}. A body long enough to read as a real memory, with a number in it: 42/43.`,
      tags: ['redundancy-guard'],
      embedding,
      confidence: 0.45, // the observation-kind prior — inside the < 0.6 pruning band
      memoryClass,
    } as any);
  }

  async function stages(...ids: string[]) {
    const out: string[] = [];
    for (const id of ids) out.push((await store.getEngram(id))!.stage);
    return out;
  }

  it('does not prune a near-verbatim pair written inside the grace period', async () => {
    const a = await make('watch-gate calibration dataset', vec(0));
    const b = await make('watch-gate calibration dataset and risk', vec(angleFor(0.98)));
    // both created just now: accessCount 0, cosine 0.98 — would have been pruned before the guard
    await consolidation.consolidate(AGENT);
    expect(await stages(a.id, b.id)).toEqual(['active', 'active']);
  });

  it('prunes one of a near-verbatim working pair once both are past the grace period', async () => {
    const a = await make('watch-gate calibration dataset', vec(0));
    const b = await make('watch-gate calibration dataset and risk', vec(angleFor(0.98)));
    age(store, a.id, 10); age(store, b.id, 10);
    await consolidation.consolidate(AGENT);
    const s = await stages(a.id, b.id);
    expect(s.filter(x => x === 'archived')).toHaveLength(1);
    expect(s.filter(x => x === 'active')).toHaveLength(1);
  });

  it('never prunes canonical engrams as redundant, however alike', async () => {
    const a = await make('memory backend default', vec(0), 'canonical');
    const b = await make('memory backend configuration', vec(angleFor(0.99)), 'canonical');
    age(store, a.id, 10); age(store, b.id, 10);
    await consolidation.consolidate(AGENT);
    expect(await stages(a.id, b.id)).toEqual(['active', 'active']);
  });

  it('treats a pair at 0.80 cosine as distinct memories, not duplicates', async () => {
    // 0.80 is above the old 0.75 line and inside the band where the pilot lost
    // "Clef calibration, measured result" to "Jev Router calibration limits" (0.81).
    const a = await make('Clef calibration, measured result', vec(0));
    const b = await make('Jev Router calibration limits', vec(angleFor(0.80)));
    age(store, a.id, 10); age(store, b.id, 10);
    await consolidation.consolidate(AGENT);
    expect(await stages(a.id, b.id)).toEqual(['active', 'active']);
  });
});
