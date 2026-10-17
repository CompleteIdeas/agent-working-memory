/**
 * Phase 6 archive floor for fade-protected classes (A-9, 2026-10-12).
 *
 * FADE_PROTECTED_CLASSES was consulted by the fade phase and by nothing in the
 * archive phase, which measured disuse as `accessCount === 0`. A rule, decision or
 * requirement that has not come up YET has accessCount 0 by construction, so the
 * store's source-of-truth layer was archived for never having been needed rather
 * than for having stopped being needed. Measured before the fix, on the live store:
 * 4,360 canonical engrams archived against 2,058 active, 2,891 of them zero-access.
 *
 * The floor is a longer clock (PROTECTED_ARCHIVE_DAYS, default 365) and not an
 * exemption, because this module's stated invariant is that nothing becomes immortal.
 * These tests pin both halves: protected inside the year, archived past it.
 *
 * Run: npx vitest run tests/engine/protected-archive-floor.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ConsolidationEngine } from '../../src/engine/consolidation.js';

const AGENT = 'archive-floor-test';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Push an engram's clocks back and set its access count, bypassing the write path. */
function age(store: EngramStore, id: string, daysAgo: number, accessCount: number) {
  const ts = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  (store as any).db.prepare(
    'UPDATE engrams SET created_at = ?, last_accessed = ?, access_count = ? WHERE id = ?',
  ).run(ts, ts, accessCount, id);
  (store as any).resetSlimCache?.();
}

/** Phase 6's cycle-count branch needs the agent to have run cycles before. */
function setCycles(store: EngramStore, n: number) {
  for (let i = 0; i < n; i++) (store as any).incrementConsolidationCycle?.(AGENT);
}

describe('ConsolidationEngine — archive floor for fade-protected classes', () => {
  let store: EngramStore;
  let consolidation: ConsolidationEngine;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-archfloor-'));
    store = new EngramStore(join(tmp, 'test.db'));
    consolidation = new ConsolidationEngine(store);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  async function make(memoryClass: 'canonical' | 'working', concept: string) {
    return await store.createEngram({
      agentId: AGENT,
      concept,
      content: `Body for ${concept}. Long enough to be a real memory but that is not what is under test here.`,
      tags: ['archive-floor'],
      memoryClass,
    } as any);
  }

  it('does NOT archive a zero-access canonical engram at 60 days, but DOES archive a working one', async () => {
    const canonical = await make('canonical', 'deployment requires the owner proxy');
    const working = await make('working', 'scratch note about the owner proxy');
    age(store, canonical.id, 60, 0);
    age(store, working.id, 60, 0);
    setCycles(store, 10);

    await consolidation.consolidate(AGENT);

    // This is the whole point of the floor: identical age, identical disuse,
    // different class, different outcome. 60 days is past FORGET_ARCHIVE_DAYS (30)
    // and short of FORGET_DELETE_DAYS (90), so the working engram lands in
    // 'archived' rather than being removed — see the same-cycle test below.
    expect((await store.getEngram(canonical.id))!.stage).toBe('active');
    expect((await store.getEngram(working.id))!.stage).toBe('archived');
  });

  it('archives AND deletes an unprotected engram in the SAME cycle past 90 days, while the protected one survives both', async () => {
    const canonical = await make('canonical', 'the owner-proxy migration order');
    const working = await make('working', 'scratch note nobody came back to');
    age(store, canonical.id, 95, 0);
    age(store, working.id, 95, 0);
    setCycles(store, 10);

    await consolidation.consolidate(AGENT);

    // Phase 6 archives, then the delete loop re-reads the archived set in the
    // same pass — so a zero-access, edgeless engram past FORGET_DELETE_DAYS is
    // created, archived and permanently deleted without any cycle in between.
    // Discovered by this fixture on 2026-10-12. That is defensible for a
    // scratch note and was not for a canonical decision: before the class
    // guard in the delete loop, a source-of-truth memory nobody had happened
    // to recall yet could be destroyed outright on day 91, with archiving
    // never acting as the recoverable intermediate stage it is documented to be.
    expect(await store.getEngram(working.id)).toBeNull();
    expect((await store.getEngram(canonical.id))!.stage).toBe('active');
  });

  it('gives a SUPERSEDED canonical engram no floor: its successor is the source of truth now', async () => {
    const old = await make('canonical', 'the old deployment order');
    const successor = await make('canonical', 'the new deployment order');
    (store as any).db.prepare('UPDATE engrams SET superseded_by = ? WHERE id = ?').run(successor.id, old.id);
    // A distinct body, so redundancy pruning (Phase 6.5) does not pair the fixtures up.
    (store as any).db.prepare('UPDATE engrams SET content = ? WHERE id = ?')
      .run('Releases go out through the blue-green slot swap since the March outage; the proxy step is gone.', successor.id);
    age(store, old.id, 60, 0);
    age(store, successor.id, 60, 0);
    setCycles(store, 10);

    await consolidation.consolidate(AGENT);

    // Same age, same disuse, same class: the superseded one leaves the active pool on
    // the ordinary clock instead of ranking for a year with a SUPERSEDED label.
    expect((await store.getEngram(old.id))!.stage).toBe('archived');
    expect((await store.getEngram(successor.id))!.stage).toBe('active');
  });

  it('DOES archive a zero-access canonical engram once it is past the one-year floor', async () => {
    const canonical = await make('canonical', 'a requirement nobody ever needed');
    age(store, canonical.id, 400, 0);
    setCycles(store, 10);

    await consolidation.consolidate(AGENT);

    // A floor, not an exemption — the module's invariant is that rehearsal
    // extends protection but never makes anything immortal.
    expect((await store.getEngram(canonical.id))!.stage).toBe('archived');
  });

  it('never deletes a fade-protected engram, even archived, ancient, isolated and unread', async () => {
    const canonical = await make('canonical', 'ancient decision nobody read');
    await store.updateStage(canonical.id, 'archived');
    age(store, canonical.id, 500, 0);
    setCycles(store, 10);

    await consolidation.consolidate(AGENT);

    // Deletion is the only irreversible step in the cycle, and it ran on the
    // same reading of disuse the floor exists to correct.
    expect(await store.getEngram(canonical.id)).not.toBeNull();
  });

  it('still deletes a working engram under the same ancient-isolated-unread conditions', async () => {
    const working = await make('working', 'ancient scratch note nobody read');
    await store.updateStage(working.id, 'archived');
    age(store, working.id, 500, 0);
    setCycles(store, 10);

    await consolidation.consolidate(AGENT);

    // Proves the assertion above is the class guard firing and not the
    // delete branch being unreachable in this fixture.
    expect(await store.getEngram(working.id)).toBeNull();
  });
});
