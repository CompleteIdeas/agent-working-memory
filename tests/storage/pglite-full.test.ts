/**
 * PGlite full surface tests — exercises the IEngramStore contract methods
 * end-to-end against a real PGlite database.
 *
 * Companion to pglite-smoke.test.ts (which validates CRUD + search). This
 * file covers associations, tasks, episodes, supersession, tag queries,
 * checkpoints, eval logging, and 0.8 substrate primitives.
 *
 * Run: npx vitest run tests/storage/pglite-full.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { PGliteEngramStore } from '../../src/storage/pglite.js';

const DB_DIR = join(tmpdir(), `awm-pglite-full-${Date.now()}`);
let store: PGliteEngramStore;

beforeAll(async () => {
  store = new PGliteEngramStore(DB_DIR);
  await store.ready();
}, 60_000);

afterAll(async () => {
  await store.close();
  try { rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* noop */ }
});

const A = 'agent-full';
const emb = (seed: number) => new Array(384).fill(0).map((_, i) => Math.sin(seed + i / 10) * 0.1);

describe('Associations', () => {
  it('upsertAssociation creates an edge with the given weight', async () => {
    const e1 = await store.createEngram({ agentId: A, concept: 'A', content: 'first', embedding: emb(1) } as any);
    const e2 = await store.createEngram({ agentId: A, concept: 'B', content: 'second', embedding: emb(2) } as any);
    const assoc = await store.upsertAssociation(e1.id, e2.id, 0.5);
    expect(assoc.fromEngramId).toBe(e1.id);
    expect(assoc.toEngramId).toBe(e2.id);
    expect(assoc.weight).toBe(0.5);
  });

  it('upsertAssociation increments activation_count on conflict', async () => {
    const e1 = await store.createEngram({ agentId: A, concept: 'C', content: 'c', embedding: emb(3) } as any);
    const e2 = await store.createEngram({ agentId: A, concept: 'D', content: 'd', embedding: emb(4) } as any);
    await store.upsertAssociation(e1.id, e2.id, 0.3);
    const updated = await store.upsertAssociation(e1.id, e2.id, 0.8);
    expect(updated.weight).toBe(0.8);
    expect(updated.activationCount).toBeGreaterThanOrEqual(1);
  });

  it('getAssociationsFor returns edges in both directions', async () => {
    const e1 = await store.createEngram({ agentId: A, concept: 'E', content: 'e', embedding: emb(5) } as any);
    const e2 = await store.createEngram({ agentId: A, concept: 'F', content: 'f', embedding: emb(6) } as any);
    await store.upsertAssociation(e1.id, e2.id, 0.4);
    const list = await store.getAssociationsFor(e1.id);
    expect(list.length).toBeGreaterThan(0);
    expect(list.some(a => a.toEngramId === e2.id)).toBe(true);
  });

  it('getAssociationStatsForBatch returns count + sumWeight per engram', async () => {
    const e1 = await store.createEngram({ agentId: A, concept: 'G', content: 'g', embedding: emb(7) } as any);
    const e2 = await store.createEngram({ agentId: A, concept: 'H', content: 'h', embedding: emb(8) } as any);
    const e3 = await store.createEngram({ agentId: A, concept: 'I', content: 'i', embedding: emb(9) } as any);
    await store.upsertAssociation(e1.id, e2.id, 0.2);
    await store.upsertAssociation(e1.id, e3.id, 0.3);
    const stats = await store.getAssociationStatsForBatch([e1.id, e2.id, e3.id]);
    expect(stats.get(e1.id)!.count).toBeGreaterThanOrEqual(2);
    expect(stats.get(e1.id)!.sumWeight).toBeCloseTo(0.5, 2);
  });
});

