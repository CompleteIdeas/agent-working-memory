import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { extractEntitiesFromTags } from '../src/core/entity-extract.js';

describe('entity extraction (D9)', () => {
  it('extracts normalized key:value entities from prefix tags', () => {
    expect(extractEntitiesFromTags(['person=Avery', 'ticket=10002', 'topic=aec', 'intent=finding']))
      .toEqual(['person:avery', 'ticket:10002']);
  });

  it('normalizes project→proj, honors entity: tags, dedupes, skips junk', () => {
    expect(extractEntitiesFromTags(['project=EquiHub', 'proj=equihub', 'entity:StartBox', 'person=', 'noise']))
      .toEqual(['proj:equihub', 'entity:startbox']);
  });
});

describe('entity inverted index (D9, sqlite)', () => {
  let dir: string;
  let store: EngramStore;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'awm-entity-'));
    store = new EngramStore(join(dir, 'test.db'));
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records mentions idempotently and looks up by entity, agent-scoped', () => {
    store.recordEntityMentions('eng-1', 'work', ['person:avery', 'ticket:10002']);
    store.recordEntityMentions('eng-1', 'work', ['person:avery']); // duplicate — ignored
    store.recordEntityMentions('eng-2', 'work', ['person:avery']);
    store.recordEntityMentions('eng-3', 'personal', ['person:avery']);

    expect(store.getEngramIdsByEntity('person:avery', 'work').sort()).toEqual(['eng-1', 'eng-2']);
    expect(store.getEngramIdsByEntity('person:avery').length).toBe(3);
    expect(store.getEngramIdsByEntity('ticket:10002', 'work')).toEqual(['eng-1']);
    expect(store.getEngramIdsByEntity('person:nobody', 'work')).toEqual([]);
  });

  it('resolves aliases before lookup', () => {
    store['db'].prepare('INSERT INTO entity_aliases (alias, entity) VALUES (?, ?)')
      .run('person:avery lindqvist', 'person:avery');
    expect(store.getEngramIdsByEntity('person:Avery Lindqvist', 'work').sort()).toEqual(['eng-1', 'eng-2']);
  });
});
