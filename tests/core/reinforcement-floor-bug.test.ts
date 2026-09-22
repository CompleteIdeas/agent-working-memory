import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite, HEALTHY_CONFIDENCE_FLOOR } from '../../src/core/write-pipeline.js';

/**
 * Reproduces the "family of stubs" bug found 2026-09-22 while diagnosing why
 * memory_recall for the /freshdesk-support hourly sweep anchor kept returning
 * 2-week-stale memories instead of the true latest one.
 *
 * Initial hypothesis (confidence=0.25 for discard-disposition writes vs
 * HEALTHY_CONFIDENCE_FLOOR=0.3) did NOT reproduce under realistic signal
 * strength (causalDepth/resolutionEffort=0.3, the memory_write MCP tool's own
 * defaults) — a same-concept write there lands 'active' and reinforces fine.
 * Querying the REAL production database (C:/Users/robert/.awm/memory.db) for
 * the actual stale stub engrams found the true mechanisms instead:
 *
 *   1. CONCEPT-TEMPLATE DRIFT: the sweep's own concept line wasn't stable
 *      across writes ("Freshdesk sweep — hourly re-run" vs "Hourly Freshdesk
 *      sweep #31..." vs "Freshdesk hourly sweep 2026-09-20 17:35Z..."). R1's
 *      match-vs-create pivot is exact concept-string equality by design (see
 *      write-pipeline.ts header comment, LoCoMo 2026-05-12 lesson) so any
 *      wording drift permanently forks a new lineage. This is a usage
 *      problem, not an AWM bug — fixed by writing recurring facts with a
 *      stable concept template, not by changing AWM.
 *
 *   2. ARCHIVED-MATCH DEAD END (the actual AWM bug, fixed below): several of
 *      the real stale stubs sat at stage='archived' with confidence as high
 *      as 0.78-0.85 — archived by consolidation's Phase 6.5 redundancy-prune
 *      (engine/consolidation.ts:660-713), which archives a "loser"
 *      near-duplicate WITHOUT merging its confidence into the survivor. R1's
 *      health check required stage==='active', so an archived match could
 *      never be reinforced again regardless of its confidence, and it was
 *      never superseded either (nothing routinely supersedes a routine
 *      status note) — so every later matching write fell through to create()
 *      forever. Fixed in write-pipeline.ts by reviving an archived match on
 *      reinforcement instead of treating it as a dead end.
 */
