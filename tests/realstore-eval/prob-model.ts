/**
 * A full probability model over the recall signals, evaluated for PROBABILITY QUALITY, not only
 * for rank order. Reads signal-dump.ts and density-dump.ts output.
 *
 * Two stages:
 *   1. CANDIDATE model  P(this candidate is the answer | its signals, and its signals relative
 *      to the rest of the pool). Ranking = sort by P. Also yields pool-level summaries: max P,
 *      the entropy of P over the pool, P(top) − P(second).
 *   2. QUERY model      P(the store holds the answer | top-result signals, pool shape, match
 *      density over the whole store, query shape, candidate-model summaries).
 *
 * Each is fitted two ways: HONEST (per agent, on the store's own synthetic calibration probes,
 * the only data a shipped gate may use) and CEILING (5-fold CV on the labelled questions, to
 * show what the signals could do with representative training data).
 *
 * Judged by AUC, log-loss, Brier score and a reliability table (predicted P vs observed rate),
 * per question shape (keyword / natural-language) and per population (correct, never-stored,
 * deleted). Then drop-one-family ablation on the honest query model.
 *
 * Unweighted L2 logistic regression (Newton), so the outputs are probabilities and not the
 * class-balanced scores fitLogistic() in abstention-gate.ts produces for thresholding.
 *
 *   npx tsx tests/realstore-eval/prob-model.ts [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const S = JSON.parse(readFileSync(join(tmpdir(), 'awm-signals.json'), 'utf8'));
const DN = JSON.parse(readFileSync(join(tmpdir(), 'awm-density.json'), 'utf8'));
const OUT = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

type Cand = { id: string; rr: number; comp: number; text: number; cos: number; b: number; v: number };
type Rec = { goldId: string | null; top: string[]; nBm25: number; nVec: number; pool: Cand[]; set?: string; pop?: string; agent?: string; query?: string };
const lg = (p: number) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
const sig = (z: number) => 1 / (1 + Math.exp(-z));
const inv = (r: number) => (r < 0 ? 0 : 1 / (1 + r));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) || 1e-6; };

// ── Unweighted L2 logistic regression, Newton's method, standardised inputs ──
type Model = { names: string[]; mu: number[]; sd: number[]; w: number[]; b: number };
function fit(X: number[][], y: number[], names: string[], l2 = 1e-2, iters = 25): Model {
  const n = X.length, d = names.length;
  const mu = names.map((_, j) => mean(X.map((x) => x[j]!)));
  const s = names.map((_, j) => sd(X.map((x) => x[j]!)));
  const Z = X.map((x) => x.map((v, j) => (v - mu[j]!) / s[j]!));
  let w = new Array(d).fill(0) as number[], b = lg(Math.max(1e-3, Math.min(1 - 1e-3, mean(y))));
  for (let it = 0; it < iters; it++) {
    // gradient and Hessian of the regularised negative log-likelihood (bias unregularised)
    const g = new Array(d + 1).fill(0) as number[];
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0) as number[]);
    for (let i = 0; i < n; i++) {
      const z = Z[i]!; let t = b; for (let j = 0; j < d; j++) t += w[j]! * z[j]!;
      const p = sig(t), e = p - y[i]!, q = p * (1 - p);
      for (let j = 0; j <= d; j++) {
        const zj = j < d ? z[j]! : 1;
        g[j]! += e * zj;
        for (let k = 0; k <= d; k++) H[j]![k]! += q * zj * (k < d ? z[k]! : 1);
      }
    }
    for (let j = 0; j < d; j++) { g[j]! += l2 * n * w[j]!; H[j]![j]! += l2 * n; }
    const step = solve(H, g);
    if (!step) break;
    const nll = (ww: number[], bb: number) => {
      let t = 0;
      for (let i = 0; i < n; i++) { let z = bb; for (let j = 0; j < d; j++) z += ww[j]! * Z[i]![j]!; t += y[i] ? Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)); }
      return t + 0.5 * l2 * n * ww.reduce((a, v) => a + v * v, 0);
    };
    const before = nll(w, b);
    let alpha = 1, w2 = w, b2 = b;
    for (let tries = 0; tries < 12; tries++) {
      w2 = w.map((v, j) => v - alpha * step[j]!); b2 = b - alpha * step[d]!;
      if (nll(w2, b2) <= before) break;
      alpha /= 2;
    }
    const maxStep = Math.max(...step.slice(0, d).map((v) => Math.abs(alpha * v)));
    w = w2; b = b2;
    if (maxStep < 1e-7) break;
  }
  return { names, mu, sd: s, w, b };
}
function solve(A: number[][], bv: number[]): number[] | null {
  const n = bv.length, M = A.map((r, i) => [...r, bv[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r]![c]! / M[c]![c]!; for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!; }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}
const predict = (m: Model, x: number[]) => sig(x.reduce((a, v, j) => a + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b));

// ── Metrics ──
const auc = (pos: number[], neg: number[]) => { if (!pos.length || !neg.length) return NaN; let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0; return s / (pos.length * neg.length); };
const logloss = (p: number[], y: number[]) => -mean(p.map((q, i) => { const c = Math.min(Math.max(q, 1e-6), 1 - 1e-6); return y[i] ? Math.log(c) : Math.log(1 - c); }));
const brier = (p: number[], y: number[]) => mean(p.map((q, i) => (q - y[i]!) ** 2));
function reliability(p: number[], y: number[]): string {
  const bins = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.01];
  const cells: string[] = [];
  for (let i = 0; i + 1 < bins.length; i++) {
    const idx = p.map((q, k) => (q >= bins[i]! && q < bins[i + 1]! ? k : -1)).filter((k) => k >= 0);
    if (!idx.length) continue;
    cells.push(`${bins[i]!.toFixed(1)}–${Math.min(1, bins[i + 1]!).toFixed(1)}: ${(100 * mean(idx.map((k) => y[k]!))).toFixed(0)}% of ${idx.length}`);
  }
  return cells.join(' · ');
}
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '  —  ');

// ── Stage 1: candidate features (own + relative to pool) ──
const CAND_NAMES = ['rr', 'rrZ', 'rrGapTop', 'bRank', 'vRank', 'inB', 'inV', 'cos', 'cosRel', 'text', 'comp', 'agree'];
function candFeats(p: Rec): number[][] {
  const rrs = p.pool.map((c) => c.rr), m = mean(rrs), s = sd(rrs), top = Math.max(...rrs);
  const mc = mean(p.pool.map((c) => c.cos));
  return p.pool.map((c) => [lg(c.rr), (c.rr - m) / s, lg(top) - lg(c.rr), inv(c.b), inv(c.v), c.b >= 0 ? 1 : 0, c.v >= 0 ? 1 : 0,
    c.cos, c.cos - mc, c.text, c.comp, c.b >= 0 && c.b < 3 && c.v >= 0 && c.v < 3 ? 1 : 0]);
}
function fitCandidate(recs: Rec[]): Model {
  const X: number[][] = [], y: number[] = [];
  for (const r of recs) { const F = candFeats(r); r.pool.forEach((c, i) => { X.push(F[i]!); y.push(r.goldId && c.id === r.goldId ? 1 : 0); }); }
  return fit(X, y, CAND_NAMES, 3e-2);
}
function candSummary(m: Model, p: Rec) {
  const P = candFeats(p).map((x) => predict(m, x));
  const order = P.map((v, i) => i).sort((a, b) => P[b]! - P[a]!);
  const Z = P.reduce((a, b) => a + b, 0) || 1e-9;
  const ent = -P.reduce((a, q) => { const r = q / Z; return a + (r > 0 ? r * Math.log(r) : 0); }, 0) / Math.log(Math.max(2, P.length));
  return { topId: p.pool[order[0]!]?.id, maxP: P[order[0]!] ?? 0, gap: (P[order[0]!] ?? 0) - (P[order[1]!] ?? 0), ent, sumP: Z };
}

// ── Stage 2: query features ──
const STOPW = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that not but all any can will would should could into than then there their they them its we our i my you why about'.split(' '));
const FAM: Record<string, string[]> = {
  reranker: ['rrTop', 'rrMargin', 'rrZ'],
  vector: ['cosTop', 'cosRel', 'vRank', 'bRank', 'agree'],
  density: ['bm25Top', 'bm25_10', 'dTop', 'dGap', 'dMean10', 'c60', 'c70', 'nAny', 'nAllFrac'],
  queryShape: ['stop', 'qlen', 'qword', 'ident'],
  candModel: ['maxP', 'pGap', 'ent', 'sumP'],
};
const Q_NAMES = Object.values(FAM).flat();
function queryFeats(p: Rec, d: any, cm: Model): Record<string, number> | null {
  const t = p.pool.find((c) => c.id === p.top[0]) ?? [...p.pool].sort((a, b) => b.rr - a.rr)[0];
  if (!t) return null;
  const sorted = [...p.pool].sort((a, b) => b.rr - a.rr), second = sorted.find((c) => c.id !== t.id);
  const rrs = p.pool.map((c) => c.rr), mc = mean(p.pool.map((c) => c.cos));
  const q = String(p.query ?? ''), w = q.toLowerCase().match(/[a-z0-9_.\-/]+/g) ?? [];
  const cs = candSummary(cm, p);
  return {
    rrTop: lg(t.rr), rrMargin: lg(t.rr) - lg(second?.rr ?? 1e-6), rrZ: (t.rr - mean(rrs)) / sd(rrs),
    cosTop: t.cos, cosRel: t.cos - mc, vRank: inv(t.v), bRank: inv(t.b), agree: t.b >= 0 && t.b < 3 && t.v >= 0 && t.v < 3 ? 1 : 0,
    bm25Top: d.bTop, bm25_10: d.b10, dTop: d.cTop, dGap: d.cGap, dMean10: d.cMean10, c60: Math.log1p(d.c60), c70: Math.log1p(d.c70),
    nAny: Math.log1p(d.nAny), nAllFrac: d.nAny ? d.nAll / d.nAny : 0,
    stop: w.filter((x) => STOPW.has(x)).length / Math.max(1, w.length), qlen: Math.log1p(w.length),
    qword: /^(what|how|why|when|where|which|who|did|do|does|is|are|was|were|can|should|has|have)\b/i.test(q.trim()) || q.trim().endsWith('?') ? 1 : 0,
    ident: /[_/]|\b\w+\.\w+\b|\b[a-z]*\d+[a-z]+|\b[a-z]+[A-Z]\w*/.test(q) ? 1 : 0,
    maxP: lg(cs.maxP), pGap: cs.gap, ent: cs.ent, sumP: Math.log1p(cs.sumP),
  };
}

