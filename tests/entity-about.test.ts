// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * 0.23 entity lookup: memory_about (every memory about a name, oldest first), per-agent
 * aliases, and the write path's `aliases`. Runs on SQLite and PGlite; the Postgres store
 * shares PGlite's DDL and SQL text and has no server in the test environment.
 *
 * Run: npx vitest run tests/entity-about.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EngramStore } from '../src/storage/sqlite.js';
import { PGliteEngramStore } from '../src/storage/pglite.js';
import { memoryAbout, registerAlias } from '../src/engine/entity-about.js';
import { extractEntitiesFromTags, normalizeEntityKey, entityQueryGrams, selectEntityHits } from '../src/core/entity-extract.js';
import { formatAboutResult } from '../src/core/format-about.js';
import { performWrite } from '../src/core/write-pipeline.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { ConnectionEngine } from '../src/engine/connections.js';

const A = 'mwa-maya';
const B = 'other-agent';
const HOTEL = 'contact:events@harborhotel.example';

describe('entity key helpers', () => {
  it('normalises keys and indexes contact=', () => {
    expect(normalizeEntityKey('person=Jenna  Park')).toBe('person:jenna park');
    expect(normalizeEntityKey('project:AWM')).toBe('proj:awm');
    expect(normalizeEntityKey('entity:The Gala')).toBe('entity:the gala');
    expect(normalizeEntityKey('Jenna Park')).toBeNull();
    expect(normalizeEntityKey('colour:blue')).toBeNull();
    expect(extractEntitiesFromTags(['contact=events@harborhotel.example'])).toEqual([HOTEL]);
  });

  it('builds lowercase phrases without dropping emails or names', () => {
    const g = entityQueryGrams("What did the hotel want from Jenna's team about the gala?");
    expect(g).toContain('hotel');
    expect(g).toContain('the gala');
    expect(g).toContain('gala');
    expect(g).toContain('jenna');
    expect(g).not.toContain('what');
    expect(g).not.toContain('the');
    expect(entityQueryGrams('anything from events@harborhotel.example?')).toContain('events@harborhotel.example');
  });

  it('picks named entities: longest name wins, bare values only for name-like keys', () => {
    expect(selectEntityHits([
      { term: 'jenna', entity: 'contact:events@harborhotel.example', via: 'alias' },
      { term: 'jenna liu', entity: 'contact:jenna@lensandlight.example', via: 'alias' },
      { term: 'awm', entity: 'proj:awm', via: 'value' },
      { term: 'gala', entity: 'event:gala', via: 'value' },
    ])).toEqual(['contact:jenna@lensandlight.example', 'event:gala']);
    // "jenna" alone still resolves when nothing longer matched.
    expect(selectEntityHits([{ term: 'jenna', entity: 'contact:x', via: 'alias' }])).toEqual(['contact:x']);
  });
});

type Backend = { name: string; open: (dir: string) => any };
const BACKENDS: Backend[] = [
  { name: 'sqlite', open: (dir) => new EngramStore(join(dir, 'm.db')) },
  { name: 'pglite', open: (dir) => new PGliteEngramStore(join(dir, 'pg')) },
];

