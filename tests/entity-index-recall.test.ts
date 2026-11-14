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

/**
 * 0.23 — AWM_ENTITY_ALIAS_MATCH: the capitalised-word route above never sees "the gala" or
 * "jenna", so a lowercase question could not reach the index at all. The alias-match route
 * matches lowercase phrases exactly against the agent's aliases.
 */
describe('entity-index injection from lowercase names (AWM_ENTITY_ALIAS_MATCH)', () => {
  let dir: string;
  let store: EngramStore;
  let engine: ActivationEngine;
  const AGENT = 'test-alias-match';
  const QUERY = 'when is the gala happening this year?';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'awm-aliasmatch-'));
    store = new EngramStore(join(dir, 'test.db'));
    engine = new ActivationEngine(store);
    const gold = await store.createEngram({
      agentId: AGENT, concept: 'ballroom booking',
      content: 'Ivory linen ordered for thirty-two round tables.',
      tags: ['event=harbor hotel benefit'], salience: 0.3, confidence: 0.5,
    });
    store.recordEntityMentions(gold.id, AGENT, ['event:harbor hotel benefit']);
    store.setEntityAlias(AGENT, 'the gala', 'event:harbor hotel benefit');
    for (let i = 0; i < 6; i++) {
      await store.createEngram({
        agentId: AGENT, concept: `when is it happening this year ${i}`,
        content: `When is it happening this year? Calendar sheet ${i} lists what is happening when.`,
        tags: [], salience: 0.8, confidence: 0.9,
      });
    }
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Effect on ranking is measured by tests/entity-eval (no boost: the injected memory is
  // auditioned, and the scorer decides). Here: the wiring. Which entities does recall look up?
  async function lookedUp(context: string): Promise<string[]> {
    const seen: string[] = [];
    const orig = store.getEngramIdsByEntity.bind(store);
    (store as any).getEngramIdsByEntity = (entity: string, agentId?: string) => { seen.push(entity); return orig(entity, agentId); };
    try {
      await engine.activate({ agentId: AGENT, context, limit: 8, minScore: 0.05, useReranker: false, useExpansion: false, internal: true });
    } finally {
      (store as any).getEngramIdsByEntity = orig;
    }
    return seen;
  }

  it('off (default): no lookup from a lowercase name, even with the D11 flag on', async () => {
    process.env.AWM_ENTITY_INDEX_FETCH = '1';
    try {
      expect(await lookedUp(QUERY)).not.toContain('event:harbor hotel benefit');
    } finally {
      delete process.env.AWM_ENTITY_INDEX_FETCH;
    }
  });

  it('on: "the gala" resolves through the alias and the memory is auditioned', async () => {
    process.env.AWM_ENTITY_ALIAS_MATCH = '1';
    try {
      expect(await lookedUp(QUERY)).toEqual(['event:harbor hotel benefit']);
      const res = await engine.activate({ agentId: AGENT, context: QUERY, limit: 8, minScore: 0.05, useReranker: false, useExpansion: false, internal: true });
      expect(res.some(r => r.engram.concept === 'ballroom booking')).toBe(true);
    } finally {
      delete process.env.AWM_ENTITY_ALIAS_MATCH;
    }
  });

  it("on: another agent's alias does not leak in; a question naming nobody looks nothing up", async () => {
    store.setEntityAlias('someone-else', 'the market', 'event:harbor hotel benefit');
    process.env.AWM_ENTITY_ALIAS_MATCH = '1';
    try {
      expect(await lookedUp('when is the market happening this year?')).toEqual([]);
      expect(await lookedUp('what is happening this year?')).toEqual([]);
    } finally {
      delete process.env.AWM_ENTITY_ALIAS_MATCH;
    }
  });
});
