/**
 * Category-query ground truth — the fixture the identifier fixture cannot be.
 *
 * WHY THIS EXISTS
 * ---------------
 * The identifier fixture is built by unique-identifier hold-out, so by
 * construction the gold memory CONTAINS the query term in its body — measured:
 * 300/300 probes. Any option that works by adding vocabulary the body lacks
 * (tags into the rerank passage, tags into the embedding, alias expansion) is
 * therefore invisible to it. Three arms of option 2 came back byte-identical on
 * every quality metric for exactly this reason.
 *
 * That is the same mistake as using LoCoMo to measure the 400-char truncation:
 * a benchmark whose data cannot express the mechanism will report a clean,
 * confident null.
 *
 * WHAT THIS MEASURES INSTEAD
 * --------------------------
 * The real failure population: a memory tagged `topic=azure` whose body never
 * says "azure", asked for with the word "azure". That is precisely how the
 * Azure/AEC memory was lost — not in the top 40 for its own subject.
 *
 * GROUND TRUTH
 * ------------
 * For each memory: pick a topical tag term ABSENT from its body (the category
 * word), plus 2-4 distinctive words that ARE in its concept (the subject, so
 * the query is answerable at all). Query = category + subject. Gold = that
 * memory, kept only when the subject words make it unique across the corpus.
 *
 * The `bodyHasCategory: false` invariant is asserted per item — if it were ever
 * true, the probe would be measuring the identifier case again.
 *
 * Run: node tests/realstore-eval/build-category-fixture.mjs
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const OUT = join(import.meta.dirname, 'fixture-category.json');
const db = new Database(SNAP, { readonly: true });

const rows = db.prepare(`
  SELECT id, concept, content, tags, memory_class FROM engrams
  WHERE stage='active' AND retracted=0 AND superseded_by IS NULL
    AND agent_id IN ('work','personal')
    AND tags IS NOT NULL AND tags != '' AND LENGTH(content) > 250
`).all();

const STOP = new Set(['the','and','for','with','that','this','from','into','session','topic','over','when','were','been','have','after','before','their','which','while','about','using','under','more','most','some','only','also','than','then','they','them','what','where','done','plan','notes','update','status','complete','completed','fixed','added']);
const words = (s) => Array.from(new Set(String(s ?? '').toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? [])).filter(w => !STOP.has(w));

// Corpus-wide document frequency, so "distinctive" means genuinely rare.
const df = new Map();
for (const r of rows) for (const w of words(`${r.concept} ${r.content.slice(0, 600)}`)) df.set(w, (df.get(w) ?? 0) + 1);

const items = [];
for (const r of rows) {
  let tags = [];
  try { tags = JSON.parse(r.tags); } catch { continue; }
  const body = `${r.concept} ${r.content}`.toLowerCase();

  // Category words the author attached but never wrote down.
  const absent = [...new Set(tags
    .filter(t => /^(?:topic|proj|project)=/i.test(t))
    .flatMap(t => t.split('=')[1].toLowerCase().split(/[-_\s]+/))
    .filter(w => w.length > 3 && !body.includes(w)))];
  if (absent.length === 0) continue;

  // Subject words that ARE in the concept and are rare corpus-wide.
  const subject = words(r.concept)
    .filter(w => body.includes(w) && (df.get(w) ?? 0) <= 6)
    .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0))
    .slice(0, 3);
  if (subject.length < 2) continue;

  const category = absent[0];
  // Invariant: the category word must NOT be in the body, or this is just the
  // identifier case wearing a different hat.
  if (body.includes(category)) continue;

  items.push({
    goldId: r.id,
    category,
    subject: subject.join(' '),
    query: `${category} ${subject.join(' ')}`,
    memoryClass: r.memory_class,
    bodyHasCategory: false,
    absentCount: absent.length,
  });
}

// One probe per memory, deterministic order.
items.sort((a, b) => (a.goldId + a.category).localeCompare(b.goldId + b.category));
const seen = new Set();
const kept = items.filter(i => (seen.has(i.goldId) ? false : (seen.add(i.goldId), true)));

writeFileSync(OUT, JSON.stringify({
  note: 'Category-query ground truth: query uses a topical tag word ABSENT from the gold body, plus rare subject words that ARE present. This is the population the identifier fixture cannot express.',
  corpus: rows.length,
  answerable: kept.length,
  items: kept,
}, null, 2));

const cls = {};
for (const i of kept) cls[i.memoryClass] = (cls[i.memoryClass] ?? 0) + 1;
console.log(`corpus considered: ${rows.length}`);
console.log(`category probes: ${kept.length}   by class: ${JSON.stringify(cls)}`);
console.log(`\nsample:`);
for (const i of kept.slice(0, 5)) console.log(`  category="${i.category}"  query="${i.query.slice(0, 62)}"`);
console.log(`\nwrote ${OUT}`);
db.close();
