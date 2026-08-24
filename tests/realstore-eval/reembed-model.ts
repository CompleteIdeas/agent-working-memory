/**
 * Re-embed a snapshot with a DIFFERENT embedding model (option 4).
 *
 * THE HAZARD THIS GUARDS AGAINST
 * ------------------------------
 * `cosineSimilarity` returns 0 when the two vectors differ in length
 * (embeddings.ts). So a PARTIAL migration — some memories at 768d, the rest
 * still at 384d — gives the un-migrated ones a silent zero on the vector
 * channel. The eval would then report a large drop and it would look like "the
 * bigger model is worse", when the real cause is a half-migrated corpus.
 *
 * That is the exact failure shape that has cost several iterations already
 * today, so completeness is ASSERTED here rather than assumed: the script exits
 * non-zero unless every active engram carries a vector of the expected width.
 *
 * Unlike the option-1 backfill this must re-embed EVERYTHING, not just memories
 * with topical tags — mixed dimensions are not a partial improvement, they are
 * a broken index.
 *
 * Usage:
 *   AWM_EMBED_MODEL=Xenova/bge-base-en-v1.5 AWM_EMBED_DIMS=768 \
 *     npx tsx tests/realstore-eval/reembed-model.ts <db>
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { embed } from '../../src/core/embeddings.js';

const DB = process.argv[2] ?? join(import.meta.dirname, 'snapshot', 'store-nomic.db');
const DIMS = Number(process.env.AWM_EMBED_DIMS ?? 0);
const MODEL = process.env.AWM_EMBED_MODEL ?? '';

if (!MODEL || !DIMS) {
  console.error('refusing to run: set AWM_EMBED_MODEL and AWM_EMBED_DIMS explicitly');
  process.exit(1);
}
if (/packages[\\/]awm[\\/]memory\.db$/.test(DB)) {
  console.error('refusing to run against the LIVE store');
  process.exit(2);
}

const db = new Database(DB);
// RESUMABLE: only rows that do not already carry a target-width vector.
// This job has been killed mid-run before, leaving a mixed-dimension corpus
// that scores 0 on the vector channel for everything un-migrated. Making it
// idempotent means repeated runs converge instead of restarting from zero.
const expectedBytesPre = Number(DIMS) * 4;
const rows = db.prepare(`
  SELECT id, concept, content FROM engrams
  WHERE stage='active' AND retracted=0 AND agent_id IN ('work','personal')
    AND (embedding IS NULL OR LENGTH(embedding) != ?)
`).all(expectedBytesPre) as Array<{ id: string; concept: string; content: string }>;
const already = (db.prepare(`
  SELECT COUNT(*) c FROM engrams
  WHERE stage='active' AND retracted=0 AND agent_id IN ('work','personal')
    AND LENGTH(embedding) = ?
`).get(expectedBytesPre) as { c: number }).c;
if (already > 0) console.log(`resuming: ${already} already migrated, ${rows.length} remaining`);
const upd = db.prepare('UPDATE engrams SET embedding=? WHERE id=?');

console.log(`re-embedding ${rows.length} engrams with ${MODEL} (${DIMS}d)`);
const t0 = Date.now();
let done = 0, failed = 0;
for (const r of rows) {
  try {
    const vec = await embed(`${r.concept} ${r.content}`);
    if (vec.length !== DIMS) {
      console.error(`\nFATAL: model returned ${vec.length}d, expected ${DIMS}d — check AWM_EMBED_DIMS`);
      process.exit(3);
    }
    upd.run(Buffer.from(new Float32Array(vec).buffer), r.id);
    done++;
  } catch (e) {
    failed++;
    if (failed <= 3) console.error(`\n  embed failed for ${r.id}: ${(e as Error).message}`);
  }
  if (done % 500 === 0) process.stderr.write(`  ${done}/${rows.length}\r`);
}
console.log(`\nre-embedded ${done}, failed ${failed}, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ── COMPLETENESS ASSERTION ──
// Mixed dimensions silently zero the vector channel for un-migrated memories.
const expectedBytes = DIMS * 4;
const bad = db.prepare(`
  SELECT COUNT(*) c FROM engrams
  WHERE stage='active' AND retracted=0 AND agent_id IN ('work','personal')
    AND (embedding IS NULL OR LENGTH(embedding) != ?)
`).get(expectedBytes) as { c: number };
db.close();

if (bad.c > 0) {
  console.error(`\nFATAL: ${bad.c} active engrams do NOT carry a ${DIMS}d vector.`);
  console.error('A mixed-dimension corpus scores 0 on the vector channel for the un-migrated');
  console.error('rows, which would read as "the model is worse". Refusing to bless this snapshot.');
  process.exit(4);
}
console.log(`completeness verified: all active engrams carry ${DIMS}d (${expectedBytes}-byte) vectors`);