describe('Reinforcement gaps found via the Freshdesk-sweep "family of stubs" incident (2026-09-22)', () => {
  let store: EngramStore;
  let connectionEngine: ConnectionEngine;
  let tmp: string;
  const AGENT = 'test-reinforcement-floor';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-reinforce-floor-test-'));
    store = new EngramStore(join(tmp, 'test.db'));
    const activation = new ActivationEngine(store);
    connectionEngine = new ConnectionEngine(store, activation);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('concept-template drift (usage issue, not an AWM bug): varying concept text across writes of the same recurring fact permanently forks new lineages', async () => {
    // Exact concept strings pulled from real /freshdesk-support sweep memories
    // recalled 2026-09-22 (ids 5e236694/2f66d744/a525bd1a for the first template,
    // dffd57e9 for the numbered template, b090bc24 for the dated template).
    const conceptTemplates = [
      'Freshdesk sweep — hourly re-run',
      'Freshdesk sweep — hourly re-run',
      'Hourly Freshdesk sweep #31, 7-day window, anchor 2026-09-03T19:28Z',
      'Freshdesk hourly sweep 2026-09-20 17:35Z from anchor 16:13Z',
      'Freshdesk sweep — hourly re-run',
    ];
    const results = [];
    for (let i = 0; i < conceptTemplates.length; i++) {
      results.push(await performWrite({ store, connectionEngine }, {
        agentId: AGENT,
        concept: conceptTemplates[i],
        content: `Hourly re-check anchor advanced. Proven zero: 0 incremental, 89 in 7-day control. ` +
          `Quiet hour. Carried items unchanged. LAST SWEEP ANCHOR = 2026-09-0${i + 4}T09:28Z.`,
        eventType: 'observation',
        causalDepth: 0.3,
        resolutionEffort: 0.3,
      }));
    }
    const actions = results.map(r => r.action);
    const distinctIds = new Set(results.map(r => r.engram.id));
    console.log('[concept-drift repro] actions:', actions, 'distinct engrams:', distinctIds.size);

    // The two writes with an IDENTICAL concept (index 0 and 1) reinforce each
    // other fine; the numbered/dated-template writes (2, 3) each fork a new
    // lineage purely because their concept text differs, despite near-identical content.
    expect(actions[1]).toBe('reinforce');
    expect(distinctIds.size).toBe(3);
  });

  it('archived-match dead end (the fixed AWM bug): reinforcing a same-concept ARCHIVED match now revives it instead of creating a new engram', async () => {
    // Real DB evidence (2026-09-22 query against C:/Users/robert/.awm/memory.db):
    // several "Freshdesk sweep — hourly re-run" engrams sit at stage=archived with
    // confidence as high as 0.78-0.85 (archived by consolidation's Phase 6.5
    // redundancy-prune, which archives a "loser" duplicate WITHOUT merging its
    // confidence into the survivor). Simulate that exact state directly.
    const first = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Freshdesk sweep — hourly re-run (archived-match probe)',
      content: 'Hourly re-check, anchor advanced. Proven zero: 0 incremental. Quiet hour. LAST SWEEP ANCHOR = 2026-09-07T04:28Z.',
      eventType: 'observation',
      causalDepth: 0.3,
      resolutionEffort: 0.3,
      confidence: 0.81, // matches the real archived engram 0a7ba5f4's actual stored confidence
    });
    expect(first.action).toBe('create');

    // Simulate what Phase 6.5 redundancy-prune does: archive it directly, no supersede.
    await store.updateStage(first.engram.id, 'archived');
    const archived = store.getEngram(first.engram.id);
    expect(archived?.stage).toBe('archived');
    expect(archived?.confidence).toBeGreaterThan(HEALTHY_CONFIDENCE_FLOOR); // high confidence, just not active

    const second = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Freshdesk sweep — hourly re-run (archived-match probe)', // exact same concept
      content: 'Hourly re-check, anchor advanced. Proven zero: 0 incremental. Quiet hour. LAST SWEEP ANCHOR = 2026-09-07T05:28Z.',
      eventType: 'observation',
      causalDepth: 0.3,
      resolutionEffort: 0.3,
    });

    // FIXED 2026-09-22: matching concept + high confidence now revives the
    // archived engram via reinforcement instead of spawning a new one.
    console.log('[archived-match repro] second.action =', second.action, 'same engram?', second.engram.id === first.engram.id);
    expect(second.action).toBe('reinforce');
    expect(second.engram.id).toBe(first.engram.id);
    const revived = store.getEngram(first.engram.id);
    expect(revived?.stage).toBe('active');
  });

  it('sanity: a HEALTHY-confidence same-concept write DOES reinforce (the baseline the other two tests contrast against)', async () => {
    const first = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Freshdesk sweep — hourly re-run (healthy variant)',
      content: 'A write with high enough salience to land active, e.g. explicit high resolutionEffort/causalDepth.',
      eventType: 'observation',
      causalDepth: 0.9,
      resolutionEffort: 0.9,
    });
    expect(first.engram.confidence).toBeGreaterThanOrEqual(HEALTHY_CONFIDENCE_FLOOR);

    const second = await performWrite({ store, connectionEngine }, {
      agentId: AGENT,
      concept: 'Freshdesk sweep — hourly re-run (healthy variant)',
      content: 'A write with high enough salience to land active, e.g. explicit high resolutionEffort/causalDepth. (again)',
      eventType: 'observation',
      causalDepth: 0.9,
      resolutionEffort: 0.9,
    });
    expect(second.action).toBe('reinforce');
    expect(second.engram.id).toBe(first.engram.id);
  });
});
