/**
 * Mine directional category→dialect aliases from the store, offline.
 *
 * THE PROBLEM THIS TARGETS
 * ------------------------
 * A memory tagged `topic=azure` whose body says "private plan… P1v3… app
 * service" but never "azure". The author's later question uses "azure". Nothing
 * in the store's vocabulary connects the two — and no general-purpose model can
 * know that connection, because it is local to this project. It IS, however,
 * recoverable from the store itself: memories tagged `azure` share body
 * vocabulary that memories in general do not.
 *
 * WHY NOT GENERIC CO-OCCURRENCE
 * -----------------------------
 * Raw co-occurrence learns "plan"↔"capacity" and "private"↔half the domain.
 * Expanding a query on those explodes the BM25 candidate set toward frequent
 * generic memories — and that is worse HERE than in generic IR for two measured
 * reasons: the rerank passage is 400-char truncated, and phase 9b made
 * rerankerScore authoritative, so a poisoned candidate pool becomes a
 * final-ordering failure rather than a mild precision cost.
 *
 * So this mines with all five guardrails agreed at the decision fork:
 *   1. PMI threshold, not raw counts — a term must be genuinely surprising
 *      inside the tagged set relative to the corpus.
 *   2. Max fan-out per category — a bounded, inspectable list.
 *   3. DIRECTIONAL: category → dialect only. The reverse ("plan" → "azure")
 *      is what floods, because dialect words are common.
 *   4. Minimum support — a category needs enough memories for PMI to mean
 *      anything.
 *   5. Stopword and self-exclusion, so a category never aliases to itself or
 *      to structural noise.
 *
 * Output is a plain JSON map: inspectable, cappable, diffable. No model, no
 * network, no query-time cost beyond a lookup.
 *
 * Run: npx tsx tests/realstore-eval/mine-aliases.ts
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const OUT = join(import.meta.dirname, '..', '..', 'data', 'alias-map.json');

const MIN_SUPPORT = Number(process.env.ALIAS_MIN_SUPPORT ?? 8);   // memories per category
const MIN_PMI = Number(process.env.ALIAS_MIN_PMI ?? 1.5);          // log2 lift
const MAX_FANOUT = Number(process.env.ALIAS_MAX_FANOUT ?? 6);      // terms per category
const MIN_TERM_DF = Number(process.env.ALIAS_MIN_TERM_DF ?? 3);    // ignore hapax noise

const db = new Database(SNAP, { readonly: true });
const rows = db.prepare(`
  SELECT concept, content, tags FROM engrams
  WHERE stage='active' AND retracted=0 AND superseded_by IS NULL
    AND agent_id IN ('work','personal') AND tags IS NOT NULL AND tags != ''
`).all() as Array<{ concept: string; content: string; tags: string }>;

const STOP = new Set(['the','and','for','with','that','this','from','into','over','when','were','been','have','after','before','their','which','while','about','using','under','more','most','some','only','also','than','then','they','them','what','where','session','topic','notes','update','status','done','todo','work','item','items','also','been','will','would','could','should','made','make','need','needs','used','use']);
const terms = (s: string) => new Set(
  (String(s ?? '').toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []).filter(w => !STOP.has(w)));

// Corpus document frequency.
const docCount = rows.length;
const df = new Map<string, number>();
const docTerms: Array<Set<string>> = [];
const docCats: Array<string[]> = [];
for (const r of rows) {
  const t = terms(`${r.concept} ${r.content.slice(0, 1200)}`);
  docTerms.push(t);
  for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
  let tags: string[] = [];
  try { tags = JSON.parse(r.tags); } catch { /* */ }
  docCats.push([...new Set(tags
    .filter(x => /^(?:topic|proj|project)=/i.test(x))
    .flatMap(x => x.split('=')[1].toLowerCase().split(/[-_\s]+/))
    .filter(w => w.length > 3))]);
}

