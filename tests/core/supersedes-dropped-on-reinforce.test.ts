import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite, HEALTHY_CONFIDENCE_FLOOR } from '../../src/core/write-pipeline.js';

/**
 * `supersedes` was silently dropped whenever reinforce-on-duplicate fired (task
 * 939b6894, found 2026-10-11 while recording supersession chains for
 * docs/eval-gap-2026-10-11.md).
 *
 * Mechanism: `input.supersedes` was read in exactly ONE place — the fallthrough
 * createNewEngram call. Every branch above it ignored the argument, and a correction
 * reaches those branches by construction: it restates the fact it is correcting, so it
 * matches on concept and routes to R1 (reinforce the healthy match), R2 (reinforce the
 * superseder), R1b (revive an archived match) or R3 (supersede `matched.id`, which is
 * not necessarily the id the caller named). The write succeeded, reported
 * action='reinforce', and the engram the caller asked to retire stayed live and
 * recallable. That is the failure mode global instruction #2 exists to prevent: a wrong
 * fact left durable and findable, with the correction folded into it.
 *
 * The second half of the fix matters as much as the first. A correction of a
 * near-duplicate has LOW NOVELTY by construction, so on its own salience it lands at
 * `discard` (confidence 0.25, tagged `low-salience`, below HEALTHY_CONFIDENCE_FLOOR=0.3)
 * or at `staging` — while the supersession side-effect in createNewEngram fires
 * regardless of disposition. Simply routing the write to the fallthrough would retire
 * the old engram into a replacement too weak to stand in for it, dropping the fact out
 * of recall entirely. Worse than the bug. So an explicit `supersedes` now forces
 * `active`, exactly as R3 already does for eventType=surprise/friction corrections.
 */
describe('supersedes is honored when reinforce-on-duplicate would otherwise fire (939b6894)', () => {
  let store: EngramStore;
  let connectionEngine: ConnectionEngine;
  let tmp: string;
  const AGENT = 'test-supersedes-reinforce';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-supersedes-reinforce-test-'));
    store = new EngramStore(join(tmp, 'test.db'));
    const activation = new ActivationEngine(store);
    connectionEngine = new ConnectionEngine(store, activation);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const CONCEPT = 'archived engrams are excluded from recall by a stage filter';

  async function writeOriginal() {
    const first = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: CONCEPT,
      content: 'sqlite.ts:1107 filters stage=active, so an archived engram can never be '
        + 'returned by any retrieval channel. Confirmed by reading the query.',
      eventType: 'observation',
      causalDepth: 0.3,
      resolutionEffort: 0.3,
    });
    expect(first.action).toBe('create');
    return first;
  }

  it('an explicit supersedes retires the named engram instead of reinforcing it', async () => {
    const first = await writeOriginal();

    // The correction. Same concept — which is what routed this to R1 before the fix —
    // and the content restates the subject, so novelty is low by construction.
    const correction = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: CONCEPT,
      content: 'WRONG. searchBM25WithRankMultiAgent (sqlite.ts:683-710) filters only '
        + 'retracted=0 — there is no stage predicate. sqlite.ts:1107 is duplicate '
        + 'detection, not retrieval. Archived engrams are lost in first-stage candidate '
        + 'generation instead.',
      eventType: 'observation',
      causalDepth: 0.3,
      resolutionEffort: 0.3,
      supersedes: first.engram.id,
    });

    expect(correction.action).toBe('supersede');
    expect(correction.engram.id).not.toBe(first.engram.id);
    expect(correction.supersedeOf).toEqual({ id: first.engram.id });

    const retired = await store.getEngram(first.engram.id);
    expect(retired?.supersededBy).toBe(correction.engram.id);
  });

  it('the replacement lands active and healthy, so the fact does not leave recall', async () => {
    const first = await writeOriginal();

    // Deliberately weak signals: this is the shape that lands at `discard` on its own
    // salience. The supersession side-effect fires regardless of disposition, so without
    // the override the old engram is retired into a confidence-0.25 `low-salience`
    // replacement that R1's health check can never reinforce again.
    const correction = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: CONCEPT,
      content: 'WRONG. BM25 filters only retracted=0; there is no stage predicate.',
      eventType: 'observation',
      causalDepth: 0,
      resolutionEffort: 0,
      supersedes: first.engram.id,
    });

    expect(correction.action).toBe('supersede');

    const stored = await store.getEngram(correction.engram.id);
    expect(stored?.stage).toBe('active');
    expect(stored!.confidence).toBeGreaterThanOrEqual(HEALTHY_CONFIDENCE_FLOOR);
    expect(stored?.tags ?? []).not.toContain('low-salience');

    // The proof that "healthy" means what it has to mean: a later same-concept write
    // reinforces the REPLACEMENT. This is the R2 superseder chain, and it only runs when
    // the superseder is active with confidence >= HEALTHY_CONFIDENCE_FLOOR. Before the
    // override it would have found an unhealthy superseder and forked a third lineage.
    const later = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: CONCEPT,
      content: 'Re-confirmed: only retracted=0 is filtered in the BM25 channel.',
      eventType: 'observation',
      causalDepth: 0.3,
      resolutionEffort: 0.3,
    });
    expect(later.action).toBe('reinforce');
    expect(later.engram.id).toBe(correction.engram.id);
  });

  it('supersedes names the engram to retire, even when the concept matches a different one', async () => {
    // The old R3 branch superseded `matched.id` — whatever duplicate detection happened
    // to find — rather than the id the caller named. Those are not always the same engram.
    const target = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'fade retains 76% of answerability',
      content: 'Measured on the paired deep-query assay: 37/38 full body vs 9/38 faded.',
      eventType: 'observation',
      causalDepth: 0.3,
      resolutionEffort: 0.3,
    });
    const bystander = await writeOriginal();

    // Concept matches the bystander; supersedes names the other engram entirely.
    const correction = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: CONCEPT,
      content: 'Unrelated correction body, routed here by concept match on the bystander.',
      eventType: 'surprise', // would have hit R3 and superseded the bystander
      causalDepth: 0.3,
      resolutionEffort: 0.3,
      supersedes: target.engram.id,
    });

    expect(correction.supersedeOf).toEqual({ id: target.engram.id });
    expect((await store.getEngram(target.engram.id))?.supersededBy).toBe(correction.engram.id);
    // The bystander is untouched: nothing asked for it to be retired.
    expect((await store.getEngram(bystander.engram.id))?.supersededBy).toBeNull();
  });

  it('reinforce-on-duplicate still fires when no supersedes is passed', async () => {
    const first = await writeOriginal();
    const repeat = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: CONCEPT,
      content: 'Same claim restated with no correction intent and no supersedes argument.',
      eventType: 'observation',
      causalDepth: 0.3,
      resolutionEffort: 0.3,
    });
    expect(repeat.action).toBe('reinforce');
    expect(repeat.engram.id).toBe(first.engram.id);
    expect((await store.getEngram(first.engram.id))?.supersededBy).toBeNull();
  });
});
