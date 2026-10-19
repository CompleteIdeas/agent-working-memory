// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Supersession tests — verify that outdated memories are replaced, not deleted.
 *
 * Tests:
 *   1. Superseded memory is down-ranked in recall (successor dominates)
 *   2. Supersession chain works (A → B → C: A is still retrievable but low-ranked)
 *   3. memory_class=canonical bypasses staging
 *   4. task_end with supersedes marks old memories correctly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { evaluateSalience, computeNovelty } from '../../src/core/salience.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = join(tmpdir(), `awm-supersession-${Date.now()}.db`);
const AGENT_ID = 'test-agent';

let store: EngramStore;
let engine: ActivationEngine;

beforeEach(() => {
  store = new EngramStore(TEST_DB);
  engine = new ActivationEngine(store);
});

afterEach(() => {
  store.close();
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + '-shm'); } catch {}
  try { unlinkSync(TEST_DB + '-wal'); } catch {}
});

describe('Supersession', () => {
  it('superseded memory gets down-ranked in recall', async () => {
    // Write original memory
    const old = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Staff review status',
      content: 'Five staff review meetings completed for the platform.',
      salience: 0.7,
      confidence: 0.6,
    });

    // Write replacement
    const replacement = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Staff review status updated',
      content: 'Seven staff review meetings completed for the platform. All docs cleaned.',
      salience: 0.8,
      confidence: 0.7,
    });

    // Supersede
    store.supersedeEngram(old.id, replacement.id);

    // Recall — replacement should dominate
    const results = await engine.activate({
      agentId: AGENT_ID,
      context: 'staff review meetings completed',
      limit: 5,
      useReranker: false,
      useExpansion: false,
      internal: true,
    });

    expect(results.length).toBeGreaterThan(0);
    // Replacement should be first (or old should be severely down-ranked)
    const oldResult = results.find(r => r.engram.id === old.id);
    const newResult = results.find(r => r.engram.id === replacement.id);

    if (oldResult && newResult) {
      expect(newResult.score).toBeGreaterThan(oldResult.score);
    }
    // At minimum, replacement should be in results
    expect(newResult).toBeDefined();
  });

  it('marks a superseded memory with the stale penalty rerank2 reads', async () => {
    // The 2026-10-19 hole: Phase 8c cut the blended score but left
    // phaseScores untouched, so rerank2's re-sort by reranker score put the
    // superseded memory back on top. The penalty must now travel with the
    // result. (The re-sort itself is pinned in rerank2.test.ts; this proves
    // the engine hands it the mark.)
    const old = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Report layout',
      content: 'The weekly report uses a flat list of items under one heading.',
      salience: 0.7,
      confidence: 0.6,
    });
    const replacement = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Report layout updated',
      content: 'The weekly report groups items under a Team heading, one per team.',
      salience: 0.8,
      confidence: 0.7,
    });
    store.supersedeEngram(old.id, replacement.id);

    const results = await engine.activate({
      agentId: AGENT_ID,
      context: 'weekly report layout heading',
      limit: 5,
      useReranker: false,
      useExpansion: false,
      internal: true,
    });
    const oldResult = results.find(r => r.engram.id === old.id);
    const newResult = results.find(r => r.engram.id === replacement.id);
    expect(newResult).toBeDefined();
    expect(newResult!.phaseScores.stalePenalty).toBeUndefined();
    if (oldResult) {
      expect(oldResult.phaseScores.stalePenalty).toBe(0.15);
      expect(newResult!.score).toBeGreaterThan(oldResult.score);
    }
  });

  it('down-ranks a memory past its valid_to the same way, with the decay clock pinned', async () => {
    // Before 2026-10-19 valid_to was display-only: the live store served 482
    // expired memories as current. Expiry now takes the supersession penalty.
    const expired = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Studio meeting place',
      content: 'The studio is closed for repairs; the Tuesday class meets at the cafe instead.',
      salience: 0.8,
      confidence: 0.8,
      validTo: '2026-01-15',
    });
    const current = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Studio meeting place now',
      content: 'The Tuesday class meets at the studio again; repairs are finished.',
      salience: 0.7,
      confidence: 0.6,
    });

    const asOf = Date.parse('2026-03-10T12:00:00Z');
    const results = await engine.activate({
      agentId: AGENT_ID,
      context: 'where does the Tuesday class meet',
      limit: 5,
      useReranker: false,
      useExpansion: false,
      internal: true,
      asOf,
    });
    const exp = results.find(r => r.engram.id === expired.id);
    const cur = results.find(r => r.engram.id === current.id);
    expect(cur).toBeDefined();
    expect(cur!.phaseScores.stalePenalty).toBeUndefined();
    if (exp) {
      expect(exp.phaseScores.stalePenalty).toBe(0.15);
      expect(cur!.score).toBeGreaterThan(exp.score);
    }

    // The same memory, asked for BEFORE it expired, is current.
    const earlier = await engine.activate({
      agentId: AGENT_ID,
      context: 'where does the Tuesday class meet',
      limit: 5,
      useReranker: false,
      useExpansion: false,
      internal: true,
      asOf: Date.parse('2026-01-10T12:00:00Z'),
    });
    const expEarlier = earlier.find(r => r.engram.id === expired.id);
    if (expEarlier) expect(expEarlier.phaseScores.stalePenalty).toBeUndefined();
  });

  it('down-ranks a memory before its valid_from', async () => {
    const future = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Registration opening',
      content: 'Registration for the winter season is open to all families.',
      salience: 0.8,
      confidence: 0.8,
      validFrom: '2026-11-03',
    });
    const results = await engine.activate({
      agentId: AGENT_ID,
      context: 'is winter registration open',
      limit: 5,
      useReranker: false,
      useExpansion: false,
      internal: true,
      asOf: Date.parse('2026-10-19T12:00:00Z'),
    });
    const f = results.find(r => r.engram.id === future.id);
    if (f) expect(f.phaseScores.stalePenalty).toBe(0.15);
  });

  it('supersedeEngram sets bidirectional links', () => {
    const old = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Original fact',
      content: 'Two repos exist.',
      salience: 0.6,
    });

    const replacement = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Updated fact',
      content: 'Three repos exist.',
      salience: 0.7,
    });

    store.supersedeEngram(old.id, replacement.id);

    const updatedOld = store.getEngram(old.id)!;
    const updatedNew = store.getEngram(replacement.id)!;

    expect(updatedOld.supersededBy).toBe(replacement.id);
    expect(updatedNew.supersedes).toBe(old.id);
  });

  it('isSuperseded returns correct status', () => {
    const old = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Old info',
      content: 'Stale data.',
      salience: 0.5,
    });

    expect(store.isSuperseded(old.id)).toBe(false);

    const replacement = store.createEngram({
      agentId: AGENT_ID,
      concept: 'New info',
      content: 'Current data.',
      salience: 0.6,
    });

    store.supersedeEngram(old.id, replacement.id);
    expect(store.isSuperseded(old.id)).toBe(true);
    expect(store.isSuperseded(replacement.id)).toBe(false);
  });
});

