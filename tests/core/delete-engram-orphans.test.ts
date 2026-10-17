/**
 * deleteEngram cleans dependent rows (A-8, 2026-10-12).
 *
 * `associations` declares ON DELETE CASCADE, so it was always cleaned. The three
 * tables that carry a bare `engram_id TEXT` with no foreign key — retrieval_feedback,
 * entity_mentions, staging_events — were not, so every delete stranded their rows.
 * Measured on the live store: 571 orphaned retrieval_feedback rows and 3 orphaned
 * entity_mentions, also present in the pre-purge backup, i.e. accumulated over time.
 *
 * Inert for recall, but they corrupt any join that assumes referential integrity,
 * including the feedback channel's own counts.
 *
 * Run: npx vitest run tests/core/delete-engram-orphans.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { PGliteEngramStore } from '../../src/storage/pglite.js';

const AGENT = 'delete-orphans-test';

describe('EngramStore.deleteEngram — dependent rows', () => {
  let store: EngramStore;
  let tmp: string;
  let db: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-delorphan-'));
    store = new EngramStore(join(tmp, 'test.db'));
    db = (store as any).db;
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const count = (table: string, id: string) =>
    db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE engram_id = ?`).get(id).c as number;

  async function makeWithDependents() {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'a memory with dependents',
      content: 'Body long enough to look like a real memory about support ticket 10001.',
      tags: ['orphan-test'],
    } as any);
    db.prepare(
      `INSERT INTO retrieval_feedback (id, activation_event_id, engram_id, useful, context, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('fb-1', 'ev-1', e.id, 1, 'ctx', new Date().toISOString());
    db.prepare('INSERT INTO entity_mentions (entity, engram_id, agent_id) VALUES (?, ?, ?)')
      .run('ticket=10001', e.id, AGENT);
    return e;
  }

  it('removes retrieval_feedback and entity_mentions rows along with the engram', async () => {
    const e = await makeWithDependents();
    expect(count('retrieval_feedback', e.id)).toBe(1);
    expect(count('entity_mentions', e.id)).toBe(1);

    await store.deleteEngram(e.id);

    expect(await store.getEngram(e.id)).toBeNull();
    expect(count('retrieval_feedback', e.id)).toBe(0);
    expect(count('entity_mentions', e.id)).toBe(0);
  });

  it('leaves another engram\'s dependent rows untouched', async () => {
    const victim = await makeWithDependents();
    const bystander = await store.createEngram({
      agentId: AGENT,
      concept: 'an unrelated memory',
      content: 'Body about something else entirely, long enough to be plausible.',
      tags: ['orphan-test'],
    } as any);
    db.prepare('INSERT INTO entity_mentions (entity, engram_id, agent_id) VALUES (?, ?, ?)')
      .run('ticket=10002', bystander.id, AGENT);

    await store.deleteEngram(victim.id);

    expect(count('entity_mentions', bystander.id)).toBe(1);
    expect(await store.getEngram(bystander.id)).not.toBeNull();
  });

  it('leaves activation_events history alone — it records a recall that really happened', async () => {
    const e = await makeWithDependents();
    db.prepare(
      `INSERT INTO activation_events (id, agent_id, timestamp, context, results_returned, top_score, latency_ms, engram_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ev-keep', AGENT, new Date().toISOString(), 'a query', 1, 0.7, 42, JSON.stringify([e.id]));

    await store.deleteEngram(e.id);

    const row = db.prepare('SELECT engram_ids FROM activation_events WHERE id = ?').get('ev-keep');
    // Deliberate: editing the array would falsify the event rather than tidy it.
    expect(JSON.parse(row.engram_ids)).toEqual([e.id]);
  });

  it('leaves no orphan behind after a delete, which is the invariant the live store violated', async () => {
    const e = await makeWithDependents();
    await store.deleteEngram(e.id);
    const orphans = db.prepare(`
      SELECT COUNT(*) c FROM retrieval_feedback
      WHERE engram_id NOT IN (SELECT id FROM engrams)`).get().c as number;
    const entOrphans = db.prepare(`
      SELECT COUNT(*) c FROM entity_mentions
      WHERE engram_id NOT IN (SELECT id FROM engrams)`).get().c as number;
    expect(orphans).toBe(0);
    expect(entOrphans).toBe(0);
  });
});

// PGlite and Postgres share the SQL: one data-modifying statement, atomic on its own,
// because withTransaction is not re-entrant and a delete can run inside one.
describe('PGliteEngramStore.deleteEngram — dependent rows', () => {
  it('removes feedback, entity mentions and staging events with the engram, and nothing else', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-delorphan-pg-'));
    const store = new PGliteEngramStore(join(tmp, 'pg'));
    try {
      const mk = (concept: string) => store.createEngram({
        agentId: AGENT, concept,
        content: 'Body long enough to look like a real memory about support ticket 10001.',
        tags: ['orphan-test'],
      } as any);
      const victim = await mk('a memory with dependents');
      const bystander = await mk('an unrelated memory');
      const db = (store as any).db;
      for (const e of [victim, bystander]) {
        await db.query(
          `INSERT INTO retrieval_feedback (id, activation_event_id, engram_id, useful, context, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)`, [`fb-${e.id}`, 'ev-1', e.id, true, 'ctx', new Date().toISOString()]);
        await db.query('INSERT INTO entity_mentions (entity, engram_id, agent_id) VALUES ($1, $2, $3)', ['ticket=10001', e.id, AGENT]);
        await db.query(
          `INSERT INTO staging_events (engram_id, agent_id, action, resonance_score, timestamp, age_ms)
           VALUES ($1, $2, $3, $4, $5, $6)`, [e.id, AGENT, 'promoted', 0.5, new Date().toISOString(), 1]);
      }

      await store.deleteEngram(victim.id);

      const left = async (table: string, id: string) =>
        Number((await db.query(`SELECT COUNT(*) AS c FROM ${table} WHERE engram_id = $1`, [id])).rows[0].c);
      expect(await store.getEngram(victim.id)).toBeNull();
      for (const t of ['retrieval_feedback', 'entity_mentions', 'staging_events']) {
        expect(await left(t, victim.id)).toBe(0);
        expect(await left(t, bystander.id)).toBe(1);
      }
      expect(await store.getEngram(bystander.id)).not.toBeNull();
    } finally {
      await store.close();
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }, 60_000);
});
