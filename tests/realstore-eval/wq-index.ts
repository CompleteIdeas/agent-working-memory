/**
 * Write-time questions, step 3: a copy of the snapshot where ONLY the keyword index sees each
 * memory's questions — the shape that won on the sample (wq-eval.ts). The engrams rows, their
 * vectors and everything the cross-encoder reads are unchanged; the FTS5 row of each memory is
 * re-indexed with its questions appended to the tags column, which is what a `questions` column
 * indexed by FTS would do in production.
 *
 *   npx tsx tests/realstore-eval/wq-index.ts   -> tests/realstore-eval/snapshot/store-wq.db
 * Then: REALSTORE_SNAPSHOT=snapshot/store-wq.db for stage-diagnose.ts / gate-eval.ts.
 */
import Database from 'better-sqlite3';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dirname;
const out = join(dir, 'snapshot', 'store-wq.db');
copyFileSync(join(dir, 'snapshot', 'store.db'), out);
const WQ = JSON.parse(readFileSync(join(dir, 'nl-wq.json'), 'utf8')) as { questions: Record<string, string[]> };
const db = new Database(out);
const row = db.prepare('SELECT rowid, concept, content, tags FROM engrams WHERE id = ?');
const del = db.prepare(`INSERT INTO engrams_fts(engrams_fts, rowid, concept, content, tags) VALUES('delete', ?, ?, ?, ?)`);
const ins = db.prepare('INSERT INTO engrams_fts(rowid, concept, content, tags) VALUES (?, ?, ?, ?)');
let n = 0, missing = 0;
db.transaction(() => {
  for (const [id, qs] of Object.entries(WQ.questions)) {
    if (!qs.length) continue;
    const r: any = row.get(id);
    if (!r) { missing++; continue; }
    del.run(r.rowid, r.concept, r.content, r.tags);
    ins.run(r.rowid, r.concept, r.content, `${r.tags ?? ''} ${qs.join(' ')}`);
    n++;
  }
})();
db.close();
console.log(`re-indexed ${n} memories with their questions (${missing} not found) -> ${out}`);
