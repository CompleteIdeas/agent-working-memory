/**
 * Statistical study for abstention: which signals separate "the store has this" from "it
 * does not", and does a store-calibrated noise floor beat the shape-only confidence gate?
 *
 * Three populations, so no signal can win by how a fixture was built:
 *   answerable      identifier (300) + topic (450) probes against the intact snapshot
 *   absent-new      fixture-absent.json + the 10 adversarial probes: facts whose
 *                   distinctive words never occur in the store
 *   absent-familiar 200 topic probes asked against a copy of the store from which each
 *                   probe's gold memory was DELETED: every query word still exists nearby,
 *                   only the fact is gone. A vocabulary test cannot catch these.
 *
 * Per probe it records the per-channel signals of the top results (reranker, vector, text,
 * composite, margins), the confidence the shipped gate computes, and query-vocabulary rarity
 * (document frequency of the query's rarest term). It reports, per feature, the AUC for
 * answerable vs each absent population, then evaluates a noise-floor rule calibrated on half
 * the absent probes and tested on the other half.
 *
 *   npx tsx tests/realstore-eval/abstention-features.ts
 */
import Database from 'better-sqlite3';
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const SNAP = join(dir, 'snapshot', 'store.db');
const seeded = <T,>(arr: T[], seed = 1337): T[] => {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const ident = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'));
const cat = JSON.parse(readFileSync(join(dir, 'fixture-category.json'), 'utf8'));
const absent = JSON.parse(readFileSync(join(dir, 'fixture-absent.json'), 'utf8'));

type Pop = 'answerable' | 'absent-new' | 'absent-familiar';
type P = { pop: Pop; query: string; goldId: string | null; agent: string };
const topics = seeded(cat.items as any[]);
const answerable: P[] = [
  ...seeded(ident.items as any[]).slice(0, 300).map((i) => ({ pop: 'answerable' as Pop, query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
  ...topics.map((i) => ({ pop: 'answerable' as Pop, query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
];
const absentNew: P[] = [
  ...(absent.items as any[]).map((i) => ({ pop: 'absent-new' as Pop, query: i.query, goldId: null, agent: 'work' })),
  ...(ident.adversarialItems as any[]).map((i) => ({ pop: 'absent-new' as Pop, query: i.query, goldId: null, agent: 'work' })),
];
// absent-familiar: the LAST 200 topic probes in seeded order, golds deleted from a copy.
const familiar = topics.slice(-200);
const absentFamiliar: P[] = familiar.map((i) => ({ pop: 'absent-familiar' as Pop, query: i.query, goldId: null, agent: i.agent ?? 'work' }));

const now = Date.parse('2026-08-24T09:27:21.841Z');
const STOP = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that'.split(' '));

type Rec = P & {
  top1Correct: boolean; n: number; conf: number | null;
  rr1: number; rr2: number; vec1: number; txt1: number; comp1: number; comp2: number;
  minDf: number; zeroDfTerms: number;
};

async function run(dbFile: string, probes: P[], deleteIds: string[] = []): Promise<Rec[]> {
  const work = join(tmpdir(), `awm-feat-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  copyFileSync(dbFile, work);
  if (deleteIds.length) {
    const d = new Database(work);
    const del = d.prepare('DELETE FROM engrams WHERE id = ?');
    d.transaction(() => { for (const id of deleteIds) del.run(id); })();
    d.close();
  }
  const df = new Database(work, { readonly: true });
  const dfOf = (t: string): number => {
    try { return (df.prepare(`SELECT count(*) AS n FROM engrams_fts WHERE engrams_fts MATCH ?`).get(`"${t}"`) as any).n; } catch { return 0; }
  };
  const store = new EngramStore(work);
  const eng = new ActivationEngine(store as any);
  const out: Rec[] = [];
  for (const p of probes) {
    const base = { internal: true, now, asOf: now, agentId: p.agent, context: p.query, limit: 10, minScore: 0.05 } as any;
    const res: any[] = await eng.activate({ ...base, requireConfidence: 0 });
    let conf: number | null = null;
    await eng.activate({ ...base, requireConfidence: 1.5, onAbstain: (i: any) => { conf = i.confidence; } });
    const terms = [...new Set((p.query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t)))];
    const dfs = terms.map(dfOf);
    const ps = (k: number) => res[k]?.phaseScores ?? {};
    out.push({
      ...p, top1Correct: !!p.goldId && res[0]?.engram.id === p.goldId, n: res.length, conf,
      rr1: ps(0).rerankerScore ?? 0, rr2: ps(1).rerankerScore ?? 0, vec1: ps(0).vectorMatch ?? 0, txt1: ps(0).textMatch ?? 0,
      comp1: res[0]?.score ?? 0, comp2: res[1]?.score ?? 0,
      minDf: dfs.length ? Math.min(...dfs) : 0, zeroDfTerms: dfs.filter((x) => x === 0).length,
    });
  }
  store.close(); df.close();
  return out;
}

const recs = [
  ...(await run(SNAP, [...answerable, ...absentNew])),
  ...(await run(SNAP, absentFamiliar, familiar.map((i: any) => i.goldId))),
];
writeFileSync(join(tmpdir(), 'awm-abstention-features.json'), JSON.stringify(recs));

// ── Separability ─────────────────────────────────────────────────────────────
// AUC: probability a random answerable probe scores HIGHER than a random absent one.
function auc(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
const A = recs.filter((r) => r.pop === 'answerable');
const N = recs.filter((r) => r.pop === 'absent-new');
const F = recs.filter((r) => r.pop === 'absent-familiar');
const features: Record<string, (r: Rec) => number> = {
  'shipped confidence': (r) => r.conf ?? 0,
  'top reranker': (r) => r.rr1,
  'reranker margin #1-#2': (r) => r.rr1 - r.rr2,
  'top vector match': (r) => r.vec1,
  'top text match': (r) => r.txt1,
  'top composite': (r) => r.comp1,
  'composite margin': (r) => r.comp1 - r.comp2,
  'rarest query term df (log)': (r) => Math.log1p(r.minDf),
  'no zero-df query term': (r) => (r.zeroDfTerms === 0 ? 1 : 0),
};
console.log(`\nn: answerable ${A.length} · absent-new ${N.length} · absent-familiar ${F.length}`);
console.log('AUC (1.0 = perfect separation, 0.5 = chance)        vs absent-new   vs absent-familiar');
for (const [name, f] of Object.entries(features)) {
  console.log(`  ${name.padEnd(30)}              ${auc(A.map(f), N.map(f)).toFixed(3)}          ${auc(A.map(f), F.map(f)).toFixed(3)}`);
}

// ── By query type: does one global gate fit, or does each register need its own? ──
// identifier: carries a code-like token (dots, underscores, digits, camelCase, slashes)
// question:   natural language (starts with a question word, or ends in ?)
// keywords:   everything else — a bag of topic words
const qtype = (q: string): string =>
  /\b[\w-]*[._/][\w./-]+\b|\b\w*\d\w*\b|\b[a-z]+[A-Z]\w*\b/.test(q) ? 'identifier'
    : /^(what|how|why|when|where|which|who|is|are|does|do|can|should)\b/i.test(q.trim()) || q.trim().endsWith('?') ? 'question'
      : 'keywords';
console.log('\nBY QUERY TYPE — AUC of top reranker (answerable vs all absent), and each type\'s own noise floor');
for (const t of ['identifier', 'question', 'keywords']) {
  const a = A.filter((r) => qtype(r.query) === t);
  const z = [...N, ...F].filter((r) => qtype(r.query) === t);
  if (a.length < 10 || z.length < 10) { console.log(`  ${t.padEnd(11)} answerable ${a.length}, absent ${z.length} — too few to measure`); continue; }
  const f = features['top reranker']!;
  const zs = z.map(f).sort((x, y) => x - y);
  const p90 = zs[Math.floor(0.9 * zs.length)]!;
  const keep = a.filter((r) => r.top1Correct && f(r) > p90).length;
  console.log(`  ${t.padEnd(11)} answerable ${String(a.length).padStart(3)} · absent ${String(z.length).padStart(3)} · AUC ${auc(a.map(f), z.map(f)).toFixed(3)}`
    + ` · noise p90 ${p90.toFixed(3)} · correct kept above it ${keep}/${a.filter((r) => r.top1Correct).length}`);
}

// ── Graded signal: what fraction of each band is right, wrong, or absent? ─────
// z = (top reranker − mean of the absent distribution) / its std: "how many σ above this
// store's noise". The question for a graded answer is what each band actually holds.
{
  const f = features['top reranker']!;
  const zs = [...N, ...F].map(f);
  const mu = zs.reduce((s, v) => s + v, 0) / zs.length;
  const sd = Math.sqrt(zs.reduce((s, v) => s + (v - mu) ** 2, 0) / zs.length) || 1;
  console.log(`\nGRADED SIGNAL — z = (top reranker − absent mean ${mu.toFixed(3)}) / absent sd ${sd.toFixed(3)}`);
  const bands: Array<[string, number, number]> = [['z < 0 (at or below noise)', -Infinity, 0], ['0 ≤ z < 1', 0, 1], ['1 ≤ z < 2', 1, 2], ['2 ≤ z < 3', 2, 3], ['z ≥ 3', 3, Infinity]];
  for (const [label, lo, hi] of bands) {
    const inBand = recs.filter((r) => { const z = (f(r) - mu) / sd; return z >= lo && z < hi; });
    const right = inBand.filter((r) => r.pop === 'answerable' && r.top1Correct).length;
    const wrong = inBand.filter((r) => r.pop === 'answerable' && !r.top1Correct).length;
    const abs = inBand.filter((r) => r.pop !== 'answerable').length;
    console.log(`  ${label.padEnd(26)} n=${String(inBand.length).padStart(4)}  correct ${String(right).padStart(4)}  wrong-but-answerable ${String(wrong).padStart(3)}  absent ${String(abs).padStart(3)}`);
  }
}

// ── Noise floor, calibrated on half the absent probes, tested on the rest ─────
const half = <T,>(xs: T[]) => [xs.filter((_, i) => i % 2 === 0), xs.filter((_, i) => i % 2 === 1)];
const [Ncal, Ntest] = half(N); const [Fcal, Ftest] = half(F);
const null_ = [...Ncal, ...Fcal];
for (const [name, f] of Object.entries({ 'top reranker': features['top reranker']!, 'shipped confidence': features['shipped confidence']! })) {
  const nullScores = null_.map(f).sort((a, b) => a - b);
  for (const pctl of [0.5, 0.75, 0.9, 0.95]) {
    const floor = nullScores[Math.min(nullScores.length - 1, Math.floor(pctl * nullScores.length))]!;
    const speaks = (r: Rec) => r.n > 0 && f(r) > floor;
    const kept = A.filter((r) => r.top1Correct && speaks(r)).length;
    const base = A.filter((r) => r.top1Correct).length;
    console.log(`  noise floor on ${name.padEnd(18)} at null p${String(pctl * 100).padEnd(3)} (=${floor.toFixed(3)}): correct answers kept ${kept}/${base} (${(100 * kept / base).toFixed(1)}%)`
      + ` · held-out absent silenced: new ${Ntest.filter((r) => !speaks(r)).length}/${Ntest.length}, familiar ${Ftest.filter((r) => !speaks(r)).length}/${Ftest.length}`);
  }
}
process.exit(0);
