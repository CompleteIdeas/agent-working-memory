import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import type { ActivationEvent } from '../src/types/eval.js';

/**
 * 0.14.3: feedback must JOIN to the recall that produced it.
 *
 * Live-store finding 2026-09-11: retrieval_feedback had 872 rows and
 * activation_event_id was NULL in all 872 — the MCP path hardcoded null, and
 * the engine generated the event id but never returned it. These tests pin
 * the store-level contract the fix depends on: a linked row is counted by
 * getLinkedFeedbackStats; an unlinked row is not; percentiles are computed
 * from the sorted latency column rather than a mean.
 */

let dir: string;
let store: EngramStore;
const A = 'join-test';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'awm-join-'));
  store = new EngramStore(join(dir, 'm.db'));
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function ev(id: string, latencyMs: number, engramIds: string[] = []): ActivationEvent {
  return { id, agentId: A, timestamp: new Date(), context: 'ctx ' + id, resultsReturned: engramIds.length, topScore: 0.5, latencyMs, engramIds };
}

describe('feedback → activation_event join (0.14.3)', () => {
  it('counts only feedback rows that carry an activation_event_id', () => {
    const e1 = store.createEngram({ agentId: A, concept: 'joined memory', content: 'body', tags: [] } as any);
    store.logActivationEvent(ev('evt-1', 1200, [e1.id]));

    store.logRetrievalFeedback('evt-1', e1.id, true, 'used it');   // linked, useful
    store.logRetrievalFeedback('evt-1', e1.id, false, 'meh');      // linked, not useful
    store.logRetrievalFeedback(null, e1.id, true, 'legacy path');  // UNLINKED — must not count

    const fb = store.getLinkedFeedbackStats(A, 24);
    expect(fb.total).toBe(2);
    expect(fb.useful).toBe(1);
  });

  it('does not count linked feedback from another agent', () => {
    const other = new EngramStore(join(dir, 'n.db'));
    const e = other.createEngram({ agentId: 'someone-else', concept: 'x', content: 'y', tags: [] } as any);
    other.logActivationEvent({ ...ev('evt-x', 900, [e.id]), agentId: 'someone-else' });
    other.logRetrievalFeedback('evt-x', e.id, true, '');
    expect(other.getLinkedFeedbackStats(A, 24).total).toBe(0);
    other.close();
  });

  it('reports p50/p90 from the sorted column, not a mean skewed by cold loads', () => {
    // one stall of 60 s among nine ~1 s recalls: mean ≈ 7 s, median ≈ 1 s
    const ids = ['a','b','c','d','e','f','g','h','i'];
    ids.forEach((id, i) => store.logActivationEvent(ev('lat-' + id, 1000 + i * 10)));
    store.logActivationEvent(ev('lat-stall', 60_000));

    const s = store.getActivationStats(A, 24);
    expect(s.count).toBeGreaterThanOrEqual(10);
    expect(s.p50LatencyMs).toBeLessThan(2000);
    expect(s.p90LatencyMs).toBeLessThan(60_000);   // p90 of 11+ rows sits below the single outlier
    expect(s.p95LatencyMs).toBeGreaterThanOrEqual(s.p90LatencyMs);
    expect(s.avgLatencyMs).toBeGreaterThan(s.p50LatencyMs); // the mean IS skewed — that is the point
  });
});
