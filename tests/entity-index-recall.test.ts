import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { ActivationEngine } from '../src/engine/activation.js';

/**
 * D11 — entity-index candidate injection (AWM_ENTITY_INDEX_FETCH=1).
 *
 * Tags are lexically indexed, so a fact tagged with the query's exact entity
 * name is already BM25-reachable. The index earns its keep on ALIAS resolution:
 * the query says "Starbox", the fact is indexed under horse:thunder, and only
 * entity_aliases connects the two. No lexical or vector channel can make that
 * hop — the injection path is the only route.
 */
describe('entity-index candidate injection (D11, alias route)', () => {
  let dir: string;
  let store: EngramStore;
  let engine: ActivationEngine;
  const AGENT = 'test-d11';
  const QUERY = 'Where is Starbox stabled at the venue location?';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'awm-d11-'));
    store = new EngramStore(join(dir, 'test.db'));
    engine = new ActivationEngine(store);

    // Gold: no query vocabulary in concept, content, OR tags ("Starbox" appears nowhere).
    const gold = await store.createEngram({
      agentId: AGENT, concept: 'barn row assignment',
      content: 'Barn C row 4 was assigned for the gelding.',
      tags: ['horse=thunder'], salience: 0.7, confidence: 0.8,
    });
    store.recordEntityMentions(gold.id, AGENT, ['horse:thunder']);
    // The alias is the only bridge from the query's name to the indexed entity.
    store['db'].prepare('INSERT INTO entity_aliases (alias, entity) VALUES (?, ?)')
      .run('horse:starbox', 'horse:thunder');
    store['db'].prepare('INSERT INTO entity_aliases (alias, entity) VALUES (?, ?)')
      .run('starbox', 'horse:thunder');

    // Distractors that DO share query vocabulary.
    for (let i = 0; i < 6; i++) {
      await store.createEngram({
        agentId: AGENT, concept: `stabling location info ${i}`,
        content: `General stabling location information sheet number ${i} for the venue.`,
        tags: [], salience: 0.6, confidence: 0.8,
      });
    }
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('searchEntities resolves alias matches to their target entity', () => {
    expect(store.searchEntities('starbox')).toContain('horse:thunder');
  });

  it('without the flag, the alias-only gold is not reachable', async () => {
    delete process.env.AWM_ENTITY_INDEX_FETCH;
    const results = await engine.activate({
      agentId: AGENT, context: QUERY, limit: 8, minScore: 0.05,
      useReranker: false, useExpansion: false, internal: true,
    });
    expect(results.some(r => r.engram.concept === 'barn row assignment')).toBe(false);
  });

  it('with the flag, the alias route injects gold into the results', async () => {
    process.env.AWM_ENTITY_INDEX_FETCH = '1';
    try {
      const results = await engine.activate({
        agentId: AGENT, context: QUERY, limit: 8, minScore: 0.05,
        useReranker: false, useExpansion: false, internal: true,
      });
      expect(results.some(r => r.engram.concept === 'barn row assignment')).toBe(true);
    } finally {
      delete process.env.AWM_ENTITY_INDEX_FETCH;
    }
  });

  it('superseded engrams are not injected via the index', async () => {
    const stale = await store.createEngram({
      agentId: AGENT, concept: 'old barn row note',
      content: 'Barn A row 1 previously held the gelding.',
      tags: ['horse=thunder'], salience: 0.7, confidence: 0.8,
    });
    store.recordEntityMentions(stale.id, AGENT, ['horse:thunder']);
    await store.supersedeEngram(stale.id, 'replacement-id');
    process.env.AWM_ENTITY_INDEX_FETCH = '1';
    try {
      const results = await engine.activate({
        agentId: AGENT, context: QUERY, limit: 8, minScore: 0.05,
        useReranker: false, useExpansion: false, internal: true,
      });
      expect(results.some(r => r.engram.concept === 'old barn row note')).toBe(false);
    } finally {
      delete process.env.AWM_ENTITY_INDEX_FETCH;
    }
  });
});