// ── Data ──
const agents = Object.keys(S.calib) as string[];
const probes = (S.probes as Rec[]).map((p, i) => ({ p, d: DN.probes[i] }));
const findings: string[] = [];
const note = (s: string) => { findings.push(s); console.log(s); };

// Stage 1, honest: candidate model per agent on calibration probes.
const candHonest: Record<string, Model> = {};
for (const a of agents) candHonest[a] = fitCandidate(S.calib[a]);
console.log('══ STAGE 1 · candidate model P(this memory is the answer)');
for (const set of ['kw', 'nl']) {
  const ans = probes.filter(({ p }) => p.set === set && p.pop === 'answerable');
  const shipped = ans.filter(({ p }) => p.top[0] === p.goldId).length;
  const byP = ans.filter(({ p }) => candSummary(candHonest[p.agent ?? 'work'] ?? candHonest.work!, p).topId === p.goldId).length;
  // calibration of the top candidate's P: among questions where top P is in a bin, how often is it the gold
  const tops = ans.map(({ p }) => { const cs = candSummary(candHonest[p.agent ?? 'work'] ?? candHonest.work!, p); return { P: cs.maxP, y: cs.topId === p.goldId ? 1 : 0 }; });
  note(`  ${set}: top-1 shipped blend ${shipped}/${ans.length} · by P ${byP}/${ans.length} · P(top) reliability — ${reliability(tops.map((t) => t.P), tops.map((t) => t.y))}`);
}
// Which candidate signals matter: standardised weights, honest model, work agent
const cw = candHonest.work!;
note(`  candidate weights (work, standardised): ` + cw.names.map((n, j) => `${n} ${cw.w[j]!.toFixed(2)}`).join(', '));

