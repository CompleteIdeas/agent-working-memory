// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Backfill the entity inverted index from EXISTING prefix tags.
 *
 * The D9 index (entity_mentions) is written at write time only, from 2026-08-03.
 * Live store on 2026-09-11: 100% of work engrams carry tags, but only 8% (1,964 of
 * 24,025) have entity rows — 20,697 engrams predate the index and were never
 * backfilled. That means D11 entity-index candidate injection, even if enabled,
 * could only ever reach 8% of the store by identifier.
 *
 * This applies exactly the write-time extractor (extractEntitiesFromTags) to every
 * engram that has no entity rows yet. INSERT OR IGNORE, so re-running is a no-op.
 *
 *   npx tsx tests/realstore-eval/backfill-entities.ts <path-to-db> [--dry-run]
 *
 * Point it at the eval SNAPSHOT first to measure D11 against a fully indexed store;
 * point it at the live store only after that measurement says it is worth it.
 */
import Database from 'better-sqlite3';
import { extractEntitiesFromTags } from '../../src/core/entity-extract.js';

const dbPath = process.argv[2];
const dry = process.argv.includes('--dry-run');
if (!dbPath) { console.error('usage: backfill-entities.ts <db> [--dry-run]'); process.exit(2); }

const db = new Database(dbPath, { readonly: dry });
const rows = db.prepare(`
  SELECT e.id, e.agent_id, e.tags FROM engrams e
  WHERE e.retracted = 0 AND e.tags IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM entity_mentions m WHERE m.engram_id = e.id)
`).all() as { id: string; agent_id: string; tags: string }[];

let engrams = 0, entities = 0;
const ins = dry ? null : db.prepare('INSERT OR IGNORE INTO entity_mentions (entity, engram_id, agent_id) VALUES (?, ?, ?)');
const tx = db.transaction((batch: typeof rows) => {
  for (const r of batch) {
    let tags: string[] = [];
    try { tags = JSON.parse(r.tags); } catch { continue; }
    const ents = extractEntitiesFromTags(tags);
    if (!ents.length) continue;
    engrams++; entities += ents.length;
    if (ins) for (const en of ents) ins.run(en, r.id, r.agent_id);
  }
});
tx(rows);

const after = db.prepare('SELECT COUNT(DISTINCT engram_id) AS n FROM entity_mentions').get() as { n: number };
const total = db.prepare('SELECT COUNT(*) AS n FROM engrams WHERE retracted = 0').get() as { n: number };
console.log(`${dry ? '[dry-run] would index' : 'indexed'} ${engrams} engrams (+${entities} entity rows)`);
console.log(`entity coverage now ${after.n} / ${total.n} = ${(100 * after.n / total.n).toFixed(0)}%`);
db.close();