for (const be of BACKENDS) {
  describe(`memory_about (${be.name})`, () => {
    let dir: string;
    let store: any;
    const ids: Record<string, string> = {};

    async function mk(key: string, agentId: string, concept: string, tags: string[], validFrom?: string) {
      const e = await store.createEngram({
        agentId, concept, content: `${concept}. A body long enough to look like a real memory.`,
        tags, salience: 0.7, confidence: 0.8, validFrom,
      });
      await store.recordEntityMentions(e.id, agentId, extractEntitiesFromTags(tags));
      ids[key] = e.id;
      return e;
    }

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), `awm-about-${be.name}-`));
      store = be.open(dir);
      // Written out of date order on purpose: the timeline must sort by the fact's date.
      await mk('ask', A, 'Jenna asked to confirm centerpieces by Fri Nov 6', [`contact=events@harborhotel.example`, 'org=Harbor Hotel'], '2026-11-02');
      await mk('deposit', A, 'Deposit invoice 1043 for the gala', ['org=Harbor Hotel', 'contact=events@harborhotel.example'], '2026-10-28');
      await mk('tasting1', A, 'Tasting set for Nov 5', ['contact=events@harborhotel.example'], '2026-11-01');
      await mk('tasting2', A, 'Tasting moved to Nov 7', ['contact=events@harborhotel.example'], '2026-11-04');
      await store.supersedeEngram(ids.tasting1, ids.tasting2);
      await mk('wrong', A, 'Jenna works at the bakery', ['contact=events@harborhotel.example'], '2026-11-03');
      await store.retractEngram(ids.wrong, null);
      await mk('weak', A, 'Maybe a second tasting', ['contact=events@harborhotel.example'], '2026-11-04');
      await store.updateStage(ids.weak, 'staging');
      await mk('leo1', A, 'Leo preps centerpieces Thursday', ['person=Leo Martinez'], '2026-11-03');
      // Two different entities that share the value "jenna park".
      await mk('jp1', A, 'Jenna Park photographed the spring show', ['person=Jenna Park']);
      await mk('jp2', A, 'Jenna Park the vendor contact', ['contact=Jenna Park']);
      // Another agent's memory under the very same key.
      await mk('other', B, 'Agent B note on the hotel', ['contact=events@harborhotel.example'], '2026-10-01');

      expect((await registerAlias(store, A, 'Martinez', 'person=Leo Martinez')).ok).toBe(true);
      expect((await registerAlias(store, A, 'Harbor events', HOTEL)).ok).toBe(true);
      expect((await registerAlias(store, B, 'harbor events', 'org:somewhere else')).ok).toBe(true);
    }, 60_000);

    afterAll(async () => {
      await store.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    });

    it('finds a person by full name, by surname alias and by key', async () => {
      for (const q of ['Leo Martinez', 'martinez', 'person:leo martinez', 'person=Leo Martinez']) {
        const r = await memoryAbout(store, { entity: q, agentIds: [A] });
        expect(r.status, q).toBe('found');
        expect(r.entity).toBe('person:leo martinez');
        expect(r.memories.map(m => m.engram.id)).toEqual([ids.leo1]);
      }
      expect((await memoryAbout(store, { entity: 'martinez', agentIds: [A] })).matchedBy).toBe('alias');
      expect((await memoryAbout(store, { entity: 'Leo Martinez', agentIds: [A] })).matchedBy).toBe('value');
      expect((await memoryAbout(store, { entity: 'person:leo martinez', agentIds: [A] })).matchedBy).toBe('key');
    });

    it('returns every memory in date order, superseded labelled, retracted and staged left out', async () => {
      const r = await memoryAbout(store, { entity: 'harbor events', agentIds: [A] });
      expect(r.status).toBe('found');
      expect(r.entity).toBe(HOTEL);
      expect(r.memories.map(m => m.engram.id)).toEqual([ids.deposit, ids.tasting1, ids.ask, ids.tasting2]);
      const hist = r.memories.find(m => m.engram.id === ids.tasting1)!;
      expect(hist.superseded).toBe(true);
      expect(r.memories.some(m => m.engram.id === ids.wrong)).toBe(false);
      expect(r.memories.some(m => m.engram.id === ids.weak)).toBe(false);
      expect(r.aliases).toContain('harbor events');
      const text = formatAboutResult(r);
      expect(text).toMatch(/SUPERSEDED/);
      expect(text.indexOf('Deposit invoice')).toBeLessThan(text.indexOf('Tasting moved'));
    });

    it('honours include_superseded: false, include_staging and limit (newest kept)', async () => {
      const noHist = await memoryAbout(store, { entity: HOTEL, agentIds: [A], includeSuperseded: false });
      expect(noHist.memories.map(m => m.engram.id)).toEqual([ids.deposit, ids.ask, ids.tasting2]);
      const withWeak = await memoryAbout(store, { entity: HOTEL, agentIds: [A], includeStaging: true });
      expect(withWeak.memories.map(m => m.engram.id)).toContain(ids.weak);
      const two = await memoryAbout(store, { entity: HOTEL, agentIds: [A], limit: 2 });
      expect(two.memories.map(m => m.engram.id)).toEqual([ids.ask, ids.tasting2]);
      expect(two.omitted).toBe(2);
      expect(formatAboutResult(two)).toMatch(/2 older memories left out by limit/);
    });

    it('keeps agents apart: memories and aliases', async () => {
      const a = await memoryAbout(store, { entity: HOTEL, agentIds: [A] });
      expect(a.memories.some(m => m.engram.id === ids.other)).toBe(false);
      const b = await memoryAbout(store, { entity: HOTEL, agentIds: [B] });
      expect(b.memories.map(m => m.engram.id)).toEqual([ids.other]);
      // B's alias "harbor events" points elsewhere and must not leak into A's lookup, or back.
      expect((await memoryAbout(store, { entity: 'harbor events', agentIds: [A] })).entity).toBe(HOTEL);
      const bAlias = await memoryAbout(store, { entity: 'harbor events', agentIds: [B] });
      expect(bAlias.entity).not.toBe(HOTEL);
      expect(await store.getEngramIdsByEntity('harbor events', B)).toEqual([]);
      expect((await store.getEngramIdsByEntity('harbor events', A)).sort()).toEqual(
        [ids.ask, ids.deposit, ids.tasting1, ids.tasting2, ids.wrong, ids.weak].sort());
      expect((await store.listEntityAliases([A])).map((x: any) => x.alias)).not.toContain('martinez-b');
      expect(await store.searchEntities('somewhere', 8, [A])).toEqual([]);
    });

    it('an ambiguous name returns candidates, never merged memories', async () => {
      const r = await memoryAbout(store, { entity: 'Jenna Park', agentIds: [A] });
      expect(r.status).toBe('ambiguous');
      expect(r.candidates).toEqual(['contact:jenna park', 'person:jenna park']);
      expect(r.memories).toEqual([]);
      expect(formatAboutResult(r)).toMatch(/more than one entity/);
      // The full key settles it.
      const p = await memoryAbout(store, { entity: 'person:jenna park', agentIds: [A] });
      expect(p.memories.map(m => m.engram.id)).toEqual([ids.jp1]);
    });

    it('no exact match: near names as candidates, or not_found', async () => {
      const near = await memoryAbout(store, { entity: 'harbor', agentIds: [A] });
      expect(near.status).toBe('candidates');
      expect(near.candidates).toContain('org:harbor hotel');
      expect(near.memories).toEqual([]);
      expect((await memoryAbout(store, { entity: 'zebra crossing', agentIds: [A] })).status).toBe('not_found');
    });

    it('aliases: move says what it replaced, remove works, bad keys are refused', async () => {
      const moved = await registerAlias(store, A, 'Martinez', 'person:ana martinez');
      expect(moved).toMatchObject({ ok: true, previous: 'person:leo martinez' });
      const movedTo = await memoryAbout(store, { entity: 'martinez', agentIds: [A] });
      expect(movedTo.entity).toBe('person:ana martinez');
      expect(movedTo.total).toBe(0);
      expect(await store.removeEntityAlias(A, 'martinez')).toBe(true);
      expect(await store.removeEntityAlias(A, 'martinez')).toBe(false);
      expect((await registerAlias(store, A, 'x', 'Leo')).ok).toBe(false);
      const same = await registerAlias(store, A, 'Harbor events', HOTEL);
      expect(same).toMatchObject({ ok: true, previous: null });
    });
  });
}

