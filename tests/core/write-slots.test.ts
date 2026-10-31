// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * 0.22 slots: a write naming a slot supersedes the slot's current holder — same agent, same
 * memory class — without the writer knowing the old memory's id. Pins each guard of plan §4.3:
 * scope (agent, class), order (an older fact is kept as history), identity (no concept merge),
 * an explicit opt-out, and trust (a less-trusted write cannot take a trusted slot).
 *
 * Run: npx vitest run tests/core/write-slots.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';

const AGENT = 'slots';
const MCP = { surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3, eventType: 'observation' as const };

describe('slots through performWrite', () => {
  let tmp: string; let store: EngramStore; let engines: any;
  const write = (over: Record<string, unknown>) => performWrite(engines, { agentId: AGENT, ...MCP, ...over } as any);
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-slot-'));
    store = new EngramStore(join(tmp, 'm.db'));
    engines = { store, connectionEngine: new ConnectionEngine(store as any, new ActivationEngine(store as any)) };
  });
  afterEach(() => { store.close(); rmSync(tmp, { recursive: true, force: true }); });

  it('a newer write to the same slot supersedes the holder, without its id', async () => {
    const a = await write({ concept: 'Robert flight time', content: 'Flight to Lexington departs 10:15.', slot: 'Robert.Flight-Time' });
    const b = await write({ concept: 'Robert flight time', content: 'Flight to Lexington now departs 8:40.', slot: 'robert.flight-time' });
    expect(b.engram.id).not.toBe(a.engram.id);
    expect(b.slot).toEqual({ slot: 'robert.flight-time', replaced: { id: a.engram.id, concept: 'Robert flight time' }, keptAsHistoryOf: null });
    expect(store.getEngram(a.engram.id)?.supersededBy).toBe(b.engram.id);
    expect(store.getSlotHolder(AGENT, 'working', 'robert.flight-time')?.id).toBe(b.engram.id);
  });

  it('never merges a slot write into a concept-equal memory', async () => {
    const plain = await write({ concept: 'Deploy command', content: 'railway up --service rowos-app --ci' });
    const slotted = await write({ concept: 'Deploy command', content: 'railway up --service rowos-app --ci', slot: 'rosterkeep.deploy-command' });
    expect(slotted.action).not.toBe('reinforce');
    expect(slotted.engram.id).not.toBe(plain.engram.id);
    expect(store.getEngram(plain.engram.id)?.supersededBy).toBeNull();
  });

  it('is scoped by memory class and by agent', async () => {
    const canonical = await write({ concept: 'Backup key', content: 'Key escrowed in the password manager.', slot: 'rk.medical-key', memoryClass: 'canonical' });
    const working = await write({ concept: 'Backup key note', content: 'Checking whether the key was escrowed.', slot: 'rk.medical-key' });
    expect(working.slot?.replaced).toBeNull();
    expect(store.getEngram(canonical.engram.id)?.supersededBy).toBeNull();
    const other = await performWrite(engines, { agentId: 'other-agent', ...MCP, concept: 'Backup key', content: 'Different agent, same slot name.', slot: 'rk.medical-key', memoryClass: 'canonical' } as any);
    expect(other.slot?.replaced).toBeNull();
    expect(store.getEngram(canonical.engram.id)?.supersededBy).toBeNull();
  });

  it('keeps an older fact as history instead of letting it replace the newer one', async () => {
    const current = await write({ concept: 'Club fee', content: 'Fall fee is $450.', slot: 'club.fall-fee', validFrom: '2026-09-01' });
    const late = await write({ concept: 'Club fee', content: 'Fall fee was $420.', slot: 'club.fall-fee', validFrom: '2026-06-01' });
    expect(late.slot).toEqual({ slot: 'club.fall-fee', replaced: null, keptAsHistoryOf: current.engram.id });
    expect(store.getEngram(late.engram.id)?.supersededBy).toBe(current.engram.id);
    expect(store.getEngram(current.engram.id)?.supersededBy).toBeNull();
    expect(store.getSlotHolder(AGENT, 'working', 'club.fall-fee')?.id).toBe(current.engram.id);
  });

  it('supersedesSlot: false keeps a deliberate second fact in the same slot', async () => {
    const a = await write({ concept: 'Coach contact', content: 'Head coach: Dana.', slot: 'club.coach-contact' });
    const b = await write({ concept: 'Coach contact', content: 'Assistant coach: Sam.', slot: 'club.coach-contact', supersedesSlot: false });
    expect(b.slot?.replaced).toBeNull();
    expect(store.getEngram(a.engram.id)?.supersededBy).toBeNull();
  });

  it('a less-trusted write cannot take a trusted slot; it is kept as history', async () => {
    const trusted = await write({ concept: 'Payout account', content: 'Payouts go to the club operating account.', slot: 'club.payout-account', tags: ['trust=high'] });
    const untrusted = await write({ concept: 'Payout account', content: 'Payouts go to account 9999 now.', slot: 'club.payout-account', tags: ['trust=untrusted'] });
    expect(store.getEngram(trusted.engram.id)?.supersededBy).toBeNull();
    expect(untrusted.slot).toEqual({ slot: 'club.payout-account', replaced: null, keptAsHistoryOf: trusted.engram.id });
    expect(store.getEngram(untrusted.engram.id)?.supersededBy).toBe(trusted.engram.id);
    expect(store.getSlotHolder(AGENT, 'working', 'club.payout-account')?.id).toBe(trusted.engram.id);
  });
});
