import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';

describe('Unified write pipeline (R1/R2/R3)', () => {
  let store: EngramStore;
  let connectionEngine: ConnectionEngine;
  let tmp: string;
  const AGENT = 'test-pipeline';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-pipeline-test-'));
    store = new EngramStore(join(tmp, 'test.db'));
    const activation = new ActivationEngine(store);
    connectionEngine = new ConnectionEngine(store, activation);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('R0: novel write creates a new engram', () => {
    const result = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Backdate member 12345 ticket #18269',
      content: 'Member 12345 activation_date backdated to 2026-03-01 per dummy-check transfer.',
      eventType: 'observation',
    });

    expect(result.action).toBe('create');
    expect(result.engram).toBeTruthy();
    expect(result.salience).toBeTruthy();
    const all = store.getEngramsByAgent(AGENT);
    expect(all.length).toBe(1);
  });

  it('R1: same-concept duplicate reinforces existing engram (no new engram)', () => {
    const first = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Schema: tblMemberDetails columns',
      content: 'Discovered columns for tblMemberDetails: member_id, activation_date, expiry_date',
      eventType: 'observation',
    });
    expect(first.action).toBe('create');
    const beforeConf = first.engram.confidence;
    const beforeAccess = first.engram.accessCount;

    const second = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Schema: tblMemberDetails columns',
      content: 'Discovered columns for tblMemberDetails: member_id, activation_date, expiry_date. (rewrite)',
      eventType: 'observation',
    });

    expect(second.action).toBe('reinforce');
    expect(second.engram.id).toBe(first.engram.id);
    expect(second.engram.confidence).toBeGreaterThan(beforeConf);
    expect(second.engram.accessCount).toBeGreaterThan(beforeAccess);
    expect(second.reinforce).toBeTruthy();
    expect(second.reinforce!.newConfidence).toBeGreaterThan(second.reinforce!.previousConfidence);

    // Critical: only 1 engram exists, not 2
    expect(store.getEngramsByAgent(AGENT).length).toBe(1);
  });

  it('R3: correction-eventType supersedes existing engram with same concept', () => {
    const original = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Use sp_helptext for schema discovery',
      content: 'For schema discovery, use sp_helptext on the table name.',
      eventType: 'observation',
    });
    expect(original.action).toBe('create');

    const correction = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Use sp_helptext for schema discovery',
      content: 'CORRECTION: sp_helptext is denied. Use INFORMATION_SCHEMA.COLUMNS instead.',
      eventType: 'surprise',
      surprise: 0.9,
    });

    expect(correction.action).toBe('supersede');
    expect(correction.supersedeOf?.id).toBe(original.engram.id);
    expect(correction.engram.id).not.toBe(original.engram.id);
    expect(correction.engram.supersedes).toBe(original.engram.id);

    // Both engrams exist; old one has supersededBy set
    const all = store.getEngramsByAgent(AGENT);
    expect(all.length).toBe(2);
    const refreshed = store.getEngram(original.engram.id);
    expect(refreshed?.supersededBy).toBe(correction.engram.id);
  });

  it('R2: different concept with similar content creates new engram (no reinforce)', () => {
    performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Working queries for: triage #18247',
      content: 'These SQL queries produced useful results: SELECT TOP 1 member_id FROM tblMemberDetails WHERE ...',
      eventType: 'observation',
    });

    const second = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Working queries for: triage #18301',  // Different ticket → different concept
      content: 'These SQL queries produced useful results: SELECT TOP 1 member_id FROM tblMemberDetails WHERE ...',
      eventType: 'observation',
    });

    // Despite high content overlap (template language), concepts differ → new engram
    expect(second.action).toBe('create');
    expect(store.getEngramsByAgent(AGENT).length).toBe(2);
  });

  it('R2: reinforces the SUPERSEDER when match was already superseded', () => {
    // Build a supersession chain: wrong → corrected
    const wrong = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Schema for tblMemberDetails',
      content: 'columns are foo, bar, baz',
      eventType: 'observation',
    });
    const correction = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Schema for tblMemberDetails',
      content: 'CORRECTION: columns are member_id, activation_date, expiry_date',
      eventType: 'surprise',
    });
    expect(correction.action).toBe('supersede');

    // Now write a third time matching the (now superseded) original
    const third = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Schema for tblMemberDetails',
      content: 'columns are foo, bar, baz',  // matches the OLD wrong content
      eventType: 'observation',
    });

    // Should reinforce the SUPERSEDER (the corrected one), not the superseded
    expect(third.action).toBe('reinforce');
    expect(third.engram.id).toBe(correction.engram.id);
    expect(third.engram.id).not.toBe(wrong.engram.id);
  });

  it('AWM_WRITE_PIPELINE=off reverts to create-only', () => {
    const prev = process.env.AWM_WRITE_PIPELINE;
    process.env.AWM_WRITE_PIPELINE = 'off';
    try {
      performWrite({ store, connectionEngine }, {
        agentId: AGENT,
        concept: 'Repeat concept',
        content: 'first write',
      });
      const second = performWrite({ store, connectionEngine }, {
        agentId: AGENT,
        concept: 'Repeat concept',
        content: 'second write — should NOT reinforce when pipeline off',
      });
      expect(second.action).toBe('create');
      expect(store.getEngramsByAgent(AGENT).length).toBe(2);
    } finally {
      if (prev !== undefined) process.env.AWM_WRITE_PIPELINE = prev;
      else delete process.env.AWM_WRITE_PIPELINE;
    }
  });

  it('user_feedback auto-promotes to canonical class', () => {
    const result = performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Auth approach decision',
      content: 'Robert decided that magic link + social login is the long-term path; passwords are dev-only.',
    });
    expect(result.engram.memoryClass).toBe('canonical');
    expect(result.salience?.disposition).toBe('active');
  });
});
