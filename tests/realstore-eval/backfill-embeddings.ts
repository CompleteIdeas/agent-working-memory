/**
 * Re-embed a snapshot with the derived retrieval text (option 1).
 *
 * Runs ONLY against a snapshot copy — never the live store. Option 1's whole
 * claim is that it reaches the 7,350 memories already written without the
 * category vocabulary in their bodies, and that claim is only testable if the
 * existing corpus is actually re-embedded.
 *
 * Usage: AWM_RETRIEVAL_TEXT=1 npx tsx tests/realstore-eval/backfill-embeddings.ts <db>
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';

const DB = process.argv[2] ?? join(import.meta.dirname, 'snapshot', 'store-backfilled.db');
if (process.env.AWM_RETRIEVAL_TEXT !== '1') {
  console.error('refusing to run: AWM_RETRIEVAL_TEXT=1 must be set, or this would rewrite vectors identically');
  process.exit(1);
}
if (/packages[\/]awm[\/]memory\.db$/.test(DB)) {
  console.error('refusing to run against the LIVE store');
  process.exit(2);
}

// Static imports under tsx. The dynamic-import form failed under plain `node`
// (it cannot resolve a .ts source through a .js specifier) AND the wrapper
// still reported exit code 0 — a silent failure that left the copy unmodified.
import { embed } from '../../src/core/embeddings.js';
import { buildRetrievalText, topicalTerms } from '../../src/core/retrieval-text.js';

const db = new Database(DB);
const LIMIT = Number(process.env.BACKFILL_LIMIT ?? 0);
const rows = db.prepare(`
  SELECT id, concept, content, tags FROM engrams
  WHERE stage='active' AND retracted=0 AND agent_id IN ('work','personal')
`).all().slice(0, LIMIT > 0 ? LIMIT : undefined);
const upd = db.prepare('UPDATE engrams SET embedding=? WHERE id=?');

let changed = 0, skipped = 0, n = 0;
const t0 = Date.now();
for (const r of rows) {
  n++;
  let tags = []; try { tags = JSON.parse(r.tags ?? '[]'); } catch { /* */ }
  // Only re-embed where the derived text actually differs — a no-op re-embed
  // burns minutes and risks changing vectors through float drift alone.
  if (topicalTerms(tags).length === 0) { skipped++; continue; }
  const vec = await embed(buildRetrievalText(r.concept, r.content, tags));
  upd.run(Buffer.from(new Float32Array(vec).buffer), r.id);
  changed++;
  if (n % 500 === 0) process.stderr.write(`  ${n}/${rows.length} (${changed} re-embedded)\r`);
}
db.close();
console.log(`\nre-embedded ${changed} of ${rows.length} (${skipped} had no topical tags) in ${((Date.now()-t0)/1000).toFixed(0)}s`);
