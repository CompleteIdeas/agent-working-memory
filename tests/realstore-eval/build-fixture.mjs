/**
 * Derive verifiable ground truth from the real store — no human labelling.
 *
 * THE PROBLEM WITH THE OBVIOUS SOURCES
 * ------------------------------------
 * The live store logs 12,165 real recalls (`activation_events`) and 870
 * feedback rows (`retrieval_feedback`). Neither is usable as ground truth:
 *  - activation_events records what WAS returned, so scoring against it is
 *    circular — it would reward agreeing with the current ranker and penalise
 *    any improvement.
 *  - retrieval_feedback is 860 useful=1 vs 10 useful=0 across just 41 distinct
 *    contexts, and its content is synthetic test data. No discriminative signal.
 *
 * THE APPROACH THAT WORKS: UNIQUE-IDENTIFIER HOLD-OUT
 * ---------------------------------------------------
 * An identifier that appears in exactly ONE active engram gives an unambiguous
 * correct answer, verifiable mechanically. Real memories are dense with them —
 * AWM's own writing guidance tells authors to include "the literal terms a
 * future query will use". Uniqueness is confirmed through FTS, i.e. the actual
 * retrieval path, not a regex guess.
 *
 * Crucially this also records the identifier's CHARACTER OFFSET inside the
 * memory, so the truncation cliff can be measured on REAL data rather than on
 * the synthetic corpus in tests/longmem-eval.
 *
 * Queries imitate the real register, which is keyword-dense rather than
 * natural-language: real examples from this store include "esignature
 * reconciliation phase 4 telemetry" and "equihub workspace assignment
 * coordination hive". Polite questions would be an unrepresentative test.
 *
 * Adversarial probes are included so SELECTIVITY SCORES POSITIVELY — the
 * opposite of LoCoMo, which penalises the salience filter that is the product.
 *
 * Output: fixture.json — queries + expected ids + offsets. Small, and carries
 * no memory bodies, so it is safe to commit while the snapshot is not.
 *
 * Run: node tests/realstore-eval/build-fixture.mjs
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const OUT = join(import.meta.dirname, 'fixture.json');
const db = new Database(SNAP, { readonly: true });

// Real work agents only. UUID agent spaces are the unpinned fallback and carry
// eval/test traffic ("chord progression harmony tension"); including them would
// reintroduce exactly the synthetic-data problem we are trying to leave behind.
const AGENTS = ['work', 'personal'];
const rows = db.prepare(`
  SELECT id, agent_id, concept, content, memory_class, tags
  FROM engrams
  WHERE stage='active' AND retracted=0 AND superseded_by IS NULL
    AND agent_id IN (${AGENTS.map(() => '?').join(',')})
    AND LENGTH(content) > 200
`).all(...AGENTS);

// Identifier shapes that a future query would plausibly use verbatim.
const IDENT = /\b(?:[a-z][a-z0-9_]*\.[a-z0-9_]{2,}(?:\.[a-z0-9_]+)*|[a-z][a-z0-9]*_[a-z0-9_]{4,}|[A-Z]{4,}[0-9]{4,}|[a-z-]+\.(?:com|org|net|io|dev)\b[a-z0-9./-]*)\b/g;

// Too generic to be a fair target even if technically unique in the corpus.
const GENERIC = new Set([
  'req.query', 'res.json', 'req.body', 'res.status', 'console.log', 'process.env',
  'package.json', 'index.ts', 'main.ts', 'app.ts', 'utils.ts', 'types.ts',
  'service.md', 'readme.md', 'string.length', 'array.length', 'object.keys',
]);

const occur = new Map();          // identifier -> Set(engramId)
const where = new Map();          // engramId -> Map(identifier -> offset)
for (const r of rows) {
  const hay = `${r.concept ?? ''}\n${r.content ?? ''}`;
  const lower = hay.toLowerCase();
  const found = new Set((hay.match(IDENT) ?? []).map(s => s.toLowerCase()));
  for (const tok of found) {
    if (tok.length < 8 || GENERIC.has(tok)) continue;
    if (!occur.has(tok)) occur.set(tok, new Set());
    occur.get(tok).add(r.id);
    if (!where.has(r.id)) where.set(r.id, new Map());
    where.get(r.id).set(tok, lower.indexOf(tok));
  }
}

const byId = new Map(rows.map(r => [r.id, r]));
const ftsCount = db.prepare(`SELECT COUNT(*) c FROM engrams_fts f JOIN engrams e ON e.rowid=f.rowid
  WHERE engrams_fts MATCH ? AND e.stage='active' AND e.retracted=0`);

/** Keyword-register query: salient concept words + the identifier. */
function makeQuery(concept, ident) {
  const words = (concept ?? '')
    .replace(/[^A-Za-z0-9 _.-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !/^\d+$/.test(w))
    .slice(0, 6)
    .join(' ');
  return `${words} ${ident}`.trim();
}

const items = [];
for (const [tok, ids] of occur) {
  if (ids.size !== 1) continue;                       // must be unambiguous
  const gold = [...ids][0];
  const r = byId.get(gold);
  if (!r) continue;

  // Confirm uniqueness through the ACTUAL retrieval index, not just the regex.
  let c;
  try { c = ftsCount.get(`"${tok.replace(/"/g, '')}"`).c; } catch { continue; }
  if (c !== 1) continue;

  const offset = where.get(gold)?.get(tok) ?? -1;
  if (offset < 0) continue;

  items.push({
    query: makeQuery(r.concept, tok),
    goldId: gold,
    identifier: tok,
    offset,
    contentLen: (r.content ?? '').length,
    memoryClass: r.memory_class ?? 'working',
    agent: r.agent_id,
    beyondTruncation: offset > 400,     // the cliff this store actually faces
  });
}

// Deterministic order, then cap per-engram so a few identifier-dense memories
// cannot dominate the score.
items.sort((a, b) => (a.goldId + a.identifier).localeCompare(b.goldId + b.identifier));
const perGold = new Map();
const kept = items.filter(i => {
  const n = perGold.get(i.goldId) ?? 0;
  if (n >= 2) return false;
  perGold.set(i.goldId, n + 1);
  return true;
});

// Adversarial probes: plausible in register, absent from the store. Correct
// behaviour is to return nothing — selectivity scores POSITIVELY here.
const adversarial = [
  'kubernetes helm chart rollback strategy staging cluster',
  'swift ios push notification entitlement provisioning profile',
  'rust borrow checker lifetime annotation generic trait',
  'terraform state lock dynamodb backend migration',
  'redis cluster resharding slot migration failover',
  'graphql schema stitching federation gateway resolver',
  'elasticsearch analyzer tokenizer synonym filter mapping',
  'kafka consumer group offset commit rebalance protocol',
  'webpack module federation remote entry chunk splitting',
  'flutter widget state lifecycle dispose controller',
].map(q => ({ query: q, goldId: null, identifier: null, adversarial: true }));

const fixture = {
  generated: 'unique-identifier hold-out over a frozen snapshot of the live store',
  corpusEngrams: rows.length,
  answerable: kept.length,
  adversarial: adversarial.length,
  beyondTruncation: kept.filter(i => i.beyondTruncation).length,
  items: kept,
  adversarialItems: adversarial,
};
writeFileSync(OUT, JSON.stringify(fixture, null, 2));

const cls = {};
for (const i of kept) cls[i.memoryClass] = (cls[i.memoryClass] ?? 0) + 1;

console.log(`corpus (work+personal, active, >200 chars): ${rows.length}`);
console.log(`answerable probes: ${kept.length}   adversarial: ${adversarial.length}`);
console.log(`  by memory_class: ${JSON.stringify(cls)}`);
console.log(`  identifier BEYOND the 400-char rerank window: ${fixture.beyondTruncation}` +
            ` (${(100 * fixture.beyondTruncation / Math.max(kept.length, 1)).toFixed(1)}%)`);
console.log(`\nwrote ${OUT}`);
db.close();
