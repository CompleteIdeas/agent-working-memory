/**
 * PGlite smoke test — proves the AWM 2.0 P4a scaffold works end-to-end:
 * schema initializes, basic engram CRUD, vector search, BM25 search.
 *
 * This is NOT a full backend test — many IEngramStore methods are still
 * stubbed in PGliteEngramStore. The P4a work continues method-by-method
 * in follow-up sessions.
 *
 * Run: npx vitest run tests/storage/pglite-smoke.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { PGliteEngramStore } from '../../src/storage/pglite.js';

const DB_DIR = join(tmpdir(), `awm-pglite-smoke-${Date.now()}`);
let store: PGliteEngramStore;

beforeAll(async () => {
  store = new PGliteEngramStore(DB_DIR);
  await store.ready();
}, 60_000);

afterAll(async () => {
  await store.close();
  try { rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('PGliteEngramStore — smoke', () => {
  it('createEngram writes a row and returns the persisted engram', async () => {
    const created = await store.createEngram({
      agentId: 'agent-a',
      concept: 'PGlite test concept',
      content: 'PGlite is Postgres compiled to WASM and runs in-process.',
      embedding: new Array(384).fill(0.01),
      confidence: 0.8,
      salience: 0.7,
      tags: ['test', 'pglite'],
    } as any);

    expect(created.id).toBeTruthy();
    expect(created.agentId).toBe('agent-a');
    expect(created.concept).toBe('PGlite test concept');
    expect(created.tags).toEqual(['test', 'pglite']);
    expect(created.embedding).toBeTruthy();
    expect(created.embedding!.length).toBe(384);
  });

  it('getEngram retrieves the row by id', async () => {
    const created = await store.createEngram({
      agentId: 'agent-a',
      concept: 'fetch by id',
      content: 'lookup test',
      embedding: new Array(384).fill(0.02),
    } as any);
    const fetched = await store.getEngram(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.concept).toBe('fetch by id');
  });

  it('getEngram returns null for a missing id', async () => {
    const fetched = await store.getEngram('not-a-real-id');
    expect(fetched).toBeNull();
  });

  it('getEngramsByAgent returns all engrams for the agent', async () => {
    const rows = await store.getEngramsByAgent('agent-a');
    expect(rows.length).toBeGreaterThanOrEqual(2); // we wrote at least 2 above
    for (const r of rows) expect(r.agentId).toBe('agent-a');
  });

  it('searchByVector returns rows ordered by cosine distance', async () => {
    const target = new Array(384).fill(0.01); // matches our first insert exactly
    const hits = await store.searchByVector('agent-a', target, 5);
    expect(hits.length).toBeGreaterThan(0);
    // Distances should be sorted ascending (closer first)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].distance).toBeGreaterThanOrEqual(hits[i - 1].distance);
    }
  });

  it('searchBM25 returns rows matching a text query', async () => {
    const hits = await store.searchBM25('agent-a', 'pglite postgres wasm', 5);
    expect(hits.length).toBeGreaterThan(0);
    // The first row should be the most relevant
    expect(hits[0].concept).toBe('PGlite test concept');
  });

  it('searchBM25WithRank returns rows with their rank scores', async () => {
    const hits = await store.searchBM25WithRank('agent-a', 'pglite postgres wasm', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].engram.concept).toBe('PGlite test concept');
    expect(typeof hits[0].bm25Score).toBe('number');
  });

  it('deleteEngram removes the row', async () => {
    const created = await store.createEngram({
      agentId: 'agent-a',
      concept: 'to be deleted',
      content: 'ephemeral',
      embedding: new Array(384).fill(0.03),
    } as any);
    await store.deleteEngram(created.id);
    const fetched = await store.getEngram(created.id);
    expect(fetched).toBeNull();
  });
});