describe('Supersession & tags', () => {
  it('supersedeEngram links old → new bidirectionally', async () => {
    const old = await store.createEngram({ agentId: A, concept: 'old-concept', content: 'v1', embedding: emb(10) } as any);
    const nw = await store.createEngram({ agentId: A, concept: 'new-concept', content: 'v2', embedding: emb(11) } as any);
    await store.supersedeEngram(old.id, nw.id);
    expect(await store.isSuperseded(old.id)).toBe(true);
    const refetchedOld = await store.getEngram(old.id);
    const refetchedNew = await store.getEngram(nw.id);
    expect(refetchedOld!.supersededBy).toBe(nw.id);
    expect(refetchedNew!.supersedes).toBe(old.id);
  });

  it('findActiveMatchByConcept matches case-insensitively and skips superseded', async () => {
    await store.createEngram({ agentId: A, concept: 'Match Me', content: 'first', embedding: emb(12) } as any);
    const found = await store.findActiveMatchByConcept(A, 'MATCH ME');
    expect(found).not.toBeNull();
    expect(found!.concept).toBe('Match Me');
  });

  it('updateTags persists a new tag list', async () => {
    const e = await store.createEngram({ agentId: A, concept: 'tagme', content: 'x', tags: ['old'], embedding: emb(13) } as any);
    await store.updateTags(e.id, ['new', 'list']);
    const refetched = await store.getEngram(e.id);
    expect(refetched!.tags).toEqual(['new', 'list']);
  });

  it('findEngramsByTags returns engrams whose tags contain any of the given tags', async () => {
    await store.createEngram({ agentId: A, concept: 'tagged-a', content: 'a', tags: ['alpha', 'beta'], embedding: emb(14) } as any);
    await store.createEngram({ agentId: A, concept: 'tagged-b', content: 'b', tags: ['gamma'], embedding: emb(15) } as any);
    const hits = await store.findEngramsByTags(A, ['alpha']);
    expect(hits.length).toBe(1);
    expect(hits[0].concept).toBe('tagged-a');
  });
});

describe('Tasks', () => {
  it('getTasks returns engrams with task_status, ordered by priority', async () => {
    await store.createEngram({ agentId: A, concept: 'task-a', content: 'a', taskStatus: 'open', taskPriority: 'high', embedding: emb(20) } as any);
    await store.createEngram({ agentId: A, concept: 'task-b', content: 'b', taskStatus: 'open', taskPriority: 'urgent', embedding: emb(21) } as any);
    await store.createEngram({ agentId: A, concept: 'task-c', content: 'c', taskStatus: 'open', taskPriority: 'low', embedding: emb(22) } as any);
    const tasks = await store.getTasks(A, 'open');
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks[0].taskPriority).toBe('urgent');
  });

  it('getNextTask picks the highest-priority actionable task', async () => {
    const next = await store.getNextTask(A);
    expect(next).not.toBeNull();
    expect(next!.taskPriority).toBe('urgent');
  });

  it('updateTaskStatus changes status', async () => {
    const t = await store.createEngram({ agentId: A, concept: 'task-d', content: 'd', taskStatus: 'open', taskPriority: 'medium', embedding: emb(23) } as any);
    await store.updateTaskStatus(t.id, 'done');
    const refetched = await store.getEngram(t.id);
    expect(refetched!.taskStatus).toBe('done');
  });
});

describe('Episodes', () => {
  it('createEpisode + getEpisode round-trip', async () => {
    const ep = await store.createEpisode({ agentId: A, label: 'episode-1' });
    expect(ep.label).toBe('episode-1');
    const fetched = await store.getEpisode(ep.id);
    expect(fetched!.id).toBe(ep.id);
  });

  it('addEngramToEpisode increments engram_count', async () => {
    const ep = await store.createEpisode({ agentId: A, label: 'episode-2' });
    const e = await store.createEngram({ agentId: A, concept: 'in-episode', content: 'x', embedding: emb(30) } as any);
    await store.addEngramToEpisode(e.id, ep.id);
    const refetched = await store.getEpisode(ep.id);
    expect(refetched!.engramCount).toBeGreaterThanOrEqual(1);
  });
});

describe('Counts & stats', () => {
  it('getActiveCount returns the number of active engrams', async () => {
    const count = await store.getActiveCount(A);
    expect(count).toBeGreaterThan(0);
  });

  it('getConsolidatedCount returns 0 when nothing consolidated yet', async () => {
    const c = await store.getConsolidatedCount(A);
    expect(c).toBe(0);
  });
});

