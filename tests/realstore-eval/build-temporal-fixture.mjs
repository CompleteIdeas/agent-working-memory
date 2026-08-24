/**
 * Temporal ground truth from the real store.
 *
 * THE GAP THIS MEASURES
 * ---------------------
 * `ActivationQuery` has no date filter of any kind, and no stage of the
 * pipeline parses dates out of the query text. So "azure app plan from last
 * Thursday or Friday" spends "last"/"Thursday"/"Friday" as ordinary BM25
 * tokens — they match nothing useful and add noise. The temporal cue, which is
 * often the single most selective thing the user said, is discarded.
 *
 * Observed cost (2026-08-24): a memory written on Friday 2026-08-21 was NOT in
 * the top 40 candidates for its own subject. A date-range SQL filter over the
 * same store found it instantly — 11,294 active memories narrow to 433 for that
 * week, and to exactly ONE once the subject is added.
 *
 * Corroborating: temporal is the worst category in BOTH prior benchmarks —
 * 5.7% success@1 and 17% lost-at-candidate-floor on the LoCoMo tracer, roughly
 * 5x the floor-loss of any other category.
 *
 * HOW GROUND TRUTH IS DERIVED
 * ---------------------------
 * Same trick as the identifier fixture: make the answer mechanically
 * verifiable. Pick memories that are UNIQUELY identifiable by subject within
 * their week, then ask for them the way a person would — subject words plus a
 * temporal cue. The gold is unambiguous because no other memory that week
 * matches the subject.
 *
 * Relative phrases ("last Thursday") are meaningless without an anchor, and a
 * static fixture cannot use the wall clock — a run next month would silently
 * change what every query means. So each item records `asOf`, and relative
 * phrasing is generated against that, not against Date.now().
 *
 * Run: node tests/realstore-eval/build-temporal-fixture.mjs
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const OUT = join(import.meta.dirname, 'fixture-temporal.json');
const db = new Database(SNAP, { readonly: true });

const rows = db.prepare(`
  SELECT id, agent_id, concept, content, created_at, memory_class
  FROM engrams
  WHERE stage='active' AND retracted=0 AND superseded_by IS NULL
    AND agent_id IN ('work','personal')
    AND LENGTH(content) > 300
    AND created_at >= '2026-05-01'
  ORDER BY created_at
`).all();

const STOP = new Set(['the','and','for','with','that','this','from','into','session','topic','over','plus','when','were','been','have','after','before','their','which','while','about','using','under','more','most','some','only','also','than','then','they','them','what','where']);
const words = (s) => Array.from(new Set(String(s ?? '').toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? [])).filter(w => !STOP.has(w));

/** ISO week key, so "that week" is a well-defined bucket. */
const weekKey = (iso) => {
  const d = new Date(iso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil((((t - y0) / 86400000) + 1) / 7)).padStart(2, '0')}`;
};

// Bucket by week, then keep only memories whose subject words make them unique
// within that week — that is what makes the temporal answer unambiguous.
const byWeek = new Map();
for (const r of rows) {
  const k = weekKey(r.created_at);
  if (!byWeek.has(k)) byWeek.set(k, []);
  byWeek.get(k).push(r);
}

const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const items = [];
for (const [wk, group] of byWeek) {
  if (group.length < 2) continue;                     // need real competition
  for (const r of group) {
    const mine = words(r.concept);
    if (mine.length < 3) continue;
    const others = new Set(group.filter(o => o.id !== r.id).flatMap(o => words(o.concept + ' ' + o.content.slice(0, 400))));
    const distinctive = mine.filter(w => !others.has(w));
    if (distinctive.length < 2) continue;             // not uniquely askable that week

    const d = new Date(r.created_at);
    const subject = distinctive.slice(0, 4).join(' ');
    items.push({
      goldId: r.id,
      subject,
      createdAt: r.created_at,
      week: wk,
      memoryClass: r.memory_class,
      // asOf is the Monday after the memory's week, so "last <Day>" is well-defined.
      asOf: new Date(d.getTime() + (8 - (d.getUTCDay() || 7)) * 86400000).toISOString().slice(0, 10),
      phrasings: {
        none: subject,
        relativeDay: `${subject} from last ${DOW[d.getUTCDay()]}`,
        relativeWeek: `${subject} from last week`,
        absoluteDate: `${subject} on ${r.created_at.slice(0, 10)}`,
        absoluteMonth: `${subject} in ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      },
    });
  }
}

// Cap per week so a busy week cannot dominate.
const perWeek = new Map();
const kept = items.filter(i => {
  const n = perWeek.get(i.week) ?? 0;
  if (n >= 6) return false;
  perWeek.set(i.week, n + 1);
  return true;
});

writeFileSync(OUT, JSON.stringify({
  note: 'Temporal ground truth. Gold is unique-by-subject within its ISO week; asOf anchors relative phrasing so results stay reproducible over time.',
  corpus: rows.length,
  weeks: byWeek.size,
  answerable: kept.length,
  items: kept,
}, null, 2));

console.log(`corpus (work+personal, active, >300 chars, since 2026-05): ${rows.length}`);
console.log(`weeks covered: ${byWeek.size}`);
console.log(`temporal probes (unique-by-subject within their week): ${kept.length}`);
console.log(`\nsample:`);
for (const i of kept.slice(0, 4)) {
  console.log(`  ${i.createdAt.slice(0, 10)} [${i.week}] "${i.phrasings.relativeDay}"`);
}
console.log(`\nwrote ${OUT}`);
db.close();