describe('alias migration (sqlite): an old global table becomes per-agent, idempotently', () => {
  it('keeps old rows as shared aliases that still resolve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awm-alias-mig-'));
    const path = join(dir, 'old.db');
    try {
      const raw = new Database(path);
      raw.exec(`CREATE TABLE entity_aliases (alias TEXT PRIMARY KEY, entity TEXT NOT NULL);
                INSERT INTO entity_aliases VALUES ('starbox', 'horse:thunder');`);
      raw.close();
      const s1 = new EngramStore(path);
      s1.recordEntityMentions('e1', 'agent-x', ['horse:thunder']);
      expect(s1.getEngramIdsByEntity('starbox', 'agent-x')).toEqual(['e1']);
      s1.close();
      const s2 = new EngramStore(path); // second open: migration must be a no-op
      const cols = (s2 as any).db.prepare('PRAGMA table_info(entity_aliases)').all().map((c: any) => c.name);
      expect(cols).toEqual(['agent_id', 'alias', 'entity']);
      expect(s2.listEntityAliases(['agent-x'])).toEqual([{ agentId: '', alias: 'starbox', entity: 'horse:thunder' }]);
      // An agent's own alias overrides the shared one for that agent only.
      s2.setEntityAlias('agent-y', 'starbox', 'horse:other');
      s2.recordEntityMentions('e2', 'agent-y', ['horse:other']);
      expect(s2.getEngramIdsByEntity('starbox', 'agent-y')).toEqual(['e2']);
      expect(s2.getEngramIdsByEntity('starbox', 'agent-x')).toEqual(['e1']);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('alias migration (pglite): idempotent on reopen', () => {
  it('reopens a migrated store and keeps aliases per agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awm-alias-mig-pg-'));
    try {
      const s1 = new PGliteEngramStore(join(dir, 'pg'));
      await s1.setEntityAlias('agent-x', 'starbox', 'horse:thunder');
      await s1.close();
      const s2 = new PGliteEngramStore(join(dir, 'pg'));
      expect(await s2.listEntityAliases(['agent-x'])).toEqual([{ agentId: 'agent-x', alias: 'starbox', entity: 'horse:thunder' }]);
      expect(await s2.listEntityAliases(['agent-y'])).toEqual([]);
      await s2.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }, 60_000);
});