// Stage 2.
console.log('\n══ STAGE 2 · query model P(the store holds the answer)');
const rowsOf = (recs: Rec[], dens: any[], cm: (r: Rec) => Model) => recs.map((r, i) => ({ r, f: queryFeats(r, dens[i], cm(r)) })).filter((x) => x.f) as Array<{ r: Rec; f: Record<string, number> }>;
const X = (rows: Array<{ f: Record<string, number> }>, names: string[]) => rows.map(({ f }) => names.map((n) => f[n]!));
const labelled = rowsOf(probes.map((x) => x.p), probes.map((x) => x.d), (r) => candHonest[r.agent ?? 'work'] ?? candHonest.work!);
const isPos = (r: Rec) => r.pop === 'answerable' && r.top[0] === r.goldId;
const inSet = (r: Rec, set: string) => r.set === set || r.set === 'both';

function evaluate(label: string, prob: (row: { r: Rec; f: Record<string, number> }) => number) {
  for (const set of ['kw', 'nl']) {
    const rows = labelled.filter(({ r }) => inSet(r, set) && (isPos(r) || r.pop !== 'answerable'));
    const p = rows.map(prob), y = rows.map(({ r }) => (isPos(r) ? 1 : 0));
    const pos = rows.filter(({ r }) => isPos(r)).map(prob);
    const nw = rows.filter(({ r }) => r.pop === 'absent-new').map(prob), fm = rows.filter(({ r }) => r.pop === 'absent-familiar').map(prob);
    note(`  ${label} · ${set}: AUC never-stored ${f3(auc(pos, nw))} · deleted ${f3(auc(pos, fm))} · log-loss ${f3(logloss(p, y))} · Brier ${f3(brier(p, y))}`);
    note(`      reliability — ${reliability(p, y)}`);
    note(`      median P: correct ${f3(median(pos))} · never-stored ${f3(median(nw))} · deleted ${f3(median(fm))}`);
  }
}
function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; }

