/**
 * `awm migrate` smoke test — proves the SQLite→PGlite migration tool works:
 *   1. Build a small SQLite DB via EngramStore
 *   2. Run migrate() into a fresh PGlite directory
 *   3. Open the PGlite DB and verify row counts and embedding round-trips
 *
 * Run: npx vitest run tests/cli/migrate-smoke.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { EngramStore } from '../../src/storage/sqlite.js';
import { PGliteEngramStore } from '../../src/storage/pglite.js';
import { migrate } from '../../src/cli/migrate.js';

const TMP = join(tmpdir(), `awm-migrate-smoke-${Date.now()}`);
const SQLITE_PATH = join(TMP, 'source.db');
const PGLITE_DIR = join(TMP, 'target-pglite');

let createdEngramId: string;
let createdAssocId: string;

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });

  const src = new EngramStore(SQLITE_PATH);

  // Seed: 1 engram with embedding, 1 without, 1 association, 1 retrieval feedback
  const e1 = src.createEngram({
    agentId: 'agent-a',
    concept: 'migration test concept',
    content: 'SQLite source content that should round-trip to PGlite.',
    embedding: new Array(384).fill(0.05),
    confidence: 0.7,
    salience: 0.6,
    tags: ['migrate-test', 'has-embedding'],
  } as any);
  createdEngramId = e1.id;

  const e2 = src.createEngram({
    agentId: 'agent-a',
    concept: 'no-embedding engram',
    content: 'embedding-less row',
    confidence: 0.5,
    salience: 0.4,
  } as any);

  const assoc = src.upsertAssociation(e1.id, e2.id, 0.6, 'hebbian');
  createdAssocId = assoc.id;

  src.logRetrievalFeedback(null, e1.id, true, 'migration test feedback');
  src.touchActivity('agent-a');

  src.close();
}, 30_000);

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('awm migrate — SQLite → PGlite', () => {
  it('dry-run reports row counts without writing PGlite', async () => {
    const stats = await migrate({ from: SQLITE_PATH, to: PGLITE_DIR, dryRun: true });
    expect(stats.engrams).toBeGreaterThanOrEqual(2);
    expect(stats.associations).toBeGreaterThanOrEqual(1);
    expect(stats.retrievalFeedback).toBeGreaterThanOrEqual(1);
    expect(stats.consciousState).toBeGreaterThanOrEqual(1);
  });

  it('non-dry-run writes a usable PGlite database', async () => {
    const stats = await migrate({ from: SQLITE_PATH, to: PGLITE_DIR });
    expect(stats.engrams).toBeGreaterThanOrEqual(2);
    expect(stats.associations).toBeGreaterThanOrEqual(1);

    // Re-open PGlite and verify the data is queryable through the store API.
    const dst = new PGliteEngramStore(PGLITE_DIR);
    await dst.ready();
    try {
      const fetched = await dst.getEngram(createdEngramId);
      expect(fetched).not.toBeNull();
      expect(fetched!.concept).toBe('migration test concept');
      expect(fetched!.embedding).toBeTruthy();
      expect(fetched!.embedding!.length).toBe(384);
      // Embedding values were 0.05 — should round-trip within float32 precision.
      expect(Math.abs(fetched!.embedding![0] - 0.05)).toBeLessThan(0.01);

      const assoc = await dst.getAssociation(
        fetched!.id,
        (await dst.getEngramsByAgent('agent-a')).find(e => e.id !== fetched!.id)!.id,
      );
      expect(assoc).not.toBeNull();
      expect(assoc!.weight).toBeCloseTo(0.6, 5);

      // FTS index should be populated via PGlite's BEFORE INSERT trigger.
      const bm25 = await dst.searchBM25('agent-a', 'migration test', 5);
      expect(bm25.length).toBeGreaterThan(0);
      expect(bm25[0].id).toBe(createdEngramId);
    } finally {
      await dst.close();
    }
  });
});
