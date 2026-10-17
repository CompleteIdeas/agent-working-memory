/**
 * Stage-transition timestamp (A-4, 2026-10-12).
 *
 * The engrams table carried created_at, last_accessed and retracted_at, and nothing
 * that recorded WHEN a lifecycle decision was taken. For a store that is 60.7%
 * archived, that made fade regret and archive regret — "was this needed after we hid
 * it?" — impossible to compute after the fact, which is target T4 in
 * docs/eval-gap-2026-10-11.md.
 *
 * The write lives in `updateStage`, the single chokepoint all six consolidation
 * transitions pass through, so a future transition cannot forget to record it. These
 * tests pin that, and pin the no-backfill contract: null means "never transitioned",
 * so readers fall back to created_at rather than seeing a false transition date.
 *
 * Run: npx vitest run tests/core/stage-changed-at.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';

const AGENT = 'stage-ts-test';

describe('EngramStore.updateStage — stage_changed_at', () => {
  let store: EngramStore;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-stagets-'));
    store = new EngramStore(join(tmp, 'test.db'));
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  async function make(concept: string) {
    return await store.createEngram({
      agentId: AGENT,
      concept,
      content: `Body for ${concept}, long enough to be a plausible memory.`,
      tags: ['stage-ts'],
    } as any);
  }

  it('is null on a fresh engram — never transitioned, so readers fall back to createdAt', async () => {
    const e = await make('a memory that has not moved');
    const read = await store.getEngram(e.id);
    expect(read!.stageChangedAt ?? null).toBeNull();
  });

  it('records an ISO timestamp when the stage changes', async () => {
    const e = await make('a memory about to be archived');
    const before = Date.now();
    await store.updateStage(e.id, 'archived');

    const read = await store.getEngram(e.id);
    expect(read!.stage).toBe('archived');
    const ts = read!.stageChangedAt;
    expect(typeof ts).toBe('string');
    const parsed = Date.parse(ts as string);
    expect(Number.isNaN(parsed)).toBe(false);
    // Within the window of this test, so it is the transition time and not,
    // say, created_at copied across.
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('advances on each subsequent transition, so the value is "last changed" not "first changed"', async () => {
    const e = await make('a memory that fades then archives');
    await store.updateStage(e.id, 'fading');
    const first = (await store.getEngram(e.id))!.stageChangedAt as string;

    // Push the recorded value back so the second write is distinguishable
    // without sleeping in a unit test.
    (store as any).db.prepare('UPDATE engrams SET stage_changed_at = ? WHERE id = ?')
      .run(new Date(Date.parse(first) - 60_000).toISOString(), e.id);

    await store.updateStage(e.id, 'archived');
    const second = (await store.getEngram(e.id))!.stageChangedAt as string;

    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first) - 60_000);
    expect((await store.getEngram(e.id))!.stage).toBe('archived');
  });

  it('makes time-in-stage computable, which is the only reason the column exists', async () => {
    const e = await make('an archived memory with a known archive date');
    await store.updateStage(e.id, 'archived');
    (store as any).db.prepare('UPDATE engrams SET stage_changed_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 45 * 86_400_000).toISOString(), e.id);

    const read = await store.getEngram(e.id);
    const days = (Date.now() - Date.parse(read!.stageChangedAt as string)) / 86_400_000;
    expect(Math.round(days)).toBe(45);
  });
});
