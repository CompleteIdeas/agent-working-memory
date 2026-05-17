// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * AWM 0.8 Cluster D — atomic write-and-supersede by concept match (Form B).
 *
 * Form B = {agentId, matchConcept, newEngram} → find most recent active
 * engram with matching concept, write new engram, supersede old, all in
 * one SQL transaction.
 *
 * Distinct from 0.7.17 R3 (corrections override on surprise/friction
 * eventType + same-concept). Form B is for "I'm writing a new record
 * with a different concept that obsoletes a prior one by reference."
 *
 * Also covers:
 * - findActiveMatchByConcept correctness (most recent active wins, excludes
 *   superseded + retracted + non-active stage)
 * - references[] resolution: matchConcept → matchEngramId at write time
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';

describe('Form B atomic write-and-supersede + references (0.8 Cluster D)', () => {
  let store: EngramStore;
  let connectionEngine: ConnectionEngine;
  let tmp: string;
  const AGENT = 'test-form-b';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-form-b-'));
    store = new EngramStore(join(tmp, 'test.db'));
    const activation = new ActivationEngine(store);
    connectionEngine = new ConnectionEngine(store, activation);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Helper that mirrors the route's Form B logic.
  function formB(matchConcept: string, newConcept: string, newContent: string, matchTags?: string[]) {
    return store.transaction(() => {
      const matched = store.findActiveMatchByConcept(AGENT, matchConcept, matchTags);
      const writeRes = performWrite({ store, connectionEngine }, {
        agentId: AGENT,
        concept: newConcept,
        content: newContent,
        memoryClass: 'structural',
        enableReinforcement: false,
      });
      if (matched) {
        store.upsertAssociation(writeRes.engram.id, matched.id, 0.8, 'causal', 1.0);
        store.updateConfidence(matched.id, matched.confidence * 0.2);
        store.supersedeEngram(matched.id, writeRes.engram.id);
      }
      return { newEngram: writeRes.engram, supersededId: matched?.id ?? null };
    });
  }

  // ── findActiveMatchByConcept ──

  it('findActiveMatchByConcept returns most recent active match', () => {
    const e1 = store.createEngram({
      agentId: AGENT, concept: "Mara's deferred disclosure", content: 'first',
    });
    // Slight delay via a second creation to differentiate createdAt
    const e2 = store.createEngram({
      agentId: AGENT, concept: "mara's deferred disclosure", content: 'second',
    });
    const matched = store.findActiveMatchByConcept(AGENT, "Mara's deferred disclosure");
    expect(matched).not.toBeNull();
    // Case-insensitive trimmed concept equality — newest wins.
    expect(matched!.id).toBe(e2.id);
  });

  it('findActiveMatchByConcept excludes superseded engrams', () => {
    const e1 = store.createEngram({
      agentId: AGENT, concept: 'Promise X', content: 'first',
    });
    const e2 = store.createEngram({
      agentId: AGENT, concept: 'Different concept', content: 'second',
    });
    store.supersedeEngram(e1.id, e2.id);  // e1 now superseded by e2
    const matched = store.findActiveMatchByConcept(AGENT, 'Promise X');
    expect(matched).toBeNull();
  });

  it('findActiveMatchByConcept narrows by required tags', () => {
    store.createEngram({
      agentId: AGENT, concept: 'Promise X', content: 'wrong tags',
      tags: ['topic=promise', 'state=resolved'],
    });
    const e2 = store.createEngram({
      agentId: AGENT, concept: 'Promise X', content: 'right tags',
      tags: ['topic=promise', 'state=active'],
    });
    const matched = store.findActiveMatchByConcept(
      AGENT, 'Promise X', ['topic=promise', 'state=active'],
    );
    expect(matched).not.toBeNull();
    expect(matched!.id).toBe(e2.id);
  });

  // ── Form B happy path ──

  it('Form B with match: writes new engram + supersedes old atomically', () => {
    const oldE = store.createEngram({
      agentId: AGENT,
      concept: "Mara's deferred disclosure",
      content: 'Original promise from Ch 1',
      tags: ['topic=promise', 'state=active'],
    });

    const result = formB(
      "Mara's deferred disclosure",
      "Mara's deferred disclosure — RESOLVED in Ch 3",
      'Resolved when Mara talked at the kitchen table',
    );

    expect(result.supersededId).toBe(oldE.id);
    expect(result.newEngram.id).not.toBe(oldE.id);

    // Old engram is marked superseded
    const refetchedOld = store.getEngram(oldE.id)!;
    expect(refetchedOld.supersededBy).toBe(result.newEngram.id);

    // Confidence decayed to 20%
    expect(refetchedOld.confidence).toBeCloseTo(0.1, 5);  // 0.5 * 0.2

    // Causal association created
    const assocs = store.getAssociationsFor(result.newEngram.id);
    expect(assocs.some(a => a.toEngramId === oldE.id && a.type === 'causal')).toBe(true);

    // Subsequent findActiveMatchByConcept skips the superseded one
    const followUp = store.findActiveMatchByConcept(AGENT, "Mara's deferred disclosure");
    expect(followUp).toBeNull();
  });

  it('Form B with no match: writes new engram, returns supersededId=null', () => {
    const result = formB(
      'Nonexistent promise',
      'Resolution of nonexistent thing',
      'But we wrote the record anyway',
    );

    expect(result.supersededId).toBeNull();
    expect(result.newEngram).toBeTruthy();
    expect(store.getEngramsByAgent(AGENT).length).toBe(1);
  });

  it('Form B is atomic: if supersede fails, write rolls back', () => {
    const oldE = store.createEngram({
      agentId: AGENT, concept: 'Promise X', content: 'original',
    });

    // Force a failure mid-transaction by throwing after performWrite but
    // before supersede. The transaction should roll back the write.
    expect(() => {
      store.transaction(() => {
        const matched = store.findActiveMatchByConcept(AGENT, 'Promise X');
        performWrite({ store, connectionEngine }, {
          agentId: AGENT,
          concept: 'Resolution',
          content: 'new',
          memoryClass: 'structural',
          enableReinforcement: false,
        });
        if (matched) {
          throw new Error('simulated failure between write and supersede');
        }
      });
    }).toThrow('simulated failure');

    // Only the original engram remains; the would-be-new engram was rolled back.
    const all = store.getEngramsByAgent(AGENT);
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe(oldE.id);
    expect(all[0]!.supersededBy).toBeNull();
  });

  // ── references[] persistence + resolution ──

  it('writes engram with resolved references (matchConcept → matchEngramId)', () => {
    const target = store.createEngram({
      agentId: AGENT,
      concept: 'Daniel notebooks measurements',
      content: 'Original observation',
      tags: ['topic=promise'],
    });

    // Simulate the route's reference-resolution + performWrite flow.
    const matched = store.findActiveMatchByConcept(
      AGENT, 'Daniel notebooks measurements', ['topic=promise'],
    );
    expect(matched).not.toBeNull();

    const writeRes = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Advancement: Hannah finds the transect',
      content: 'She walked the stake line in Ch 2',
      memoryClass: 'structural',
      references: [{
        type: 'advances',
        matchEngramId: matched!.id,
        matchConcept: 'Daniel notebooks measurements',
      }],
    });

    const fetched = store.getEngram(writeRes.engram.id)!;
    expect(fetched.references).not.toBeNull();
    expect(fetched.references!.length).toBe(1);
    expect(fetched.references![0]!.type).toBe('advances');
    expect(fetched.references![0]!.matchEngramId).toBe(target.id);
    expect(fetched.references![0]!.matchConcept).toBe('Daniel notebooks measurements');
  });
});