// Per-category term counts.
const catDocs = new Map<string, number>();
const catTermCount = new Map<string, Map<string, number>>();
for (let i = 0; i < rows.length; i++) {
  for (const c of docCats[i]) {
    catDocs.set(c, (catDocs.get(c) ?? 0) + 1);
    let m = catTermCount.get(c);
    if (!m) { m = new Map(); catTermCount.set(c, m); }
    for (const w of docTerms[i]) m.set(w, (m.get(w) ?? 0) + 1);
  }
}

const map: Record<string, string[]> = {};
let considered = 0, kept = 0;
for (const [cat, nCat] of catDocs) {
  if (nCat < MIN_SUPPORT) continue;
  considered++;
  const m = catTermCount.get(cat)!;
  const scored: Array<{ w: string; pmi: number; n: number }> = [];
  for (const [w, nBoth] of m) {
    if (w === cat) continue;                     // guardrail 5: no self-alias
    const dfw = df.get(w) ?? 0;
    if (dfw < MIN_TERM_DF) continue;             // hapax noise
    // PMI: how surprising is this term INSIDE the tagged set vs the corpus.
    const pJoint = nBoth / nCat;
    const pMarg = dfw / docCount;
    const pmi = Math.log2(pJoint / pMarg);
    if (pmi < MIN_PMI) continue;                 // guardrail 1
    if (nBoth < Math.max(2, nCat * 0.25)) continue; // must be typical of the category
    scored.push({ w, pmi, n: nBoth });
  }
  if (scored.length === 0) continue;
  scored.sort((a, b) => b.pmi - a.pmi || b.n - a.n);
  const picked = scored.slice(0, MAX_FANOUT).map(s => s.w);   // guardrail 2
  if (picked.length) { map[cat] = picked; kept++; }            // guardrail 3: directional
}

// ── GUARDRAIL 6 (added after inspecting the first mined map) ──
// The first run learned `profile -> discussed, turns, topics, summary` and
// `agent -> discussed, turns, topics, summary`. That is session-summary
// BOILERPLATE leaking in as "dialect": structural vocabulary shared across
// unrelated categories. Those are exactly the hub aliases that flood a
// candidate pool. A term that is "distinctive" of many different categories is
// by definition not distinctive of any of them.
const aliasUse = new Map<string, number>();
for (const list of Object.values(map)) for (const w of list) aliasUse.set(w, (aliasUse.get(w) ?? 0) + 1);
const HUB_LIMIT = Number(process.env.ALIAS_HUB_LIMIT ?? 5);
const hubs = [...aliasUse.entries()].filter(([, n]) => n > HUB_LIMIT).map(([w]) => w);
const hubSet = new Set(hubs);
let hubDropped = 0;
for (const c of Object.keys(map)) {
  const before = map[c].length;
  map[c] = map[c].filter(w => !hubSet.has(w));
  hubDropped += before - map[c].length;
  if (map[c].length === 0) delete map[c];
}
// A pure number ("2026") is a date fragment, not a category.
let numDropped = 0;
for (const c of Object.keys(map)) if (/^\d+$/.test(c)) { delete map[c]; numDropped++; }

console.log(`hub terms dropped (aliased >${HUB_LIMIT} categories): ${hubs.length} distinct, ${hubDropped} entries`);
console.log(`  hubs: ${hubs.slice(0, 12).join(', ')}`);
console.log(`numeric categories dropped: ${numDropped}`);

writeFileSync(OUT, JSON.stringify({
  note: 'Directional category->dialect aliases mined offline. Expansion must still require at least one ORIGINAL query term to match a candidate (guardrail 4, enforced at query time).',
  params: { MIN_SUPPORT, MIN_PMI, MAX_FANOUT, MIN_TERM_DF },
  corpus: docCount,
  categories: Object.keys(map).length,
  hubTermsDropped: hubs.length,
  map,
}, null, 2));

console.log(`corpus ${docCount} tagged memories`);
console.log(`categories with >=${MIN_SUPPORT} memories: ${considered}   with usable aliases: ${kept}`);
console.log(`\nsample aliases:`);
for (const c of Object.keys(map).slice(0, 8)) console.log(`  ${c.padEnd(16)} -> ${map[c].join(', ')}`);
console.log(`\nwrote ${OUT}`);
db.close();