describe('write path (sqlite): aliases on memory_write, and merged writes stay indexed', () => {
  const MCP = { surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3, eventType: 'observation' as const };
  let dir: string; let store: EngramStore; let engines: any;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'awm-about-write-'));
    store = new EngramStore(join(dir, 'm.db'));
    engines = { store, connectionEngine: new ConnectionEngine(store as any, new ActivationEngine(store as any)) };
  });
  afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('registers aliases for the one name-like tag; proj= does not count', async () => {
    const res = await performWrite(engines, {
      agentId: A, concept: 'Jenna Park is the Harbor Hotel events manager',
      content: 'Signature: Jenna Park, Events Manager, Harbor Hotel. Writes from events@harborhotel.example.',
      tags: ['proj=MWA', 'contact=events@harborhotel.example'], aliases: ['Jenna', 'Jenna Park'], memoryClass: 'canonical', ...MCP,
    } as any);
    expect(res.aliases).toEqual({ entity: HOTEL, registered: ['jenna', 'jenna park'], replaced: [] });
    const r = await memoryAbout(store, { entity: 'Jenna', agentIds: [A] });
    expect(r.status).toBe('found');
    expect(r.memories.map(m => m.engram.id)).toEqual([res.engram.id]);
  });

  it('asks for aliasFor when the write names two entities, and accepts it', async () => {
    const tags = ['contact=events@harborhotel.example', 'org=Harbor Hotel'];
    const base = { agentId: A, concept: 'Harbor Hotel gala on Nov 14', content: 'The gala is on Nov 14 in the ballroom; Jenna runs it.', tags, memoryClass: 'canonical', ...MCP } as any;
    const amb = await performWrite(engines, { ...base, aliases: ['the hotel'] });
    expect(amb.aliases?.registered).toEqual([]);
    expect(amb.aliases?.error).toMatch(/aliasFor/);
    const ok = await performWrite(engines, { ...base, concept: 'Harbor Hotel ballroom booked', content: 'Ballroom booked for the gala.', aliases: ['the hotel'], aliasFor: 'org=Harbor Hotel' });
    expect(ok.aliases).toMatchObject({ entity: 'org:harbor hotel', registered: ['the hotel'] });
  });

  it('a write merged into an existing memory indexes its tags onto that memory', async () => {
    const base = { agentId: A, concept: 'Centerpiece count', content: 'Forty centerpieces for the gala tables.', memoryClass: 'canonical', ...MCP } as any;
    const first = await performWrite(engines, { ...base, tags: [] });
    const second = await performWrite(engines, { ...base, tags: ['event=harbor hotel gala'] });
    expect(second.action).toBe('reinforce');
    expect(second.engram.id).toBe(first.engram.id);
    expect(store.getEngramIdsByEntity('event:harbor hotel gala', A)).toEqual([first.engram.id]);
  });
});
