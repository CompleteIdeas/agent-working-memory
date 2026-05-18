// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * AWM 0.8 Cluster C — materialized-view + atomic-counter primitives.
 *
 * Covers:
 *   - getLatestByTag: group-by-tag-value, latest active per group, scope
 *     narrowing, sortBy=sequence excludes NULL-sequence engrams
 *   - getTopBy: filter by tagsAll/Any/None, numeric sort by tag prefix,
 *     NaN sorts last
 *   - resolveEffectiveState: active by default, terminal via references,
 *     superseded via supersededBy, latest event wins
 *   - allocateNextSequence: starts at 1, increments, agent-scoped
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';

describe('Cluster C: latest-by-tag, top-by, resolve, sequence (0.8)', () => {
  let store: EngramStore;
  let tmp: string;
  const AGENT = 'test-cluster-c';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-cluster-c-'));
    store = new EngramStore(join(tmp, 'test.db'));
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ───────────────────────────────────────────────
  // getLatestByTag
  // ───────────────────────────────────────────────

  describe('getLatestByTag', () => {
    it('returns latest engram per distinct tag value', () => {
      // Three chapters' worth of "emotional-state for Hannah" — only the latest should win.
      const e1 = store.createEngram({
        agentId: AGENT,
        concept: 'Hannah Ch 1',
        content: 'controlled-grief',
        tags: ['topic=emotional-state', 'character=Hannah', 'chapter=01'],
        sequence: 1,
      });
      const e2 = store.createEngram({
        agentId: AGENT,
        concept: 'Hannah Ch 2',
        content: 'professional mode',
        tags: ['topic=emotional-state', 'character=Hannah', 'chapter=02'],
        sequence: 2,
      });
      const e3 = store.createEngram({
        agentId: AGENT,
        concept: 'Hannah Ch 3',
        content: 'purposeful momentum',
        tags: ['topic=emotional-state', 'character=Hannah', 'chapter=03'],
        sequence: 3,
      });
      // Different character — should show up alongside Hannah's latest
      const m1 = store.createEngram({
        agentId: AGENT,
        concept: 'Mara Ch 3',
        content: 'tired honesty',
        tags: ['topic=emotional-state', 'character=Mara', 'chapter=03'],
        sequence: 3,
      });

      const results = store.getLatestByTag({
        agentId: AGENT,
        tagKeyPrefix: 'character=',
        scopeTagsAll: ['topic=emotional-state'],
        // Use sequence ordering — engrams created in rapid succession can
        // share createdAt to ms resolution and produce non-deterministic
        // ORDER BY. Sequence is monotonic per chapter, deterministic.
        sortBy: 'sequence',
      });

      expect(results.length).toBe(2);
      const byChar = new Map(results.map(r => {
        const char = r.tags.find(t => t.startsWith('character='))!.slice('character='.length);
        return [char, r];
      }));
      expect(byChar.get('Hannah')!.id).toBe(e3.id);   // latest Hannah, not e1/e2
      expect(byChar.get('Mara')!.id).toBe(m1.id);
    });

    it('honors sortBy=sequence — engrams without sequence are excluded', () => {
      store.createEngram({
        agentId: AGENT,
        concept: 'no-seq',
        content: 'has tag but no sequence',
        tags: ['motif=water'],
        // sequence omitted
      });
      const withSeq = store.createEngram({
        agentId: AGENT,
        concept: 'with-seq',
        content: 'has both',
        tags: ['motif=water'],
        sequence: 5,
      });
      const results = store.getLatestByTag({
        agentId: AGENT,
        tagKeyPrefix: 'motif=',
        sortBy: 'sequence',
      });
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(withSeq.id);
    });

    it('scopeTagsAll narrows the candidate set', () => {
      store.createEngram({
        agentId: AGENT,
        concept: 'wrong topic',
        content: '',
        tags: ['character=Hannah', 'topic=other'],
      });
      const right = store.createEngram({
        agentId: AGENT,
        concept: 'right topic',
        content: '',
        tags: ['character=Hannah', 'topic=emotional-state'],
      });
      const results = store.getLatestByTag({
        agentId: AGENT,
        tagKeyPrefix: 'character=',
        scopeTagsAll: ['topic=emotional-state'],
      });
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(right.id);
    });
  });

  // ───────────────────────────────────────────────
  // getTopBy
  // ───────────────────────────────────────────────

  describe('getTopBy', () => {
    it('sorts by numeric tag value desc, returns top N', () => {
      store.createEngram({
        agentId: AGENT,
        concept: 'p1',
        content: '',
        tags: ['topic=promise', 'state=active', 'weight=3'],
      });
      store.createEngram({
        agentId: AGENT,
        concept: 'p2',
        content: '',
        tags: ['topic=promise', 'state=active', 'weight=9'],
      });
      store.createEngram({
        agentId: AGENT,
        concept: 'p3',
        content: '',
        tags: ['topic=promise', 'state=active', 'weight=7'],
      });

      const results = store.getTopBy({
        agentId: AGENT,
        sortField: 'weight=',
        order: 'desc',
        filterTagsAll: ['topic=promise', 'state=active'],
        limit: 2,
      });
      expect(results.length).toBe(2);
      expect(results.map(r => r.concept)).toEqual(['p2', 'p3']);
    });

    it('excludes engrams matching filterTagsNone', () => {
      store.createEngram({
        agentId: AGENT,
        concept: 'kept',
        content: '',
        tags: ['topic=promise', 'state=active', 'weight=9'],
      });
      store.createEngram({
        agentId: AGENT,
        concept: 'filtered',
        content: '',
        tags: ['topic=promise', 'state=active', 'weight=8', 'kind=advancement'],
      });

      const results = store.getTopBy({
        agentId: AGENT,
        sortField: 'weight=',
        order: 'desc',
        filterTagsAll: ['topic=promise', 'state=active'],
        filterTagsNone: ['kind=advancement'],
      });
      expect(results.length).toBe(1);
      expect(results[0]!.concept).toBe('kept');
    });

    it('NaN sortField values sort last', () => {
      store.createEngram({
        agentId: AGENT,
        concept: 'numeric',
        content: '',
        tags: ['priority=5'],
      });
      store.createEngram({
        agentId: AGENT,
        concept: 'nonnumeric',
        content: '',
        tags: ['priority=high'],
      });

      const results = store.getTopBy({
        agentId: AGENT,
        sortField: 'priority=',
        order: 'desc',
      });
      expect(results.length).toBe(2);
      expect(results[0]!.concept).toBe('numeric');     // 5 is numeric → first
      expect(results[1]!.concept).toBe('nonnumeric');  // NaN → last
    });
  });

  // ───────────────────────────────────────────────
  // resolveEffectiveState
  // ───────────────────────────────────────────────

  describe('resolveEffectiveState', () => {
    it('returns "active" when no terminal reference + not superseded', () => {
      const e = store.createEngram({
        agentId: AGENT,
        concept: 'open promise',
        content: '',
        tags: ['topic=promise', 'state=active'],
      });
      const result = store.resolveEffectiveState(e.id)!;
      expect(result.effectiveState).toBe('active');
      expect(result.resolvingEvents.length).toBe(0);
    });

    it('returns "resolved" when a terminal reference exists', () => {
      const promise = store.createEngram({
        agentId: AGENT,
        concept: 'Mara deferred disclosure',
        content: '',
        tags: ['topic=promise', 'state=active'],
      });
      store.createEngram({
        agentId: AGENT,
        concept: 'Resolution of Mara',
        content: '',
        tags: ['topic=promise', 'kind=advancement'],
        references: [
          { type: 'resolves', matchEngramId: promise.id },
        ],
      });

      const result = store.resolveEffectiveState(promise.id)!;
      expect(result.effectiveState).toBe('resolved');
      expect(result.resolvingEvents.length).toBe(1);
      expect(result.resolvingEvents[0]!.type).toBe('resolves');
    });

    it('returns "superseded" when supersededBy is set', () => {
      const old = store.createEngram({ agentId: AGENT, concept: 'old', content: '' });
      const next = store.createEngram({ agentId: AGENT, concept: 'new', content: '' });
      store.supersedeEngram(old.id, next.id);

      const result = store.resolveEffectiveState(old.id)!;
      expect(result.effectiveState).toBe('superseded');
    });

    it('latest terminal event wins (resolved overrides earlier subverts)', () => {
      const promise = store.createEngram({
        agentId: AGENT,
        concept: 'X',
        content: '',
        tags: ['topic=promise'],
      });
      // Earlier event (subverts)
      store.createEngram({
        agentId: AGENT,
        concept: 'first try',
        content: '',
        references: [{ type: 'subverts', matchEngramId: promise.id }],
      });
      // Slight sleep so createdAt differs
      const sleepStart = Date.now();
      while (Date.now() - sleepStart < 10) { /* spin */ }
      store.createEngram({
        agentId: AGENT,
        concept: 'final outcome',
        content: '',
        references: [{ type: 'resolves', matchEngramId: promise.id }],
      });

      const result = store.resolveEffectiveState(promise.id)!;
      expect(result.effectiveState).toBe('resolved');
      expect(result.resolvingEvents.length).toBe(2);
    });

    it('returns null for unknown engram id', () => {
      expect(store.resolveEffectiveState('nonexistent-id')).toBeNull();
    });
  });

  // ───────────────────────────────────────────────
  // allocateNextSequence
  // ───────────────────────────────────────────────

  describe('allocateNextSequence', () => {
    it('starts at 1 when no engrams have a sequence', () => {
      expect(store.allocateNextSequence(AGENT)).toBe(1);
    });

    it('returns MAX(sequence)+1', () => {
      store.createEngram({ agentId: AGENT, concept: 'a', content: '', sequence: 5 });
      store.createEngram({ agentId: AGENT, concept: 'b', content: '', sequence: 7 });
      store.createEngram({ agentId: AGENT, concept: 'c', content: '', sequence: 3 });
      expect(store.allocateNextSequence(AGENT)).toBe(8);
    });

    it('is agent-scoped (does not pull from other agents)', () => {
      store.createEngram({ agentId: 'other-agent', concept: 'a', content: '', sequence: 100 });
      expect(store.allocateNextSequence(AGENT)).toBe(1);
    });

    it('handles repeated allocation without conflict', () => {
      // Doesn't actually reserve — caller is expected to write between calls.
      // This test confirms the formula is correct after each write.
      const s1 = store.allocateNextSequence(AGENT);
      store.createEngram({ agentId: AGENT, concept: 'a', content: '', sequence: s1 });
      const s2 = store.allocateNextSequence(AGENT);
      store.createEngram({ agentId: AGENT, concept: 'b', content: '', sequence: s2 });
      expect(s1).toBe(1);
      expect(s2).toBe(2);
    });
  });
});
