// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * `correction: true` — supersede by intent, without the old id (2026-10-19).
 *
 * The case this exists for, from the MWA evaluation probe: a flight time
 * written as "departs 10:15", then the change written as an ordinary
 * observation under a new concept. Novelty 0.10 → stored at confidence 0.25
 * → ranked below the stale value. The writer knew it was a correction; it did
 * not know the id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';

describe('memory_write correction: true', () => {
  let store: EngramStore;
  let engine: ActivationEngine;
  let connectionEngine: ConnectionEngine;
  let tmp: string;
  const AGENT = 'test-correction';
  // The MCP tool's defaults, so the test exercises what a real client sends.
  const MCP = { surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3, eventType: 'observation' as const };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-correction-'));
    store = new EngramStore(join(tmp, 'test.db'));
    engine = new ActivationEngine(store);
    connectionEngine = new ConnectionEngine(store, engine);
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const write = (concept: string, content: string, extra: Record<string, unknown> = {}) =>
    performWrite({ store, connectionEngine }, { agentId: AGENT, concept, content, ...MCP, ...extra } as any);

  it('supersedes the closest memory under a DIFFERENT concept, and the correction wins recall', async () => {
    const old = await write('Sam Denver flight departure time',
      "Sam's Denver flight UA 1432 on Nov 14 departs at 10:15 AM according to the calendar.");
    const fix = await write('Denver flight time changed',
      "Sam's Denver flight UA 1432 on Nov 14 now departs at 8:40 AM per the airline status page.",
      { correction: true });

    expect(fix.action).toBe('supersede');
    expect(fix.correctionOf?.id).toBe(old.engram.id);
    expect(fix.engram.stage).toBe('active');
    expect(fix.engram.confidence).toBeGreaterThanOrEqual(old.engram.confidence);

    const oldNow = await store.getEngram(old.engram.id);
    expect(oldNow?.supersededBy).toBe(fix.engram.id);

    const results = await engine.activate({
      agentId: AGENT, context: "what time does Sam's Denver flight leave",
      limit: 3, useReranker: false, useExpansion: false, internal: true,
    });
    expect(results[0]?.engram.id).toBe(fix.engram.id);
  });

  it('supersedes a same-concept memory without needing eventType surprise', async () => {
    const old = await write('Rose price at wholesaler', 'Bloomberg Wholesale standard rose price is $1.10 per stem.');
    const fix = await write('Rose price at wholesaler',
      'Bloomberg Wholesale standard rose price rose to $1.45 per stem on Nov 6.', { correction: true });
    expect(fix.action).toBe('supersede');
    expect(fix.correctionOf?.id).toBe(old.engram.id);
    // Not merged: the stale value is not inside the new memory.
    expect(fix.engram.content).not.toContain('reinforced');
    expect(fix.engram.content).not.toContain('$1.10');
  });

  it('follows a superseded match to its superseder', async () => {
    const v1 = await write('Standup time', 'Daily standup is at 9:15 AM.');
    const v2 = await write('Standup time', 'Daily standup moved to 9:45 AM.', { correction: true });
    const v3 = await write('Standup time', 'Daily standup moved again, to 10:00 AM.', { correction: true });
    expect(v2.correctionOf?.id).toBe(v1.engram.id);
    // v3's closest match may be v1 or v2; either way the one it supersedes must be the live one, v2.
    expect(v3.correctionOf?.id).toBe(v2.engram.id);
    expect((await store.getEngram(v2.engram.id))?.supersededBy).toBe(v3.engram.id);
  });

  it('stores as new and reports null when nothing is close enough', async () => {
    await write('Gym membership renewal', 'Gym membership auto-renews on Nov 20 at $49/month.');
    const r = await write('Lake house wifi', 'The lake house wifi password is on the fridge.', { correction: true });
    expect(r.correctionOf).toBeNull();
    expect(r.action).toBe('create');
    expect(r.supersedeOf).toBeUndefined();
  });

  it('an explicit supersedes outranks the correction flag', async () => {
    const a = await write('Hotel invoice', 'Grand Hotel invoice #4471 for $2,400 is unpaid.');
    const b = await write('Accountant deadline', 'Accountant needs Q3 receipts by Nov 13.');
    const r = await write('Hotel invoice status', 'Grand Hotel invoice #4471 for $2,400 was paid on Nov 2.',
      { correction: true, supersedes: b.engram.id });
    expect(r.supersedeOf?.id).toBe(b.engram.id);
    expect(r.correctionOf).toBeUndefined();
    expect((await store.getEngram(a.engram.id))?.supersededBy).toBeNull();
  });

  it('never supersedes another agent\'s memory', async () => {
    await performWrite({ store, connectionEngine }, {
      agentId: 'someone-else', concept: 'Standup time', content: 'Daily standup is at 9:15 AM.', ...MCP,
    } as any);
    const r = await write('Standup time', 'Daily standup moved to 9:45 AM.', { correction: true });
    expect(r.correctionOf).toBeNull();
  });
});