// Honest: per agent on calibration probes (labels: probe has a gold AND the shipped top is it).
const honest: Record<string, Model> = {};
for (const a of agents) {
  const rows = rowsOf(S.calib[a], DN.calib[a], () => candHonest[a]!);
  honest[a] = fit(X(rows, Q_NAMES), rows.map(({ r }) => (r.goldId && r.top[0] === r.goldId ? 1 : 0)), Q_NAMES);
}
const hp = ({ r, f }: { r: Rec; f: Record<string, number> }) => predict(honest[r.agent ?? 'work'] ?? honest.work!, Q_NAMES.map((n) => f[n]!));
evaluate('HONEST (fitted on calibration probes)', hp);
// Shipped three signals, honest, for reference
const SHIP = ['rrTop', 'cosTop', 'rrMargin'];
const honestShip: Record<string, Model> = {};
for (const a of agents) { const rows = rowsOf(S.calib[a], DN.calib[a], () => candHonest[a]!); honestShip[a] = fit(X(rows, SHIP), rows.map(({ r }) => (r.goldId && r.top[0] === r.goldId ? 1 : 0)), SHIP); }
evaluate('HONEST, shipped 3 signals only', ({ r, f }) => predict(honestShip[r.agent ?? 'work'] ?? honestShip.work!, SHIP.map((n) => f[n]!)));

