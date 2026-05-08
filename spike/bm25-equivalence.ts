/**
 * Verify the CTE-prefilter BM25 returns equivalent results to the old query.
 * Compares the SAME data, ranked the same way, with the only difference being
 * the SQL plan.
 */
import Database from 'better-sqlite3';

const DB = process.env.AWM_DB_PATH ?? 'memory.db';
const AGENT = process.env.AWM_AGENT_ID ?? 'work';
const QUERIES = [
  '"USEF" OR "results" OR "submission" OR "Staff" OR "Services"',
  '"Education" OR "LMS" OR "architecture" OR "programs" OR "certifications"',
  '"USEF" OR "results"',
  '"USEF"',
];

const db = new Database(DB, { readonly: true });

const oldStmt = db.prepare(`
  SELECT e.id, rank FROM engrams e
  JOIN engrams_fts ON e.rowid = engrams_fts.rowid
  WHERE engrams_fts MATCH ? AND e.agent_id = ? AND e.retracted = 0
  ORDER BY rank LIMIT ?
`);

const newStmt = db.prepare(`
  WITH top_fts AS (
    SELECT rowid, rank FROM engrams_fts WHERE engrams_fts MATCH ? ORDER BY rank LIMIT ?
  )
  SELECT e.id, top_fts.rank FROM top_fts
  JOIN engrams e ON e.rowid = top_fts.rowid
  WHERE e.agent_id = ? AND e.retracted = 0
  ORDER BY top_fts.rank LIMIT ?
`);

console.log(`\nBM25 equivalence check — db=${DB}, agent=${AGENT}\n`);

const LIMIT = 30;
let allMatch = true;

for (const q of QUERIES) {
  const oldRows = oldStmt.all(q, AGENT, LIMIT) as { id: string; rank: number }[];
  const innerLimit = Math.max(LIMIT * 5, 50);
  const newRows = newStmt.all(q, innerLimit, AGENT, LIMIT) as { id: string; rank: number }[];

  const oldSet = new Set(oldRows.map(r => r.id));
  const newSet = new Set(newRows.map(r => r.id));

  const onlyOld = [...oldSet].filter(id => !newSet.has(id));
  const onlyNew = [...newSet].filter(id => !oldSet.has(id));
  const both = [...oldSet].filter(id => newSet.has(id));

  // Top-5 ordering check (most-important comparison for recall quality)
  const top5Match = JSON.stringify(oldRows.slice(0, 5).map(r => r.id))
    === JSON.stringify(newRows.slice(0, 5).map(r => r.id));

  console.log(`Q: ${q.slice(0, 60)}`);
  console.log(`  old=${oldRows.length}  new=${newRows.length}  intersect=${both.length}  top5_same=${top5Match}`);
  if (onlyOld.length > 0) console.log(`  only-old: ${onlyOld.length}`);
  if (onlyNew.length > 0) console.log(`  only-new: ${onlyNew.length}`);
  if (oldRows.length > 0 && newRows.length > 0) {
    console.log(`  old top-3 ranks: ${oldRows.slice(0, 3).map(r => r.rank.toFixed(3)).join(', ')}`);
    console.log(`  new top-3 ranks: ${newRows.slice(0, 3).map(r => r.rank.toFixed(3)).join(', ')}`);
  }
  if (!top5Match) allMatch = false;
  console.log();
}

console.log(allMatch ? '✓ All top-5 results match' : '✗ Differences found in top-5');
db.close();