describe('Memory Class', () => {
  it('canonical memory always goes active (never staging)', () => {
    const result = evaluateSalience({
      content: 'Low-signal observation.',
      eventType: 'observation',
      surprise: 0,
      decisionMade: false,
      causalDepth: 0,
      resolutionEffort: 0,
      novelty: 0.3, // Low novelty would normally stage/discard
      memoryClass: 'canonical',
    });

    expect(result.disposition).toBe('active');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.reasonCodes).toContain('class:canonical');
  });

  it('working memory follows standard salience rules', () => {
    const result = evaluateSalience({
      content: 'Regular observation.',
      eventType: 'observation',
      surprise: 0.1,
      decisionMade: false,
      causalDepth: 0.1,
      resolutionEffort: 0.1,
      novelty: 0.3, // Low novelty
      memoryClass: 'working',
    });

    // Low signals + low novelty → should be staging or discard
    expect(result.disposition).not.toBe('active');
  });

  it('ephemeral memory gets tagged', () => {
    const result = evaluateSalience({
      content: 'Debugging trace.',
      eventType: 'observation',
      surprise: 0.5,
      novelty: 0.8,
      memoryClass: 'ephemeral',
    });

    expect(result.reasonCodes).toContain('class:ephemeral');
  });

  it('memory_class column persists in storage', () => {
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Canonical fact',
      content: 'This is source of truth.',
      salience: 0.8,
      memoryClass: 'canonical',
    });

    const fetched = store.getEngram(engram.id)!;
    expect(fetched.memoryClass).toBe('canonical');
  });

  it('default memory_class is working', () => {
    const engram = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Regular memory',
      content: 'Just an observation.',
      salience: 0.5,
    });

    const fetched = store.getEngram(engram.id)!;
    expect(fetched.memoryClass).toBe('working');
  });
});

describe('EngramCreate with supersedes', () => {
  it('createEngram stores supersedes field', () => {
    const old = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Version 1',
      content: 'Original.',
      salience: 0.5,
    });

    const replacement = store.createEngram({
      agentId: AGENT_ID,
      concept: 'Version 2',
      content: 'Updated.',
      salience: 0.6,
      supersedes: old.id,
    });

    const fetched = store.getEngram(replacement.id)!;
    expect(fetched.supersedes).toBe(old.id);
  });
});
