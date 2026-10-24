/**
 * Explicit `supersedes` inherits the confidence of what it replaces (2026-10-24).
 *
 * `correction: true` already floors the replacement at the target's confidence
 * ("the replacement must not stand weaker than what it replaces"). The explicit
 * `supersedes: <id>` path — the same intent, with the id in hand — did not: the new
 * engram took the write-kind prior, so a merge written as an observation (0.45)
 * replaced a decision-kind memory (0.65) and ranked below where the stale one had
 * been. In the MWA experience pilot that put every merged memory under the 0.6
 * line Phase 6.5 redundancy pruning treats as disposable.
 *
 * Run: npx vitest run tests/core/supersede-confidence-floor.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';

describe('memory_write supersedes: confidence floor', () => {
  let store: EngramStore;
  let connectionEngine: ConnectionEngine;
  let tmp: string;
  const AGENT = 'test-supersede-floor';
  const MCP = { surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3 };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-supfloor-'));
    store = new EngramStore(join(tmp, 'test.db'));
    connectionEngine = new ConnectionEngine(store, new ActivationEngine(store));
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const write = (concept: string, content: string, extra: Record<string, unknown> = {}) =>
    performWrite({ store, connectionEngine }, { agentId: AGENT, concept, content, ...MCP, ...extra } as any);

  it('an observation-kind supersede of a decision-kind memory keeps the decision confidence', async () => {
    const old = await write('Clef watch-gate threshold decision',
      'Decision 2026-10-20: the Clef watch gate ships at threshold 0.65 with 42/43 wanted messages passing.',
      { eventType: 'decision', intent: 'decision' });
    expect(old.engram.confidence).toBeGreaterThanOrEqual(0.6); // decision prior

    const merged = await write('Clef watch-gate threshold, merged record',
      'Clef watch gate: threshold 0.65, calibration 42/43 wanted passing and 34/43 on the second set; 0/86 unwanted passed.',
      { eventType: 'observation', intent: 'finding', supersedes: old.engram.id });

    expect(merged.action).toBe('supersede');
    expect(merged.engram.confidence).toBeGreaterThanOrEqual(old.engram.confidence);
    expect((await store.getEngram(old.engram.id))?.supersededBy).toBe(merged.engram.id);
  });

  it('a caller-supplied higher confidence still wins', async () => {
    const old = await write('deploy gate', 'The deploy gate is bash scripts/verify.sh.', { eventType: 'observation' });
    const fix = await write('deploy gate (updated)', 'The deploy gate is now pnpm verify, run from the repo root.',
      { eventType: 'observation', supersedes: old.engram.id, confidence: 0.9 });
    expect(fix.engram.confidence).toBeCloseTo(0.9, 5);
  });

  it('a stale low-confidence target does not drag the replacement down', async () => {
    const old = await write('port note', 'The dev server listens on port 4100.', { eventType: 'observation' });
    const fix = await write('port note', 'The dev server listens on port 4200 since the 2026-10 change.',
      { eventType: 'decision', supersedes: old.engram.id });
    // decision prior (0.65) is above the observation target (0.45); max() keeps the prior
    expect(fix.engram.confidence).toBeGreaterThanOrEqual(0.6);
  });
});
