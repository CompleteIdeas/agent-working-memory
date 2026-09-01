/**
 * Abstention must be distinguishable from absence.
 *
 * WHY THIS EXISTS
 * ---------------
 * `activate()` returned a bare `[]` when the confidence gate fired, and the MCP layer
 * rendered that as "No relevant memories found." — a claim of absence the system cannot
 * make when it withheld matches it had.
 *
 * Observed in real use: a caller passed `require_confidence: 0.25`, saw the empty result,
 * and concluded the memories were missing. They existed and scored 0.268 and 0.295 — well
 * above the 0.05 `min_score` governing individual relevance. Nothing in the output could
 * have corrected that reading.
 *
 * The confusion is structural. `min_score` and `require_confidence` are both thresholds,
 * both default to 0.05, and both sit in the same numeric range, but one is per-result
 * relevance and the other is the shape of the whole score distribution. A result that
 * passes the first can be withheld by the second.
 *
 * The contract under test:
 *   - a gate that withholds results REPORTS it, with counts and the top score
 *   - a genuinely empty store does NOT report abstention
 *   - the report distinguishes the two thresholds, because conflating them is the bug
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import type { AbstentionInfo } from '../../src/types/engram.js';

let dir: string;
let store: EngramStore;
let engine: ActivationEngine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awm-abstain-'));
  store = new EngramStore(join(dir, 'test.db'));
  engine = new ActivationEngine(store);
});
afterEach(() => {
  try { store.close?.(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('abstention reporting', () => {
  it('does NOT report abstention when the store is genuinely empty', async () => {
    let info: AbstentionInfo | undefined;
    const out = await engine.activate({
      agentId: 'work',
      context: 'nothing has ever been written about this',
      requireConfidence: 0.4,
      onAbstain: (i) => { info = i; },
      internal: true,
    } as any);

    expect(out).toHaveLength(0);
    // An empty store is absence, not abstention. Reporting it as abstention would
    // make the signal meaningless — the whole point is that the two differ.
    expect(info).toBeUndefined();
  });

  it('reports abstention, with counts, when a gate withholds real matches', async () => {
    for (let i = 0; i < 6; i++) {
      await store.createEngram({
        agentId: 'work',
        concept: `deployment note ${i}`,
        content: `Notes about deployment topic ${i} — pipeline, staging, rollout cadence.`,
        memoryClass: 'canonical',
      } as any);
    }

    let info: AbstentionInfo | undefined;
    // A threshold high enough that the distribution shape cannot clear it.
    const out = await engine.activate({
      agentId: 'work',
      context: 'deployment pipeline staging rollout',
      requireConfidence: 0.99,
      onAbstain: (i) => { info = i; },
      internal: true,
    } as any);

    expect(out).toHaveLength(0);
    expect(info).toBeDefined();
    expect(info!.reason).toBe('confidence');
    expect(info!.threshold).toBe(0.99);
    // The key assertion: candidates existed. "Empty result" did not mean "nothing there".
    expect(info!.candidates).toBeGreaterThan(0);
    expect(info!.topScore).toBeGreaterThan(0);
  });

  it('the withheld top score can exceed minScore — which is why [] was misread', async () => {
    for (let i = 0; i < 6; i++) {
      await store.createEngram({
        agentId: 'work',
        concept: `ticket 193${i} signing rule`,
        content: `Sign in with login_name rather than email address. Ticket 193${i}.`,
        memoryClass: 'canonical',
      } as any);
    }

    let info: AbstentionInfo | undefined;
    await engine.activate({
      agentId: 'work',
      context: 'login_name signing rule ticket',
      minScore: 0.05,
      requireConfidence: 0.99,
      onAbstain: (i) => { info = i; },
      internal: true,
    } as any);

    expect(info).toBeDefined();
    // This is the exact shape of the real incident: results good enough to pass
    // minScore, withheld by the aggregate gate, reported as if absent.
    expect(info!.topScore).toBeGreaterThan(0.05);
  });

  it('no callback wired = old behaviour, still just an empty array', async () => {
    await store.createEngram({
      agentId: 'work',
      concept: 'a memory',
      content: 'some content about pipelines',
      memoryClass: 'canonical',
    } as any);

    // Callers that do not opt in are unaffected — this is additive.
    const out = await engine.activate({
      agentId: 'work',
      context: 'pipelines',
      requireConfidence: 0.99,
      internal: true,
    } as any);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(0);
  });
});
