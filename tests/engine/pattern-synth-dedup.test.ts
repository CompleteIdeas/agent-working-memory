/**
 * Type B pattern synthesis must not write the same pattern twice.
 *
 * Its only guard used to be "no cluster member is a synthesis". The same clusters re-formed
 * every cycle WITHOUT their synthesis in them, so each consolidation wrote another copy: the
 * 2026-08-24 snapshot held 18,368 pattern rows with 147 distinct concepts, and their centroid
 * embeddings took dense #1 on 119 of 194 natural-language questions.
 *
 * The test reproduces the escape directly: an existing pattern whose embedding sits outside
 * the cluster, so the old member check cannot see it.
 *
 * Run: npx vitest run tests/engine/pattern-synth-dedup.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ConsolidationEngine } from '../../src/engine/consolidation.js';

const AGENT = 'pattern-dedup-test';
const DIM = 384;
const axis = (i: number, tilt = 0) => {
  const v = new Array(DIM).fill(0);
  v[i] = Math.cos(tilt); v[i + 1] = Math.sin(tilt);
  return v;
};

describe('ConsolidationEngine — Type B pattern synthesis dedup', () => {
  let store: EngramStore;
  let consolidation: ConsolidationEngine;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-patdedup-'));
    store = new EngramStore(join(tmp, 'test.db'));
    consolidation = new ConsolidationEngine(store);
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /** Four near-identical memories across two projects: one cross-session cluster. */
  async function seedCluster() {
    for (const [i, proj] of [[0, 'proj=alpha'], [1, 'proj=alpha'], [2, 'proj=beta'], [3, 'proj=beta']] as const) {
      await store.createEngram({
        agentId: AGENT,
        concept: `zebra stable note ${i}`,
        content: 'zebra zebra zebra yakking yakking xenon — the same recurring theme, written again.',
        tags: [proj],
        embedding: axis(0, 0.01 * i),
      } as any);
    }
  }
  const patterns = async () =>
    (await store.getEngramsByAgent(AGENT, 'active')).filter(e => e.tags.includes('synth-type=pattern'));

  it('writes a pattern once for a fresh cluster', async () => {
    await seedCluster();
    await consolidation.consolidate(AGENT);
    const ps = await patterns();
    expect(ps).toHaveLength(1);
    expect(ps[0]!.concept).toBe('pattern: zebra, yakking, xenon');
  });

  it('does not write a second copy when the existing pattern is outside the cluster', async () => {
    await seedCluster();
    const existing = await store.createEngram({
      agentId: AGENT,
      concept: 'pattern: zebra, yakking, xenon',
      content: 'Pattern across 2 sessions (4 memories). Common themes: zebra, yakking, xenon.',
      tags: ['proj=alpha', 'proj=beta', 'synth=true', 'synth-type=pattern'],
      embedding: axis(10), // orthogonal: not a member of the cluster, so the member check misses it
    } as any);
    await consolidation.consolidate(AGENT);
    await consolidation.consolidate(AGENT);
    const ps = await patterns();
    expect(ps.map(p => p.id)).toEqual([existing.id]);
  });
});
