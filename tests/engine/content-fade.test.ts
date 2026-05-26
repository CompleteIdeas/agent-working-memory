/**
 * Content fade stage — Paper 1: storage degradation.
 *
 * Engrams that have been recalled before but have gone stale get their content
 * trimmed to FADE_KEEP_CHARS + a "[faded]" marker, while concept, tags, and
 * embedding are preserved. The stage transitions active → fading.
 *
 * Run: npx vitest run tests/engine/content-fade.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ConsolidationEngine } from '../../src/engine/consolidation.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const AGENT = 'fade-test';
const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_CONTENT = (
  'A long body of text that exceeds the FADE_MIN_CONTENT_LEN threshold so the ' +
  'fade phase will actually trim it. ' +
  'Repeated content to push past 250 chars. '.repeat(8)
);

function ageEngram(store: EngramStore, id: string, daysAgo: number, accessCount: number) {
  const ts = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  // Direct SQL — push lastAccessed back so the fade criteria fire.
  (store as any).db.prepare(
    'UPDATE engrams SET last_accessed = ?, created_at = ?, access_count = ? WHERE id = ?',
  ).run(ts, ts, accessCount, id);
  // Invalidate slim cache so subsequent queries see the new state.
  (store as any).resetSlimCache?.();
}

describe('ConsolidationEngine — content fade phase', () => {
  let store: EngramStore;
  let consolidation: ConsolidationEngine;
  let activation: ActivationEngine;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-fade-'));
    store = new EngramStore(join(tmp, 'test.db'));
    consolidation = new ConsolidationEngine(store);
    activation = new ActivationEngine(store);
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('fades an accessed, stale, long-content engram', async () => {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'database indexing strategy',
      content: LONG_CONTENT,
      tags: ['database', 'performance'],
      salience: 0.6,
      confidence: 0.6,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.01)),
    });
    ageEngram(store, e.id, 60, 2); // 60 days old, 2 accesses → fade

    const result = await consolidation.consolidate(AGENT);

    expect(result.memoriesFaded).toBe(1);
    const after = await store.getEngram(e.id);
    expect(after?.stage).toBe('fading');
    expect(after?.content.endsWith('… [faded]')).toBe(true);
    expect(after?.content.length).toBeLessThan(LONG_CONTENT.length);
    // Concept, tags, and embedding preserved.
    expect(after?.concept).toBe('database indexing strategy');
    expect(after?.tags).toContain('database');
    expect(after?.embedding?.length).toBe(384);
  });

  it('does not fade never-accessed engrams (accessCount=0 → archive path)', async () => {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'never accessed',
      content: LONG_CONTENT,
      tags: ['stale'],
      salience: 0.5,
      confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.cos(i * 0.02)),
    });
    ageEngram(store, e.id, 60, 0); // accessCount=0

    const result = await consolidation.consolidate(AGENT);
    expect(result.memoriesFaded).toBe(0);
    const after = await store.getEngram(e.id);
    expect(after?.stage).not.toBe('fading'); // Either active or archived, not fading
  });

  it('does not fade heavily-used engrams (accessCount >= 10)', async () => {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'heavily used',
      content: LONG_CONTENT,
      tags: ['hot'],
      salience: 0.7,
      confidence: 0.7,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.03)),
    });
    ageEngram(store, e.id, 60, 15);

    const result = await consolidation.consolidate(AGENT);
    expect(result.memoriesFaded).toBe(0);
    const after = await store.getEngram(e.id);
    expect(after?.stage).not.toBe('fading');
    expect(after?.content).toBe(LONG_CONTENT);
  });

  it('does not fade canonical or structural class engrams', async () => {
    const canonical = await store.createEngram({
      agentId: AGENT,
      concept: 'canonical fact',
      content: LONG_CONTENT,
      tags: ['decision'],
      salience: 0.8,
      confidence: 0.8,
      memoryClass: 'canonical',
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.04)),
    });
    const structural = await store.createEngram({
      agentId: AGENT,
      concept: 'event log',
      content: LONG_CONTENT,
      tags: ['event'],
      salience: 0.7,
      confidence: 0.7,
      memoryClass: 'structural',
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.05)),
    });
    ageEngram(store, canonical.id, 60, 3);
    ageEngram(store, structural.id, 60, 3);

    const result = await consolidation.consolidate(AGENT);
    expect(result.memoriesFaded).toBe(0);
    expect((await store.getEngram(canonical.id))?.stage).not.toBe('fading');
    expect((await store.getEngram(structural.id))?.stage).not.toBe('fading');
  });

  it('does not fade engrams with short content', async () => {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'short note',
      content: 'A brief observation.',
      tags: ['note'],
      salience: 0.5,
      confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.06)),
    });
    ageEngram(store, e.id, 60, 3);

    const result = await consolidation.consolidate(AGENT);
    expect(result.memoriesFaded).toBe(0);
    expect((await store.getEngram(e.id))?.stage).not.toBe('fading');
  });

  it('does not fade engrams that have been accessed recently', async () => {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'recently used',
      content: LONG_CONTENT,
      tags: ['recent'],
      salience: 0.5,
      confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.07)),
    });
    ageEngram(store, e.id, 10, 3); // 10 days < FADE_DAYS_SINCE_ACCESS (45)

    const result = await consolidation.consolidate(AGENT);
    expect(result.memoriesFaded).toBe(0);
    expect((await store.getEngram(e.id))?.stage).not.toBe('fading');
  });

  it('does not re-fade already-faded engrams', async () => {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'already faded',
      content: LONG_CONTENT,
      tags: ['old'],
      salience: 0.5,
      confidence: 0.5,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.08)),
    });
    ageEngram(store, e.id, 60, 2);

    // First cycle fades it.
    const r1 = await consolidation.consolidate(AGENT);
    expect(r1.memoriesFaded).toBe(1);

    // Push the cycle-clock forward and re-run; the faded engram should be skipped.
    ageEngram(store, e.id, 60, 2);
    const r2 = await consolidation.consolidate(AGENT);
    expect(r2.memoriesFaded).toBe(0);
  });

  it('faded engrams still surface in BM25 recall via concept + tags', async () => {
    const e = await store.createEngram({
      agentId: AGENT,
      concept: 'PostgreSQL composite index strategy',
      content: LONG_CONTENT,
      tags: ['database', 'postgres', 'indexing'],
      salience: 0.6,
      confidence: 0.6,
      embedding: Array(384).fill(0).map((_, i) => Math.sin(i * 0.09)),
    });
    // Add an unrelated engram so the corpus has > 1 entry.
    await store.createEngram({
      agentId: AGENT,
      concept: 'unrelated',
      content: 'Random topic about cooking and astronomy.',
      tags: ['noise'],
      salience: 0.4,
      confidence: 0.4,
      embedding: Array(384).fill(0).map((_, i) => Math.cos(i * 0.1)),
    });
    ageEngram(store, e.id, 60, 2);

    await consolidation.consolidate(AGENT);
    expect((await store.getEngram(e.id))?.stage).toBe('fading');

    // Concept words ("PostgreSQL composite index strategy") + tags survive the trim.
    const r = await activation.activate({
      agentId: AGENT,
      context: 'PostgreSQL composite index strategy',
      useReranker: false,
      useExpansion: false,
    });
    const ids = r.map(x => x.engram.id);
    expect(ids).toContain(e.id);
  });

  it('respects AWM_FADE_MAX_PER_CYCLE bound', async () => {
    // Seed 30 fade-eligible engrams; default cap is 25.
    for (let i = 0; i < 30; i++) {
      const e = await store.createEngram({
        agentId: AGENT,
        concept: `topic ${i}`,
        content: LONG_CONTENT + ` instance ${i}`,
        tags: [`bucket-${i}`],
        salience: 0.5,
        confidence: 0.5,
        embedding: Array(384).fill(0).map((_, j) => Math.sin(i * 0.01 + j * 0.001)),
      });
      ageEngram(store, e.id, 60, 2);
    }

    const result = await consolidation.consolidate(AGENT);
    expect(result.memoriesFaded).toBeLessThanOrEqual(25);
    expect(result.memoriesFaded).toBeGreaterThan(0);
  });
});
