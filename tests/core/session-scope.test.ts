// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Session scope (0.20): working notes a long session can get back after a
 * compaction. Before this, a session's own notes were demoted by the novelty
 * gate, recall had no idea which session asked, and one checkpoint slot per
 * agent let parallel sessions overwrite each other.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { StagingBuffer as StagingManager } from '../../src/engine/staging.js';

describe('session scope', () => {
  let store: EngramStore; let engine: ActivationEngine; let connectionEngine: ConnectionEngine; let tmp: string;
  const AGENT = 'test-session';
  const S1 = 'sess-aaaa', S2 = 'sess-bbbb';
  const MCP = { surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3, eventType: 'observation' as const };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-session-'));
    store = new EngramStore(join(tmp, 'test.db'));
    engine = new ActivationEngine(store);
    connectionEngine = new ConnectionEngine(store, engine);
  });
  afterEach(() => { store.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  const write = (concept: string, content: string, extra: Record<string, unknown> = {}) =>
    performWrite({ store, connectionEngine }, { agentId: AGENT, concept, content, ...MCP, ...extra } as any);

  it('a session note is kept active whatever its salience, as ephemeral, and never merges into a durable memory', async () => {
    const durable = await write('RosterKeep API local port', 'The RosterKeep API listens on port 4100 locally.', { memoryClass: 'canonical' });
    // Nearly the same words: as a plain write this would reinforce-merge or be discarded as redundant.
    const note = await write('RosterKeep API local port', 'The RosterKeep API listens on port 4100 locally; I restarted it at step 3.',
      { scope: 'session', memoryClass: 'ephemeral', ttl: 7 * 86_400_000, writerSession: S1, tags: ['scope=session', `sid=${S1}`] });
    expect(note.action).toBe('create');
    expect(note.engram.id).not.toBe(durable.engram.id);
    expect(note.engram.stage).toBe('active');
    expect(note.engram.memoryClass).toBe('ephemeral');
    expect(note.engram.ttl).toBe(7 * 86_400_000);
    expect(note.salience?.reasonCodes).toContain('scope:session');
    const d = await store.getEngram(durable.engram.id);
    expect(d?.content).toBe('The RosterKeep API listens on port 4100 locally.');   // untouched
  });

  it('scope "only" returns this session\'s memories and nothing else; "first" puts them ahead', async () => {
    await write('Gym membership renewal', 'Gym membership auto-renews on Nov 20 at $49 a month.', { writerSession: S2 });
    await write('API port note', 'Working note: the API is on port 4100 and the web app on 5273 this session.',
      { scope: 'session', memoryClass: 'ephemeral', ttl: 86_400_000, writerSession: S1 });
    await write('RosterKeep API local port', 'The RosterKeep API listens on port 4100 locally.', { memoryClass: 'canonical', writerSession: S2 });

    const only = await engine.activate({ agentId: AGENT, context: 'which port is the API on', limit: 5, useReranker: false, useExpansion: false, internal: true, sessionId: S1, sessionScope: 'only' });
    expect(only.length).toBe(1);
    expect(only[0].engram.writerSession).toBe(S1);

    const none = await engine.activate({ agentId: AGENT, context: 'which port is the API on', limit: 5, useReranker: false, useExpansion: false, internal: true, sessionId: 'sess-none', sessionScope: 'only' });
    expect(none).toEqual([]);

    const first = await engine.activate({ agentId: AGENT, context: 'which port is the API on', limit: 5, useReranker: false, useExpansion: false, internal: true, sessionId: S1, sessionScope: 'first' });
    expect(first.length).toBeGreaterThan(1);
    expect(first[0].engram.writerSession).toBe(S1);

    const plain = await engine.activate({ agentId: AGENT, context: 'which port is the API on', limit: 5, useReranker: false, useExpansion: false, internal: true });
    expect(plain.map(r => r.engram.id).sort()).toEqual(first.map(r => r.engram.id).sort());   // same membership
  });

  it('per-session checkpoints do not overwrite each other, and the agent slot still works', () => {
    const state = (task: string) => ({ currentTask: task, decisions: [], activeFiles: [], nextSteps: [], relatedMemoryIds: [], notes: '', episodeId: null });
    store.saveCheckpoint(AGENT, state('agent-level'));
    store.saveSessionCheckpoint(AGENT, S1, state('session one, step 3'));
    store.saveSessionCheckpoint(AGENT, S2, state('session two, end of day'));
    store.saveSessionCheckpoint(AGENT, S1, state('session one, step 4'));
    expect(store.getSessionCheckpoint(AGENT, S1)?.state.currentTask).toBe('session one, step 4');
    expect(store.getSessionCheckpoint(AGENT, S2)?.state.currentTask).toBe('session two, end of day');
    expect(store.getSessionCheckpoint(AGENT, 'sess-none')).toBeNull();
    expect(store.getCheckpoint(AGENT)?.executionState?.currentTask).toBe('agent-level');
  });

  it('an expired session note is archived by the staging sweep; a live one stays active', async () => {
    const stale = store.createEngram({ agentId: AGENT, concept: 'old note', content: 'step 1 done', salience: 0.5, confidence: 0.4, memoryClass: 'ephemeral', ttl: 1 });
    const fresh = store.createEngram({ agentId: AGENT, concept: 'new note', content: 'step 2 done', salience: 0.5, confidence: 0.4, memoryClass: 'ephemeral', ttl: 86_400_000 });
    await new Promise(r => setTimeout(r, 5));
    expect(store.getExpiredEphemeral().map(e => e.id)).toEqual([stale.id]);
    await new StagingManager(store, engine).sweep();
    expect((await store.getEngram(stale.id))?.stage).toBe('archived');
    expect((await store.getEngram(fresh.id))?.stage).toBe('active');
  });
});