// Ceiling: 5-fold CV over labelled (within set, so the model never sees the test fold).
console.log('\n══ CEILING · 5-fold CV on labelled questions (what the signals could do with representative training data)');
function cvProbs(rows: Array<{ r: Rec; f: Record<string, number> }>, names: string[]): number[] {
  const out = new Array(rows.length).fill(0) as number[];
  for (let k = 0; k < 5; k++) {
    const tr = rows.filter((_, i) => i % 5 !== k);
    const m = fit(X(tr, names), tr.map(({ r }) => (isPos(r) ? 1 : 0)), names);
    rows.forEach((row, i) => { if (i % 5 === k) out[i] = predict(m, names.map((n) => row.f[n]!)); });
  }
  return out;
}
for (const set of ['kw', 'nl']) {
  const rows = labelled.filter(({ r }) => inSet(r, set) && (isPos(r) || r.pop !== 'answerable'));
  const y = rows.map(({ r }) => (isPos(r) ? 1 : 0));
  for (const [label, names] of [['all signals', Q_NAMES], ['shipped 3', SHIP]] as const) {
    const p = cvProbs(rows, names);
    const pos = p.filter((_, i) => y[i]), nw = p.filter((_, i) => rows[i]!.r.pop === 'absent-new'), fm = p.filter((_, i) => rows[i]!.r.pop === 'absent-familiar');
    note(`  ${set} · ${label}: AUC never-stored ${f3(auc(pos, nw))} · deleted ${f3(auc(pos, fm))} · log-loss ${f3(logloss(p, y))} · Brier ${f3(brier(p, y))}`);
    if (label === 'all signals') note(`      reliability — ${reliability(p, y)}`);
  }
}

// Ablation: drop one family from the honest model; report NL AUC vs deleted and vs never-stored.
console.log('\n══ ABLATION · honest model, drop one family (NL AUC deleted / never-stored; kw deleted)');
function honestWith(names: string[]) {
  const ms: Record<string, Model> = {};
  for (const a of agents) { const rows = rowsOf(S.calib[a], DN.calib[a], () => candHonest[a]!); ms[a] = fit(X(rows, names), rows.map(({ r }) => (r.goldId && r.top[0] === r.goldId ? 1 : 0)), names); }
  return ({ r, f }: { r: Rec; f: Record<string, number> }) => predict(ms[r.agent ?? 'work'] ?? ms.work!, names.map((n) => f[n]!));
}
function aucs(prob: (row: any) => number, set: string) {
  const rows = labelled.filter(({ r }) => inSet(r, set) && (isPos(r) || r.pop !== 'answerable'));
  const pos = rows.filter(({ r }) => isPos(r)).map(prob);
  return { del: auc(pos, rows.filter(({ r }) => r.pop === 'absent-familiar').map(prob)), nw: auc(pos, rows.filter(({ r }) => r.pop === 'absent-new').map(prob)) };
}
const full = { nl: aucs(hp, 'nl'), kw: aucs(hp, 'kw') };
note(`  full model             NL ${f3(full.nl.del)} / ${f3(full.nl.nw)} · kw ${f3(full.kw.del)}`);
for (const fam of Object.keys(FAM)) {
  const names = Q_NAMES.filter((n) => !FAM[fam]!.includes(n));
  const pr = honestWith(names), nl = aucs(pr, 'nl'), kw = aucs(pr, 'kw');
  note(`  − ${fam.padEnd(20)} NL ${f3(nl.del)} (${(nl.del - full.nl.del >= 0 ? '+' : '') + (nl.del - full.nl.del).toFixed(3)}) / ${f3(nl.nw)} · kw ${f3(kw.del)}`);
}
// Single-family models, honest
console.log('\n══ ONE FAMILY AT A TIME · honest (NL AUC deleted / never-stored)');
for (const fam of Object.keys(FAM)) { const pr = honestWith(FAM[fam]!), nl = aucs(pr, 'nl'); note(`  ${fam.padEnd(22)} NL ${f3(nl.del)} / ${f3(nl.nw)}`); }

// Standardised weights of the honest query model (work agent): what the model leans on.
const hw = honest.work!;
note(`\n  honest query-model weights (work, standardised, |w| ≥ 0.15): ` + hw.names.map((n, j) => [n, hw.w[j]!] as const).filter(([, w]) => Math.abs(w) >= 0.15).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([n, w]) => `${n} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`).join(', '));

if (OUT) writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), findings }, null, 1));