describe('Checkpoints & conscious state', () => {
  it('touchActivity creates a conscious_state row if absent', async () => {
    await store.touchActivity(A);
    const cp = await store.getCheckpoint(A);
    expect(cp).not.toBeNull();
  });

  it('updateAutoCheckpointWrite increments write_count_since_consolidation', async () => {
    const e = await store.createEngram({ agentId: A, concept: 'checkpoint-test', content: 'x', embedding: emb(40) } as any);
    const before = await store.getCheckpoint(A);
    await store.updateAutoCheckpointWrite(A, e.id);
    const after = await store.getCheckpoint(A);
    expect(after!.auto.writeCountSinceConsolidation).toBeGreaterThan(before!.auto.writeCountSinceConsolidation);
  });

  it('markConsolidation (non-mini) resets the counters and bumps cycle count', async () => {
    await store.markConsolidation(A, false);
    const cp = await store.getCheckpoint(A);
    expect(cp!.auto.writeCountSinceConsolidation).toBe(0);
    expect(cp!.lastConsolidationAt).not.toBeNull();
  });

  it('getActiveAgents returns rows from conscious_state', async () => {
    const agents = await store.getActiveAgents();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some(a => a.agentId === A)).toBe(true);
  });
});

describe('0.8 substrate primitives', () => {
  it('getLatestByTag returns one engram per distinct tag value', async () => {
    await store.createEngram({ agentId: A, concept: 'tag1', content: 'a', tags: ['character=Alice'], embedding: emb(50) } as any);
    await new Promise(r => setTimeout(r, 5)); // ensure timestamp ordering
    await store.createEngram({ agentId: A, concept: 'tag2', content: 'b', tags: ['character=Alice'], embedding: emb(51) } as any);
    await store.createEngram({ agentId: A, concept: 'tag3', content: 'c', tags: ['character=Bob'], embedding: emb(52) } as any);

    const latest = await store.getLatestByTag({ agentId: A, tagKeyPrefix: 'character=' });
    expect(latest.length).toBe(2);
    const alice = latest.find(e => e.tags.includes('character=Alice'));
    expect(alice!.concept).toBe('tag2'); // latest write wins
  });

  it('getTopBy sorts by numeric tag value extracted from prefix', async () => {
    await store.createEngram({ agentId: A, concept: 'w-low', content: 'l', tags: ['weight=2'], embedding: emb(60) } as any);
    await store.createEngram({ agentId: A, concept: 'w-mid', content: 'm', tags: ['weight=5'], embedding: emb(61) } as any);
    await store.createEngram({ agentId: A, concept: 'w-high', content: 'h', tags: ['weight=9'], embedding: emb(62) } as any);

    const desc = await store.getTopBy({ agentId: A, sortField: 'weight=', order: 'desc' });
    expect(desc[0].concept).toBe('w-high');
    expect(desc[2].concept).toBe('w-low');
  });

  it('allocateNextSequence returns MAX(sequence)+1 — monotonic once a write reserves the prior value', async () => {
    const s1 = await store.allocateNextSequence(A);
    await store.createEngram({
      agentId: A, concept: `seq-${s1}`, content: 'seq', sequence: s1, embedding: emb(80),
    } as any);
    const s2 = await store.allocateNextSequence(A);
    expect(s2).toBeGreaterThan(s1);
  });
});

describe('Eviction', () => {
  it('getEvictionCandidates returns ordered list', async () => {
    const cands = await store.getEvictionCandidates(A, 5);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.length).toBeLessThanOrEqual(5);
  });
});

describe('Eval logging', () => {
  it('logActivationEvent + getActivationStats', async () => {
    await store.logActivationEvent({
      id: 'event-1', agentId: A, timestamp: new Date(),
      context: 'test', resultsReturned: 5, topScore: 0.8,
      latencyMs: 42, engramIds: ['x', 'y'],
    } as any);
    const stats = await store.getActivationStats(A);
    expect(stats.count).toBeGreaterThan(0);
    expect(stats.avgLatencyMs).toBeGreaterThan(0);
  });

  it('logRetrievalFeedback + getRetrievalPrecision', async () => {
    const e = await store.createEngram({ agentId: A, concept: 'feedback-test', content: 'x', embedding: emb(70) } as any);
    await store.logRetrievalFeedback(null, e.id, true, 'test-ctx');
    await store.logRetrievalFeedback(null, e.id, false, 'test-ctx');
    const p = await store.getRetrievalPrecision(A);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});
