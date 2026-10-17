/**
 * A declared `intent: 'decision'` reaches the salience filter (A-6, 2026-10-12).
 *
 * `intent` was assembled into an `intent=` tag by both write surfaces and read by
 * nothing. The redundant `decision_made` boolean was the only wired path, so a caller
 * following the documented tagging discipline — where `intent` is marked REQUIRED —
 * got no salience credit for stating that a write recorded a decision.
 *
 * WHY THIS ONE AND NOT THE OTHER CANDIDATE. Measured over all 496 discarded writes in
 * the live store (tagged `low-salience`, `work`+`personal`, 2026-10-12), against a
 * 38.1% base rate of being recalled later:
 *
 *   intent=decision           77.3%  (n= 22)  +41.0pp   <- this fix
 *   confidence_level=verified  40.2%  (n=306)   +5.5pp
 *   has person= tag            40.8%  (n=120)   +3.6pp
 *   content >= 500 chars       35.0%  (n=408)  -17.2pp
 *   concept >= 60 chars        29.9%  (n=364)  -30.7pp
 *
 * The originally planned fix — widening the operational-verb list that gates
 * `detectVerifiedFinding`'s 0.45 floor — was tested on the same population and
 * REJECTED: of 177 discards that failed only the verb gate while already carrying 2+
 * identifiers, every candidate token (Verified 33:97, Run 16:48, Fixed 11:27, Sent
 * 10:13 …) scored at or below the base rate, i.e. carried no signal. Caller-declared
 * intent discriminates; inferred content features did not.
 *
 * NOTE ON THE FIXTURE: each end-to-end write gets its OWN store. Two similar writes
 * into one store is not a controlled comparison — the second reinforces the first and
 * its novelty collapses, which dominates the 0.45 novelty weight and swamps the effect
 * under test. (Observed while writing these tests: a first write scored 0.450 and an
 * identical second 0.033, with intent playing no part in either.)
 *
 * Run: npx vitest run tests/core/intent-decision-salience.test.ts
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { evaluateSalience } from '../../src/core/salience.js';

const AGENT = 'test-intent-decision';
const CONTENT =
  'We will route reminder sends through the existing queue rather than adding a second worker.';

/** One write, alone in a fresh store, so novelty is identical across comparisons. */
async function writeAlone(extra: Record<string, unknown>) {
  const tmp = mkdtempSync(join(tmpdir(), 'awm-intent-test-'));
  const store = new EngramStore(join(tmp, 'test.db'));
  const connectionEngine = new ConnectionEngine(store, new ActivationEngine(store));
  try {
    return await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'reminder send routing choice',
      content: CONTENT,
      ...extra,
    } as any);
  } finally {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

describe('intent=decision feeds the salience filter', () => {
  it('scores a declared decision above the identical write without one', async () => {
    const plain = await writeAlone({});
    const declared = await writeAlone({ intent: 'decision', tags: ['intent=decision'] });
    expect(declared.salience.score).toBeGreaterThan(plain.salience.score);
  });

  it('is an OR with decision_made, so the existing boolean keeps working on its own', async () => {
    const plain = await writeAlone({});
    const viaBoolean = await writeAlone({ decisionMade: true });
    const viaIntent = await writeAlone({ intent: 'decision' });
    expect(viaBoolean.salience.score).toBeGreaterThan(plain.salience.score);
    expect(viaIntent.salience.score).toBeCloseTo(viaBoolean.salience.score, 5);
  });

  it('leaves other intents alone — only decision is wired, because only it was measured', async () => {
    const plain = await writeAlone({});
    const asFinding = await writeAlone({ intent: 'finding', tags: ['intent=finding'] });
    expect(asFinding.salience.score).toBeCloseTo(plain.salience.score, 5);
  });

  it('adds exactly the decisionMade feature weight, not a second type bonus', () => {
    // One declaration must not be counted twice (as both the decisionMade feature
    // and an eventType promotion), which would make the fix a hidden 0.30 floor.
    const base = evaluateSalience({ content: 'x', novelty: 0.5, eventType: 'observation' });
    const withDecision = evaluateSalience({
      content: 'x', novelty: 0.5, eventType: 'observation', decisionMade: true,
    });
    expect(withDecision.score - base.score).toBeCloseTo(0.15, 5);
  });

  it('lifts the actually-observed discard out of the discard band', () => {
    // The live discards this came from scored ~0.14, which is 0.45 * novelty 0.31
    // with no other feature set. +0.15 puts that write in staging instead of gone.
    const asWritten = evaluateSalience({ content: 'x', novelty: 0.31, eventType: 'observation' });
    const declared = evaluateSalience({
      content: 'x', novelty: 0.31, eventType: 'observation', decisionMade: true,
    });
    expect(asWritten.score).toBeCloseTo(0.14, 2);
    expect(asWritten.disposition).toBe('discard');
    expect(declared.disposition).not.toBe('discard');
  });

  it('does not force a declared decision all the way to active — it is a nudge, not a floor', () => {
    // Deliberate: canonical is the mechanism for "must survive". A declared decision
    // on a near-duplicate write should still be staged rather than promoted outright,
    // or the parameter becomes a way around the novelty filter entirely.
    const nearDuplicate = evaluateSalience({
      content: 'x', novelty: 0.05, eventType: 'observation', decisionMade: true,
    });
    expect(nearDuplicate.disposition).not.toBe('active');
  });
});
