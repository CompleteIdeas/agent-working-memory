/**
 * Adaptive output granularity — Paper 3: cognitive teaming
 * (Brill 2018 ACT-R collaboration).
 *
 * The activation engine surfaces engrams back to the calling agent. When the
 * caller opts in via `granularity: 'compact' | 'auto'`, results carry a short
 * `summary` field. In 'auto' mode the summary is confidence-adaptive: high
 * confidence → top result keeps a long-form summary, others get compact;
 * low confidence → all results get compact summaries so the agent can scan
 * a diverse set.
 *
 * Run: npx vitest run tests/engine/granularity.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const AGENT = 'granularity-test';
const LONG_CONTENT = (
  'A detailed explanation of database indexing strategy. ' +
  'Composite indexes are most effective when the leading column is selective. ' +
  'PostgreSQL ivfflat works best with appropriately-tuned probes. '.repeat(6)
);

describe('ActivationEngine — output granularity', () => {
  let store: EngramStore;
  let activation: ActivationEngine;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-grain-'));
    store = new EngramStore(join(tmp, 'test.db'));
    activation = new ActivationEngine(store);

    store.createEngram({
      agentId: AGENT,
      concept: 'database optimization indexes',
      content: LONG_CONTENT,
      tags: ['database', 'performance', 'postgres'],
      salience: 0.6,
      confidence: 0.6,
    });
    for (let i = 0; i < 5; i++) {
      store.createEngram({
        agentId: AGENT,
        concept: `unrelated topic ${i}`,
        content: `Random fact ${i} about cooking. `.repeat(8),
        tags: [`topic-${i}`],
        salience: 0.4,
        confidence: 0.4,
      });
    }
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('default granularity does NOT attach summary', async () => {
    const r = await activation.activate({
      agentId: AGENT,
      context: 'database query optimization indexes',
      useReranker: false,
      useExpansion: false,
    });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].summary).toBeUndefined();
  });

  it("'compact' attaches a short summary to every result", async () => {
    const r = await activation.activate({
      agentId: AGENT,
      context: 'database query optimization indexes',
      useReranker: false,
      useExpansion: false,
      granularity: 'compact',
    });
    expect(r.length).toBeGreaterThan(0);
    for (const result of r) {
      expect(result.summary).toBeDefined();
      // Compact summary should be much shorter than the full content for any
      // result whose content is long.
      if (result.engram.content.length > 250) {
        expect(result.summary!.length).toBeLessThan(result.engram.content.length);
        expect(result.summary!.length).toBeLessThanOrEqual(201); // 200 + '…'
      }
    }
  });

  it("'compact' preserves short content as-is", async () => {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'short note',
      content: 'A brief, focused observation.',
      tags: ['note'],
      salience: 0.5, confidence: 0.5,
    });

    const r = await activation.activate({
      agentId: AGENT,
      context: 'short note brief observation',
      useReranker: false,
      useExpansion: false,
      granularity: 'compact',
    });
    const hit = r.find(x => x.engram.id === e.id);
    expect(hit).toBeDefined();
    expect(hit!.summary).toBe('A brief, focused observation.');
  });

  it("'compact' summary never includes content beyond the cap", async () => {
    const r = await activation.activate({
      agentId: AGENT,
      context: 'database query optimization indexes',
      useReranker: false,
      useExpansion: false,
      granularity: 'compact',
    });
    const top = r[0];
    expect(top.summary!.length).toBeLessThanOrEqual(201);
    if (top.summary!.length === 201) {
      expect(top.summary!.endsWith('…')).toBe(true);
    }
  });

  it("'auto' on a clear-winner recall gives the top result a longer summary", async () => {
    const r = await activation.activate({
      agentId: AGENT,
      context: 'database optimization indexes postgres performance',
      useReranker: false,
      useExpansion: false,
      granularity: 'auto',
      requireConfidence: 0, // No abstention
    });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].summary).toBeDefined();

    if ((r[0].confidence ?? 0) >= 0.4) {
      // Confidence-gated path: top summary is the long-form variant.
      expect(r[0].summary!.length).toBeGreaterThan(200);
      // Lower-ranked results (if any) are compact.
      if (r.length > 1 && r[1].engram.content.length > 250) {
        expect(r[1].summary!.length).toBeLessThanOrEqual(201);
      }
    } else {
      // Low-confidence path: everything compact.
      expect(r[0].summary!.length).toBeLessThanOrEqual(201);
    }
  });

  it("'full' is the default when granularity is omitted", async () => {
    const r1 = await activation.activate({
      agentId: AGENT,
      context: 'database optimization',
      useReranker: false,
      useExpansion: false,
    });
    const r2 = await activation.activate({
      agentId: AGENT,
      context: 'database optimization',
      useReranker: false,
      useExpansion: false,
      granularity: 'full',
    });
    expect(r1[0].summary).toBeUndefined();
    expect(r2[0].summary).toBeUndefined();
  });

  it('granularity does not alter the engram body itself', async () => {
    const r = await activation.activate({
      agentId: AGENT,
      context: 'database optimization indexes',
      useReranker: false,
      useExpansion: false,
      granularity: 'compact',
    });
    for (const result of r) {
      const fresh = store.getEngram(result.engram.id);
      expect(fresh?.content).toBe(result.engram.content);
    }
  });

  it('granularity does not alter confidence or scoring', async () => {
    // Use internal: true on both calls so access counts + Hebbian co-activation
    // don't mutate state between recalls and shift the second call's scores.
    const baseline = await activation.activate({
      agentId: AGENT,
      context: 'database optimization indexes',
      useReranker: false,
      useExpansion: false,
      internal: true,
    });
    const compact = await activation.activate({
      agentId: AGENT,
      context: 'database optimization indexes',
      useReranker: false,
      useExpansion: false,
      granularity: 'compact',
      internal: true,
    });
    expect(compact.length).toBe(baseline.length);
    expect(compact[0].confidence).toBeCloseTo(baseline[0].confidence ?? 0, 6);
    expect(compact[0].score).toBeCloseTo(baseline[0].score, 6);
    expect(compact[0].engram.id).toBe(baseline[0].engram.id);
  });
});
