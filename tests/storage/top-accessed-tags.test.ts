/**
 * Tests for EngramStore.getTopAccessedTags — the bounded replacement for the
 * recall path's pronoun branch.
 *
 * REGRESSION. src/engine/activation.ts used to answer "what has this agent been
 * looking at lately" by calling getEngramsByAgents(agentIds, 'active') —
 * hydrating EVERY active engram into JS — sorting by accessCount in memory,
 * keeping ten, and extracting five tag words. Measured on an 11k-retrievable
 * store: 287ms, on the 2.1% of real prompts containing "it", "this", "that" or
 * "there". It is now 0.45ms. See docs/recall-latency.md.
 *
 * The thing most likely to break here is the MULTI-AGENT path: `agent_id IN
 * (...)` defeats the ordered index walk (86ms vs 0.03ms measured), so the
 * implementation queries per agent and merges in JS. That merge has to produce
 * the true global top N, not each agent's top N concatenated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { EngramStore } from '../../src/storage/sqlite.js';

let store: EngramStore;
let dbPath: string;

/** Create an engram with an explicit access_count — createEngram always starts at 0. */
function seed(agentId: string, concept: string, accessCount: number, tags: string[]): string {
  const e = store.createEngram({ agentId, concept, content: `${concept} body`, tags } as any);
  (store as any).db.prepare('UPDATE engrams SET access_count = ? WHERE id = ?').run(accessCount, e.id);
  return e.id;
}

beforeEach(() => {
  dbPath = join(tmpdir(), `awm-topaccess-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  store = new EngramStore(dbPath);
});

afterEach(() => {
  try { store.close?.(); } catch { /* noop */ }
  for (const s of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + s, { force: true }); } catch { /* noop */ }
  }
});

describe('getTopAccessedTags', () => {
  it('returns at most topN rows however many engrams exist', () => {
    for (let i = 0; i < 25; i++) seed('work', `memory ${i}`, i, [`tag=${i}`]);
    expect(store.getTopAccessedTags(['work'], 10, 'active')).toHaveLength(10);
    expect(store.getTopAccessedTags(['work'], 3, 'active')).toHaveLength(3);
  });

  it('orders by access_count descending', () => {
    seed('work', 'cold', 1, ['tag=cold']);
    seed('work', 'hot', 99, ['tag=hot']);
    seed('work', 'warm', 50, ['tag=warm']);
    expect(store.getTopAccessedTags(['work'], 3, 'active')).toEqual([
      ['tag=hot'], ['tag=warm'], ['tag=cold'],
    ]);
  });

  it('is agent-scoped — another agent\'s hottest memory never leaks in', () => {
    seed('work', 'mine', 5, ['tag=mine']);
    seed('personal', 'theirs', 1000, ['tag=theirs']);
    expect(store.getTopAccessedTags(['work'], 5, 'active')).toEqual([['tag=mine']]);
  });

  it('merges multiple agents into the TRUE global top N, not each agent\'s top N', () => {
    // work owns ranks 1, 3, 5; personal owns 2, 4. Asking for 3 must return the
    // global top 3 (90, 80, 70) — a naive concatenation would return work's
    // three and drop personal's 80.
    seed('work', 'w90', 90, ['tag=w90']);
    seed('work', 'w70', 70, ['tag=w70']);
    seed('work', 'w50', 50, ['tag=w50']);
    seed('personal', 'p80', 80, ['tag=p80']);
    seed('personal', 'p60', 60, ['tag=p60']);
    expect(store.getTopAccessedTags(['work', 'personal'], 3, 'active')).toEqual([
      ['tag=w90'], ['tag=p80'], ['tag=w70'],
    ]);
  });

  it('excludes retracted engrams', () => {
    const id = seed('work', 'retracted', 100, ['tag=gone']);
    seed('work', 'kept', 1, ['tag=kept']);
    (store as any).db.prepare('UPDATE engrams SET retracted = 1 WHERE id = ?').run(id);
    expect(store.getTopAccessedTags(['work'], 5, 'active')).toEqual([['tag=kept']]);
  });

  it('respects the stage filter', () => {
    const id = seed('work', 'staged', 100, ['tag=staged']);
    seed('work', 'active', 1, ['tag=active']);
    (store as any).db.prepare("UPDATE engrams SET stage = 'staging' WHERE id = ?").run(id);
    expect(store.getTopAccessedTags(['work'], 5, 'active')).toEqual([['tag=active']]);
    expect(store.getTopAccessedTags(['work'], 5, 'staging' as any)).toEqual([['tag=staged']]);
  });

  it('returns [] for no agents or a non-positive limit', () => {
    seed('work', 'something', 10, ['tag=x']);
    expect(store.getTopAccessedTags([], 10, 'active')).toEqual([]);
    expect(store.getTopAccessedTags(['work'], 0, 'active')).toEqual([]);
    expect(store.getTopAccessedTags(['work'], -1, 'active')).toEqual([]);
  });

  it('survives a malformed tags column rather than throwing', () => {
    const id = seed('work', 'broken', 10, ['tag=ok']);
    (store as any).db.prepare('UPDATE engrams SET tags = ? WHERE id = ?').run('not json', id);
    expect(store.getTopAccessedTags(['work'], 5, 'active')).toEqual([[]]);
  });
});
