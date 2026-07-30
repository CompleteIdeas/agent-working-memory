import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { extractEntitiesFromTags } from '../src/core/entity-extract.js';

describe('entity extraction (D9)', () => {
  it('extracts normalized key:value entities from prefix tags', () => {
    expect(extractEntitiesFromTags(['person=Seetha', 'ticket=18999', 'topic=aec', 'intent=finding']))
      .toEqual(['person:seetha', 'ticket:18999']);
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
    store.recordEntityMentions('eng-1', 'work', ['person:seetha', 'ticket:18999']);
    store.recordEntityMentions('eng-1', 'work', ['person:seetha']); // duplicate — ignored
    store.recordEntityMentions('eng-2', 'work', ['person:seetha']);
    store.recordEntityMentions('eng-3', 'personal', ['person:seetha']);

    expect(store.getEngramIdsByEntity('person:seetha', 'work').sort()).toEqual(['eng-1', 'eng-2']);
    expect(store.getEngramIdsByEntity('person:seetha').length).toBe(3);
    expect(store.getEngramIdsByEntity('ticket:18999', 'work')).toEqual(['eng-1']);
    expect(store.getEngramIdsByEntity('person:nobody', 'work')).toEqual([]);
  });

  it('resolves aliases before lookup', () => {
    store['db'].prepare('INSERT INTO entity_aliases (alias, entity) VALUES (?, ?)')
      .run('person:seetha kanagala', 'person:seetha');
    expect(store.getEngramIdsByEntity('person:Seetha Kanagala', 'work').sort()).toEqual(['eng-1', 'eng-2']);
  });
});
