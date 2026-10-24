/**
 * embedding_model is stamped whenever a vector is written (2026-10-24).
 *
 * The SQLite INSERT had no embedding_model column at all, and every updateEmbedding()
 * caller except consolidation's re-embed omitted the model id, so every fresh write in
 * every consumer landed NULL — the MWA pilot stores had it NULL on all 924 rows. The
 * cosine thresholds in consolidation and recall are calibrated per model, so a store
 * must be able to say which model produced its vectors.
 *
 * Run: npx vitest run tests/storage/embedding-model-stamp.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { getModelId } from '../../src/core/embeddings.js';

const AGENT = 'embedding-model-stamp';
const vec = () => { const v = new Array(384).fill(0); v[0] = 1; return v; };

describe('EngramStore (sqlite) — embedding_model stamping', () => {
  let store: EngramStore;
  let tmp: string;
  const modelOf = (id: string) => (store as any).db.prepare('SELECT embedding_model AS m FROM engrams WHERE id = ?').get(id).m;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-embmodel-'));
    store = new EngramStore(join(tmp, 'test.db'));
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('createEngram with an embedding stamps the current model', () => {
    const e = store.createEngram({ agentId: AGENT, concept: 'with vector', content: 'body', embedding: vec() } as any);
    expect(modelOf(e.id)).toBe(getModelId());
  });

  it('createEngram without an embedding leaves the model NULL', () => {
    const e = store.createEngram({ agentId: AGENT, concept: 'no vector', content: 'body' } as any);
    expect(modelOf(e.id)).toBeNull();
  });

  it('an explicit embeddingModel (an import of another model\'s export) is kept as given', () => {
    const e = store.createEngram({ agentId: AGENT, concept: 'imported', content: 'body', embedding: vec(), embeddingModel: 'Xenova/all-MiniLM-L6-v2' } as any);
    expect(modelOf(e.id)).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('updateEmbedding without a model id stamps the current model', () => {
    const e = store.createEngram({ agentId: AGENT, concept: 'late vector', content: 'body' } as any);
    expect(modelOf(e.id)).toBeNull();
    store.updateEmbedding(e.id, vec());
    expect(modelOf(e.id)).toBe(getModelId());
  });
});
