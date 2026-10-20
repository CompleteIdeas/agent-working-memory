// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Implicit feedback (0.20): the learning loop fed by what the agent does.
 * Live store before this: 12 retrieval_feedback rows against 23,653 recalls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distinctiveTokens, matchUses, type RecallRecord } from '../../src/core/implicit-feedback.js';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const NOW = 1_800_000_000_000;
const rec = (eventId: string, engrams: RecallRecord['engrams'], ageMs = 0): RecallRecord =>
  ({ eventId, at: NOW - ageMs, agentId: 'a', engrams });

const flight = { id: 'e1a2b3c4-0000-4000-8000-000000000001', concept: 'Sam Denver flight departure time',
  content: "Sam's Denver flight UA 1432 on Nov 14 departs at 8:40 AM per the airline status page.", tags: ['person=Sam'] };
const port = { id: 'f9f9f9f9-0000-4000-8000-000000000002', concept: 'RosterKeep API local port',
  content: 'The RosterKeep API listens on port 4100 locally; the web app is on 5273.', tags: ['proj=RosterKeep', 'file=apps/api/src/index.ts'] };
const generic = { id: 'a0a0a0a0-0000-4000-8000-000000000003', concept: 'Update the config',
  content: 'Change the setting and restart the service.', tags: [] };

describe('distinctiveTokens', () => {
  it('keeps identifiers, paths, tag values and proper nouns; drops common words', () => {
    const t = distinctiveTokens(flight);
    expect(t.has('1432')).toBe(true);
    expect(t.has('sam')).toBe(true);
    expect(t.has('denver')).toBe(true);
    expect(t.has('flight')).toBe(false);          // 6 letters, lower-case in content: not a concept proper noun
    const p = distinctiveTokens(port);
    expect(p.has('4100')).toBe(true);
    expect(p.has('apps/api/src/index.ts')).toBe(true);
    expect(p.has('rosterkeep')).toBe(true);
    expect(distinctiveTokens(generic).size).toBe(0); // nothing identifies it
  });
});

describe('matchUses', () => {
  it('credits a memory whose id appears in the text', () => {
    const uses = matchUses([rec('ev1', [flight])], `Superseding ${flight.id.slice(0, 8)} with the new time.`, { now: NOW });
    expect(uses).toEqual([{ eventId: 'ev1', engramId: flight.id, evidence: ['id'] }]);
  });

  it('credits a memory when two distinctive tokens appear, not one', () => {
    const one = matchUses([rec('ev1', [flight, port])], 'I checked the Denver weather.', { now: NOW });
    expect(one).toEqual([]);
    const two = matchUses([rec('ev1', [flight, port])], "Sam's Denver flight is UA 1432, confirmed.", { now: NOW });
    expect(two.map(u => u.engramId)).toEqual([flight.id]);
  });

  it('never credits a memory with no distinctive tokens from common words', () => {
    expect(matchUses([rec('ev1', [generic])], 'Update the config: change the setting and restart the service.', { now: NOW })).toEqual([]);
  });

  it('credits each (recall, memory) pair once', () => {
    const credited = new Set<string>();
    const text = 'port 4100 on apps/api/src/index.ts';
    expect(matchUses([rec('ev1', [port])], text, { now: NOW, credited }).length).toBe(1);
    expect(matchUses([rec('ev1', [port])], text, { now: NOW, credited }).length).toBe(0);
    expect(matchUses([rec('ev2', [port])], text, { now: NOW, credited }).length).toBe(1);
  });

  it('ignores recalls older than the window', () => {
    expect(matchUses([rec('old', [port], 16 * 60_000)], 'port 4100 on apps/api/src/index.ts', { now: NOW })).toEqual([]);
  });
});

describe('ActivationEngine.noteImplicitUse', () => {
  let store: EngramStore; let engine: ActivationEngine; let tmp: string;
  const AGENT = 'test-implicit';
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-implicit-'));
    store = new EngramStore(join(tmp, 'test.db'));
    engine = new ActivationEngine(store);
  });
  afterEach(() => { store.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('a recall followed by a write that names what it returned leaves a joined feedback row and a confidence bump', async () => {
    const e = store.createEngram({ agentId: AGENT, concept: 'RosterKeep API local port',
      content: 'The RosterKeep API listens on port 4100 locally.', salience: 0.7, confidence: 0.5, tags: ['proj=RosterKeep'] });
    store.createEngram({ agentId: AGENT, concept: 'Gym membership renewal',
      content: 'Gym membership auto-renews on Nov 20 at $49 a month.', salience: 0.7, confidence: 0.5 });
    const results = await engine.activate({ agentId: AGENT, context: 'which port does the RosterKeep API use', limit: 3, useReranker: false, useExpansion: false });
    expect(results.some(r => r.engram.id === e.id)).toBe(true);
    expect(engine.recentRecallRecords().length).toBe(1);

    const credited = await engine.noteImplicitUse('Started the API on port 4100 for RosterKeep and ran the suite.', 'write');
    expect(credited).toBe(1);
    const stats = store.getLinkedFeedbackStats(AGENT, 1);
    expect(stats.total).toBe(1);
    expect(stats.useful).toBe(1);
    const after = await store.getEngram(e.id);
    expect(after!.confidence).toBeGreaterThan(0.5);

    // Same text again: already credited, nothing more happens.
    expect(await engine.noteImplicitUse('port 4100 RosterKeep', 'write')).toBe(0);
  });
});
