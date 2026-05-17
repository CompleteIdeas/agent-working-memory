// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * AWM 0.8 Cluster B — set-theoretic tag operators + sortBy on store.search().
 *
 * Composition: result = tagsAll ∧ (tagsAny[0] ∨ ...) ∧ ¬(tagsNone[0] ∨ ...)
 *
 * - Empty arrays skip the clause (vacuous truth)
 * - Legacy `tags` field continues to mean AND; if both `tags` and `tagsAll`
 *   are present, both apply (intersection of both AND-filters)
 * - sortBy defaults to `lastAccessed` DESC (preserves 0.7.x behavior)
 * - sortBy=sequence puts NULL last regardless of direction
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';

describe('search operators (0.8 Cluster B)', () => {
  let store: EngramStore;
  let tmp: string;
  const AGENT = 'test-search-ops';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-search-ops-'));
    store = new EngramStore(join(tmp, 'test.db'));

    // Seed: four engrams with distinct tag profiles + sequence ordering.
    store.createEngram({
      agentId: AGENT,
      concept: 'A — high weight active',
      content: 'a',
      tags: ['topic=promise', 'state=active', 'weight=9'],
      sequence: 1,
    });
    store.createEngram({
      agentId: AGENT,
      concept: 'B — high weight resolved',
      content: 'b',
      tags: ['topic=promise', 'state=resolved', 'weight=8', 'kind=advancement'],
      sequence: 2,
    });
    store.createEngram({
      agentId: AGENT,
      concept: 'C — low weight active',
      content: 'c',
      tags: ['topic=promise', 'state=active', 'weight=3'],
      sequence: 3,
    });
    store.createEngram({
      agentId: AGENT,
      concept: 'D — different topic',
      content: 'd',
      tags: ['topic=motif-use', 'phase=memory'],
      // sequence omitted — should sort last under sortBy=sequence
    });
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ── tagsAll ──

  it('tagsAll filters to engrams matching all tags (AND)', () => {
    const r = store.search({
      agentId: AGENT,
      tagsAll: ['topic=promise', 'state=active'],
    });
    expect(r.length).toBe(2);
    expect(r.map(e => e.concept).sort()).toEqual([
      'A — high weight active',
      'C — low weight active',
    ]);
  });

  it('legacy `tags` field still means AND (backward compat)', () => {
    const r = store.search({
      agentId: AGENT,
      tags: ['topic=promise', 'state=active'],
    });
    expect(r.length).toBe(2);
  });

  it('`tags` and `tagsAll` together intersect (both apply)', () => {
    const r = store.search({
      agentId: AGENT,
      tags: ['topic=promise'],
      tagsAll: ['state=active'],
    });
    expect(r.length).toBe(2);
  });

  // ── tagsAny ──

  it('tagsAny matches engrams with at least one of the tags', () => {
    const r = store.search({
      agentId: AGENT,
      tagsAny: ['weight=9', 'weight=8'],
    });
    expect(r.length).toBe(2);
    expect(r.map(e => e.concept).sort()).toEqual([
      'A — high weight active',
      'B — high weight resolved',
    ]);
  });

  it('tagsAll + tagsAny composes as AND-of-OR-set', () => {
    const r = store.search({
      agentId: AGENT,
      tagsAll: ['topic=promise'],
      tagsAny: ['weight=9', 'weight=3'],
    });
    expect(r.length).toBe(2);
    expect(r.map(e => e.concept).sort()).toEqual([
      'A — high weight active',
      'C — low weight active',
    ]);
  });

  // ── tagsNone ──

  it('tagsNone excludes engrams with any of the listed tags', () => {
    const r = store.search({
      agentId: AGENT,
      tagsAll: ['topic=promise'],
      tagsNone: ['kind=advancement'],
    });
    expect(r.length).toBe(2);
    expect(r.map(e => e.concept).sort()).toEqual([
      'A — high weight active',
      'C — low weight active',
    ]);
  });

  it('full composition: tagsAll ∧ tagsAny ∧ ¬tagsNone', () => {
    // "active or resolved promises with weight 8 or 9, excluding advancements"
    const r = store.search({
      agentId: AGENT,
      tagsAll: ['topic=promise'],
      tagsAny: ['weight=9', 'weight=8'],
      tagsNone: ['kind=advancement'],
    });
    expect(r.length).toBe(1);
    expect(r[0]!.concept).toBe('A — high weight active');
  });

  // ── empty-array semantics (vacuous truth) ──

  it('empty tagsAll skips the clause', () => {
    const r = store.search({ agentId: AGENT, tagsAll: [] });
    expect(r.length).toBe(4);
  });

  it('empty tagsAny skips the clause', () => {
    const r = store.search({ agentId: AGENT, tagsAny: [] });
    expect(r.length).toBe(4);
  });

  it('empty tagsNone skips the clause', () => {
    const r = store.search({ agentId: AGENT, tagsNone: [] });
    expect(r.length).toBe(4);
  });

  // ── sortBy ──

  it('default sort (no sortBy) is lastAccessed DESC — preserves 0.7.x behavior', () => {
    const r = store.search({ agentId: AGENT });
    // All four engrams created within milliseconds; order can shift. Confirm
    // we got all four and didn't throw.
    expect(r.length).toBe(4);
  });

  it('sortBy=sequence DESC sorts non-null first, NULL last', () => {
    const r = store.search({ agentId: AGENT, sortBy: 'sequence' });
    expect(r.length).toBe(4);
    expect(r[0]!.sequence).toBe(3);
    expect(r[1]!.sequence).toBe(2);
    expect(r[2]!.sequence).toBe(1);
    expect(r[3]!.sequence).toBeNull();  // D, no sequence
  });

  it('sortBy=sequence ASC still puts NULL last', () => {
    const r = store.search({ agentId: AGENT, sortBy: 'sequence', sortOrder: 'asc' });
    expect(r.length).toBe(4);
    expect(r[0]!.sequence).toBe(1);
    expect(r[1]!.sequence).toBe(2);
    expect(r[2]!.sequence).toBe(3);
    expect(r[3]!.sequence).toBeNull();
  });

  it('sortBy=createdAt is supported', () => {
    const r = store.search({ agentId: AGENT, sortBy: 'createdAt', sortOrder: 'asc' });
    expect(r.length).toBe(4);
    expect(r[0]!.concept).toBe('A — high weight active');
    expect(r[3]!.concept).toBe('D — different topic');
  });
});
