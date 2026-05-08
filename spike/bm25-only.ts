/**
 * Pure BM25 isolation — no embedding, no reranker, just FTS5 calls via better-sqlite3.
 * If this is fast, the problem is somewhere else in the recall pipeline.
 * If this is slow, the problem is FTS5 + better-sqlite3 interop.
 */
import Database from 'better-sqlite3';

const DB = process.env.AWM_DB_PATH ?? 'memory.db';
const AGENT = process.env.AWM_AGENT_ID ?? 'work';
const QUERIES = [
  '"USEF" OR "results" OR "submission" OR "Staff" OR "Services"',
  '"USEF" OR "results"',
  '"USEF"',
  '"Education" OR "LMS" OR "architecture" OR "programs" OR "certifications"',
];

function ms(start: bigint): number { return Number(process.hrtime.bigint() - start) / 1e6; }

const db = new Database(DB, { readonly: true, fileMustExist: true });

// Prepare statements once
const stmtFull = db.prepare(`
  SELECT e.*, rank FROM engrams e
  JOIN engrams_fts ON e.rowid = engrams_fts.rowid
  WHERE engrams_fts MATCH ? AND e.agent_id = ? AND e.retracted = 0
  ORDER BY rank LIMIT ?
`);
const stmtNoEmb = db.prepare(`
  SELECT e.id, e.concept, e.content, e.confidence, e.tags, rank FROM engrams e
  JOIN engrams_fts ON e.rowid = engrams_fts.rowid
  WHERE engrams_fts MATCH ? AND e.agent_id = ? AND e.retracted = 0
  ORDER BY rank LIMIT ?
`);
const stmtFtsOnly = db.prepare(`
  SELECT rowid, rank FROM engrams_fts WHERE engrams_fts MATCH ? ORDER BY rank LIMIT ?
`);

console.log(`\nbetter-sqlite3 BM25 isolation — db=${DB}, agent=${AGENT}\n`);
console.log('Q'.padEnd(60), 'full', 'no-emb', 'fts-only');
console.log('-'.repeat(90));

for (const q of QUERIES) {
  // Warm
  stmtFull.all(q, AGENT, 30);
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) stmtFull.all(q, AGENT, 30);
  const fullMs = ms(t1) / 5;

  const t2 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) stmtNoEmb.all(q, AGENT, 30);
  const noEmbMs = ms(t2) / 5;

  const t3 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) stmtFtsOnly.all(q, 30);
  const ftsOnlyMs = ms(t3) / 5;

  console.log(
    q.slice(0, 58).padEnd(60),
    fullMs.toFixed(1).padStart(6),
    noEmbMs.toFixed(1).padStart(6),
    ftsOnlyMs.toFixed(1).padStart(6),
  );
}

db.close();
