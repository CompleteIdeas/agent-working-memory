// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Write-time redaction end to end (S1): a credential written through any path must not be
 * on disk afterwards — not in the engram row, the full-text index, the recall-query log, a
 * checkpoint, or awm.log. Each test reads the raw SQLite file back rather than trusting the
 * value a function returned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { withRedaction, REDACTED_METHODS } from '../../src/storage/redacting-store.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { initLogger, log } from '../../src/core/logger.js';
import type { IEngramStore } from '../../src/storage/store.js';

// Assembled at run time so this file does not itself trip secret scanners.
const STRIPE = ['sk', '_live_', '51Hx9Tq2LmN8vB4kP7rS0dWz'].join('');
const DB_PASSWORD = ['Tq8vX2', 'mL9pRs'].join('');

describe('redaction at the storage boundary', () => {
  let raw: EngramStore; let store: IEngramStore; let tmp: string; let dbPath: string;
  const AGENT = 'test-redact';
  const MCP = { surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3, eventType: 'observation' as const };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-redact-'));
    dbPath = join(tmp, 'test.db');
    raw = new EngramStore(dbPath);
    store = withRedaction(raw as unknown as IEngramStore);
  });
  afterEach(() => { raw.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  /** Every byte SQLite wrote, including the WAL, as text. */
  const onDisk = (): string => {
    raw.walCheckpoint?.();
    return ['', '-wal'].map((s) => (existsSync(dbPath + s) ? readFileSync(dbPath + s).toString('latin1') : '')).join('');
  };

  it('performWrite masks the secret in content, concept and tags, and reports it', async () => {
    const connectionEngine = new ConnectionEngine(store as any, new ActivationEngine(store as any));
    const res = await performWrite({ store, connectionEngine } as any, {
      agentId: AGENT,
      concept: `Stripe payout key ${STRIPE}`,
      content: `Use ${STRIPE} for payouts; DB is postgresql://app:${DB_PASSWORD}@db.example.net:5432/main`,
      tags: ['topic=stripe', `key=${STRIPE}`],
      ...MCP,
    } as any);

    expect(res.engram.content).not.toContain(STRIPE);
    expect(res.engram.content).not.toContain(DB_PASSWORD);
    expect(res.engram.concept).toContain('[REDACTED:stripe_key');
    expect(res.engram.tags.join(' ')).not.toContain(STRIPE);
    expect(res.redaction?.map((f) => f.type).sort()).toEqual(['stripe_key', 'stripe_key', 'stripe_key', 'url_password']);

    const disk = onDisk();
    expect(disk).not.toContain(STRIPE);
    expect(disk).not.toContain(DB_PASSWORD);
    expect(disk).toContain('[REDACTED:stripe_key');
  });

  it('a direct createEngram that bypasses the pipeline is still masked (batch writes, tasks)', async () => {
    const e = await store.createEngram({ agentId: AGENT, concept: 'task: rotate key', content: `old key ${STRIPE}`, tags: [] });
    expect(e.content).toBe('old key [REDACTED:stripe_key …0dWz]');
    expect(onDisk()).not.toContain(STRIPE);
  });

  it('updateContent and updateTags are masked (reinforce merges, consolidation trims)', async () => {
    const e = await store.createEngram({ agentId: AGENT, concept: 'c', content: 'clean', tags: [] });
    await store.updateContent(e.id, `merged: password=${DB_PASSWORD}`);
    await store.updateTags(e.id, [`token=${DB_PASSWORD}`]);
    expect(onDisk()).not.toContain(DB_PASSWORD);
  });

  it('a recall query containing a secret is not kept in the activation log or the auto-checkpoint', async () => {
    await store.logActivationEvent({
      id: 'act-1', agentId: AGENT, timestamp: new Date(), context: `what is ${STRIPE} used for`,
      resultsReturned: 0, topScore: 0, latencyMs: 1, engramIds: [],
    });
    await store.updateAutoCheckpointRecall(AGENT, `find ${STRIPE}`, []);
    expect(onDisk()).not.toContain(STRIPE);
  });

  it('checkpoints are masked, per agent and per session', async () => {
    const state = {
      currentTask: `rotate ${STRIPE}`, decisions: [`password=${DB_PASSWORD}`], activeFiles: [],
      nextSteps: [`revoke ${STRIPE}`], relatedMemoryIds: [], notes: `db pw ${DB_PASSWORD} in vault?`, episodeId: null,
    };
    await store.saveCheckpoint(AGENT, state);
    await store.saveSessionCheckpoint(AGENT, 'sess-1', state);
    const disk = onDisk();
    expect(disk).not.toContain(STRIPE);
    expect(disk).not.toContain('password=' + DB_PASSWORD);
  });

  it('wraps every text-persisting method the store has', () => {
    // If a new mutator that takes free text is added to the SQLite store, it must be
    // added to the wrapper too. This lists the ones known to persist text.
    expect(REDACTED_METHODS.sort()).toEqual([
      'createEngram', 'createEpisode', 'logActivationEvent', 'logRetrievalFeedback', 'saveCheckpoint',
      'saveSessionCheckpoint', 'setQuestions', 'updateAutoCheckpointRecall', 'updateContent', 'updateTags',
    ]);
  });

  it('awm.log lines are masked', () => {
    initLogger(dbPath);
    log(AGENT, 'write:active', `"Stripe ${STRIPE}" salience=0.7`);
    const logText = readFileSync(join(tmp, 'awm.log'), 'utf8');
    expect(logText).not.toContain(STRIPE);
    expect(logText).toContain('[REDACTED:stripe_key');
  });
});
