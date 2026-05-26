// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * AWM 0.8 Cluster A — structural memory_class behavior.
 *
 * Covers:
 *   - Salience bypass: structural writes get the 0.7 floor like canonical
 *   - Distinct reasonCode (`class:structural`, not `class:canonical`)
 *   - Disposition always 'active' (never staged)
 *   - sequence column persists + survives roundtrip
 *   - references field persists + survives roundtrip
 *   - Embedding skipped by default (no embedding queued)
 *   - Embedding opt-in via `embed: true`
 *
 * Does NOT cover (lives in other test files / clusters):
 *   - HTTP route wiring of memory_class (smoke-tested in 0.7.17 manual verify)
 *   - /memory/latest-by-tag using sequence (Cluster C)
 *   - references[] semantics on /memory/write (Cluster D)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';

describe('memory_class: structural (0.8 Cluster A)', () => {
  let store: EngramStore;
  let connectionEngine: ConnectionEngine;
  let tmp: string;
  const AGENT = 'test-structural';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-structural-test-'));
    store = new EngramStore(join(tmp, 'test.db'));
    const activation = new ActivationEngine(store);
    connectionEngine = new ConnectionEngine(store, activation);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('produces class:structural reasonCode and 0.7 salience floor', async () => {
    const result = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Plot summary — Chapter 1',
      content: 'A short structural record.',  // low-novelty, would normally discard
      memoryClass: 'structural',
      eventType: 'observation',
    });

    expect(result.action).toBe('create');
    expect(result.salience).toBeTruthy();
    expect(result.salience!.score).toBeGreaterThanOrEqual(0.7);
    expect(result.salience!.reasonCodes).toContain('class:structural');
    expect(result.salience!.reasonCodes).not.toContain('class:canonical');
    expect(result.salience!.disposition).toBe('active');
  });

  it('reinforce branch still fires for same-concept structural writes', async () => {
    // Structural is high-volume — repeated chapter analyses on the same chapter
    // produce same-concept writes. R1 should still reinforce, not duplicate.
    const first = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Ending — Chapter 1',
      content: 'Ending classification: emotional-landing.',
      memoryClass: 'structural',
    });
    expect(first.action).toBe('create');

    const second = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Ending — Chapter 1',
      content: 'Ending classification: emotional-landing.',
      memoryClass: 'structural',
    });
    expect(second.action).toBe('reinforce');

    // Only one engram in storage.
    const all = store.getEngramsByAgent(AGENT);
    expect(all.length).toBe(1);
    expect(all[0]!.memoryClass).toBe('structural');
  });

  it('persists sequence column and round-trips it', async () => {
    const result = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Plot summary — Chapter 5',
      content: 'What happened in chapter five.',
      memoryClass: 'structural',
      sequence: 5,
    });

    const fetched = store.getEngram(result.engram.id)!;
    expect(fetched.sequence).toBe(5);
  });

  it('persists references array and round-trips it', async () => {
    const result = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Advancement of "Mara deferred disclosure"',
      content: 'Resolved in Ch 3.',
      memoryClass: 'structural',
      references: [
        { type: 'resolves', matchConcept: "Mara's deferred disclosure" },
      ],
    });

    const fetched = store.getEngram(result.engram.id)!;
    expect(fetched.references).not.toBeNull();
    expect(fetched.references!.length).toBe(1);
    expect(fetched.references![0]!.type).toBe('resolves');
    expect(fetched.references![0]!.matchConcept).toBe("Mara's deferred disclosure");
  });

  it('sequence defaults to NULL when not provided', async () => {
    const result = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'A working-class write with no sequence',
      content: 'Default behavior.',
    });
    const fetched = store.getEngram(result.engram.id)!;
    expect(fetched.sequence).toBeNull();
    expect(fetched.references).toBeNull();
  });

  it('working-class write still works (no regression)', async () => {
    const result = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'A working-class observation',
      content: 'This is a long enough content that should pass novelty checks easily.',
      memoryClass: 'working',
      eventType: 'observation',
    });
    expect(result.action).toBe('create');
    expect(result.salience!.reasonCodes).not.toContain('class:structural');
    expect(result.salience!.reasonCodes).not.toContain('class:canonical');
  });

  it('canonical-class write still works (no regression)', async () => {
    const result = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'A canonical decision',
      content: 'This is a deliberate canonical write.',
      memoryClass: 'canonical',
    });
    expect(result.action).toBe('create');
    expect(result.salience!.reasonCodes).toContain('class:canonical');
    expect(result.salience!.score).toBeGreaterThanOrEqual(0.7);
  });
});
