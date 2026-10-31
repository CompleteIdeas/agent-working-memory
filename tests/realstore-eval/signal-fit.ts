/**
 * Offline, on signal-dump.ts output: can more signals, combined as probabilities, make the
 * abstention gate (and the ranking) better? Everything is fitted per agent on the store's own
 * synthetic calibration probes — no labelled question is used for fitting, as in the shipped gate.
 *
 *   A  current gate: logit(rr top), logit(rr second), cosine of top            (shipped order)
 *   B  A + where the top sits in the BM25 and vector lists, their agreement,
 *        how many vector hits cleared the floor, its BM25 match                 (shipped order)
 *   C  per-candidate probability P(this is the answer | rr, BM25 rank, vector rank, cosine,
 *        text, composite), logistic, fitted on calibration candidates. Ranking = sort by P;
 *        gate score = logit(max P)                                               (P order)
 * Thresholds follow the shipped rule (abstention-gate.ts thresholds()).
 *
 *   npx tsx tests/realstore-eval/signal-fit.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fitLogistic, thresholds } from '../../src/engine/abstention-gate.js';

const D = JSON.parse(readFileSync(join(tmpdir(), 'awm-signals.json'), 'utf8'));
type Cand = { id: string; rr: number; comp: number; text: number; cos: number; b: number; v: number };
type Rec = { goldId: string | null; top: string[]; nBm25: number; nVec: number; pool: Cand[]; set?: string; pop?: string; agent?: string };

const lg = (p: number) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
const inv = (r: number) => (r < 0 ? 0 : 1 / (1 + r));
const byRr = (r: Rec) => [...r.pool].sort((a, b) => b.rr - a.rr);

// ── query-level features for the gate, on the SHIPPED top result ──
const topCand = (r: Rec) => r.pool.find((c) => c.id === r.top[0]) ?? byRr(r)[0];
function featA(r: Rec): number[] | null {
  const t = topCand(r); if (!t) return null;
  const s = byRr(r).find((c) => c.id !== t.id);
  return [lg(t.rr), t.cos, lg(t.rr) - lg(s?.rr ?? 1e-6)];
}
function featB(r: Rec): number[] | null {
  const a = featA(r); if (!a) return null;
  const t = topCand(r)!;
  return [...a, inv(t.b), inv(t.v), t.b >= 0 && t.b < 3 && t.v >= 0 && t.v < 3 ? 1 : 0, Math.log1p(r.nVec), t.text];
}
// ── candidate-level features for the probability model ──
const featC = (c: Cand) => [lg(c.rr), inv(c.b), inv(c.v), c.b >= 0 ? 1 : 0, c.v >= 0 ? 1 : 0, c.cos, c.text, c.comp];

type Gate = { score: (r: Rec) => number | null; top: (r: Rec) => string | undefined; answerAt: number; withholdBelow: number };

function fitQueryGate(calib: Rec[], feat: (r: Rec) => number[] | null): Gate {
  const rows = calib.map((r) => ({ x: feat(r), y: r.goldId ? 1 : 0, correct: !!r.goldId && r.top[0] === r.goldId })).filter((r) => r.x);
  const m = fitLogistic(rows.map((r) => r.x!), rows.map((r) => r.y));
  const sc = (x: number[]) => x.reduce((s, v, j) => s + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b);
  const t = thresholds(rows.filter((r) => r.correct).map((r) => sc(r.x!)), rows.filter((r) => !r.y).map((r) => sc(r.x!)));
  return { score: (r) => { const x = feat(r); return x ? sc(x) : null; }, top: (r) => r.top[0], ...t };
}

function fitProbGate(calib: Rec[]): Gate {
  const X: number[][] = [], y: number[] = [];
  for (const r of calib) for (const c of r.pool) { X.push(featC(c)); y.push(r.goldId && c.id === r.goldId ? 1 : 0); }
  const m = fitLogistic(X, y);
  const z = (c: Cand) => featC(c).reduce((s, v, j) => s + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b);
  const best = (r: Rec) => r.pool.reduce<Cand | null>((a, c) => (!a || z(c) > z(a) ? c : a), null);
  const g: Gate = { score: (r) => { const b = best(r); return b ? z(b) : null; }, top: (r) => best(r)?.id, answerAt: 0, withholdBelow: 0 };
  const correct = calib.filter((r) => r.goldId && g.top(r) === r.goldId).map((r) => g.score(r)!).filter((v) => v !== null);
  const nulls = calib.filter((r) => !r.goldId).map((r) => g.score(r)).filter((v): v is number => v !== null);
  Object.assign(g, thresholds(correct, nulls));
  return g;
}

const band = (g: Gate, r: Rec) => { const s = g.score(r); if (s === null) return 'empty'; return s >= g.answerAt ? 'answer' : s >= g.withholdBelow ? 'low' : 'withhold'; };

for (const [name, fit] of [['A current', (c: Rec[]) => fitQueryGate(c, featA)], ['B +agreement', (c: Rec[]) => fitQueryGate(c, featB)], ['C probability', fitProbGate]] as const) {
  const gates: Record<string, Gate> = {};
  for (const agent of Object.keys(D.calib)) gates[agent] = fit(D.calib[agent]);
  console.log(`\n${name}`);
  for (const set of ['kw', 'nl']) {
    const ps = (D.probes as Rec[]).filter((p) => p.set === set || p.set === 'both');
    const g = (p: Rec) => gates[p.agent ?? 'work'] ?? gates.work!;
    const ans = ps.filter((p) => p.pop === 'answerable');
    const corr = ans.filter((p) => g(p).top(p) === p.goldId);
    const cnt = (xs: Rec[], b: string) => xs.filter((p) => band(g(p), p) === b).length;
    const absNew = ps.filter((p) => p.pop === 'absent-new'), absFam = ps.filter((p) => p.pop === 'absent-familiar');
    console.log(`  ${set}: top-1 ${corr.length}/${ans.length} (${(100 * corr.length / ans.length).toFixed(1)}%)`
      + ` · correct withheld ${cnt(corr, 'withhold')} low ${cnt(corr, 'low')}`
      + ` · absent-new withheld ${cnt(absNew, 'withhold')}/${absNew.length} answered ${cnt(absNew, 'answer')}`
      + ` · absent-familiar withheld ${cnt(absFam, 'withhold')}/${absFam.length} answered ${cnt(absFam, 'answer')}`);
  }
}

// ── Separability ceiling: could these signals tell a correct answer from an absent fact AT ALL?
// Fitted on the LABELLED questions with 5-fold cross-validation — a diagnostic, never a gate:
// if the ceiling is high, the shipped gate's weakness is its synthetic training data, not its
// signals. AUC = chance a random correct answer outscores a random absent question.
function auc(pos: number[], neg: number[]): number {
  let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
function cvAuc(rows: Array<{ x: number[]; y: number }>): number {
  const k = 5, scores: Array<{ s: number; y: number }> = [];
  for (let f = 0; f < k; f++) {
    const tr = rows.filter((_, i) => i % k !== f), te = rows.filter((_, i) => i % k === f);
    const m = fitLogistic(tr.map((r) => r.x), tr.map((r) => r.y));
    for (const r of te) scores.push({ s: r.x.reduce((a, v, j) => a + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b), y: r.y });
  }
  return auc(scores.filter((r) => r.y).map((r) => r.s), scores.filter((r) => !r.y).map((r) => r.s));
}
console.log('\nseparability, correct answer vs absent question (5-fold CV on labelled data; AUC 0.5 = chance, 1 = perfect)');
for (const set of ['kw', 'nl']) {
  const ps = (D.probes as Rec[]).filter((p) => p.set === set || p.set === 'both');
  const rows = (feat: (r: Rec) => number[] | null) => ps
    .filter((p) => (p.pop === 'answerable' && p.top[0] === p.goldId) || p.pop !== 'answerable')
    .map((p) => ({ x: feat(p), y: p.pop === 'answerable' ? 1 : 0 })).filter((r): r is { x: number[]; y: number } => !!r.x);
  // the shipped gate's own calibration-fitted scores, for comparison
  const shipped = Object.fromEntries(Object.keys(D.calib).map((a) => [a, fitQueryGate(D.calib[a], featA)]));
  const sh = ps.filter((p) => (p.pop === 'answerable' && p.top[0] === p.goldId) || p.pop !== 'answerable')
    .map((p) => ({ s: shipped[p.agent ?? 'work']!.score(p), y: p.pop === 'answerable' ? 1 : 0 })).filter((r) => r.s !== null) as Array<{ s: number; y: number }>;
  console.log(`  ${set}: A fitted on calibration ${auc(sh.filter((r) => r.y).map((r) => r.s), sh.filter((r) => !r.y).map((r) => r.s)).toFixed(3)}`
    + ` · A ceiling ${cvAuc(rows(featA)).toFixed(3)} · B ceiling ${cvAuc(rows(featB)).toFixed(3)}`);
}

// ── Query type as a signal (Robert, 2026-10-30). A fair test needs both outcomes within each
// type, so: answerable + absent-familiar from BOTH fixtures mixed (absent-new is left out — it
// is all keyword-shaped, and a type feature would learn "keyword-shaped = absent" from that).
const STOPW = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that not but all any can will would should could into than then there their they them its we our i my you why'.split(' '));
function typeFeat(q: string): number[] {
  const w = q.toLowerCase().match(/[a-z0-9_.\-/]+/g) ?? [];
  const stop = w.filter((t) => STOPW.has(t)).length / Math.max(1, w.length);
  const qword = /^(what|how|why|when|where|which|who|did|do|does|is|are|was|were|can|should|has|have)\b/i.test(q.trim()) || q.trim().endsWith('?') ? 1 : 0;
  const ident = /[_/]|\b\w+\.\w+\b|\b[a-z]*\d+[a-z]+|\b[a-z]+[A-Z]\w*/.test(q) ? 1 : 0;
  return [stop, Math.log1p(w.length), qword, ident];
}
{
  const mixed = (D.probes as Rec[] & any[]).filter((p: any) => p.set !== 'both'
    && ((p.pop === 'answerable' && p.top[0] === p.goldId) || p.pop === 'absent-familiar'));
  const mk = (feat: (r: any) => number[] | null) => mixed.map((p: any) => ({ x: feat(p), y: p.pop === 'answerable' ? 1 : 0 }))
    .filter((r): r is { x: number[]; y: number } => !!r.x);
  const withType = (r: any) => { const a = featA(r); if (!a) return null; const t = typeFeat(r.query); return [...a, ...t, ...t.map((v) => v * a[0]!)]; };
  const typeOnly = (r: any) => typeFeat(r.query);
  const nAns = mixed.filter((p: any) => p.pop === 'answerable').length;
  console.log(`\nquery type, mixed keyword + natural-language (${nAns} correct answers, ${mixed.length - nAns} deleted-fact questions), 5-fold CV ceiling AUC`);
  console.log(`  type alone ${cvAuc(mk(typeOnly)).toFixed(3)} · A ${cvAuc(mk(featA)).toFixed(3)} · A + type (with type × reranker interaction) ${cvAuc(mk(withType)).toFixed(3)}`);
  // and within each fixture, for reference
  for (const set of ['kw', 'nl']) {
    const sub = mixed.filter((p: any) => p.set === set);
    const m2 = (feat: (r: any) => number[] | null) => sub.map((p: any) => ({ x: feat(p), y: p.pop === 'answerable' ? 1 : 0 })).filter((r): r is { x: number[]; y: number } => !!r.x);
    console.log(`  ${set} only: A ${cvAuc(m2(featA)).toFixed(3)} · A + type ${cvAuc(m2(withType)).toFixed(3)}`);
  }
}
