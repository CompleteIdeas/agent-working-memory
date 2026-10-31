/**
 * What does each recall signal actually tell us? Per signal, separately for keyword-shaped and
 * natural-language questions, on signal-dump.ts output:
 *   1. RANKING — rank the candidate pool by that signal alone: how often is the right memory
 *      first (s@1), and how often does the signal put the gold above a random wrong candidate
 *      (within-pool AUC). Plus rescue: of the questions the cross-encoder gets wrong, how many
 *      this signal gets right.
 *   2. ABSTENTION — the signal's value on the top result: does it separate a correct answer
 *      from a never-stored question, and from a familiar question whose answer was deleted (AUC).
 *   3. REDUNDANCY — Spearman correlation between signals over candidates: which carry the same
 *      information.
 *   4. TYPICAL VALUES — medians on the top result for correct / never-stored / deleted.
 *
 *   npx tsx tests/realstore-eval/signal-eval.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const D = JSON.parse(readFileSync(join(tmpdir(), 'awm-signals.json'), 'utf8'));
type Cand = { id: string; rr: number; comp: number; text: number; cos: number; b: number; v: number };
type Rec = { goldId: string | null; top: string[]; nBm25: number; nVec: number; pool: Cand[]; set: string; pop: string; query: string };
const probes = D.probes as Rec[];
const inv = (r: number) => (r < 0 ? 0 : 1 / (1 + r));

// Candidate-level signals, oriented so that higher = more likely the answer.
const CS: Record<string, (c: Cand) => number> = {
  'cross-encoder score': (c) => c.rr,
  'BM25 rank': (c) => inv(c.b),
  'vector rank': (c) => inv(c.v),
  'raw cosine': (c) => c.cos,
  'BM25 text match': (c) => c.text,
  'AWM composite': (c) => c.comp,
  'RRF (BM25+vector)': (c) => inv(c.b + 60 - 1) * 0 + (c.b >= 0 ? 1 / (60 + c.b) : 0) + (c.v >= 0 ? 1 / (60 + c.v) : 0),
};
const auc = (pos: number[], neg: number[]) => {
  if (!pos.length || !neg.length) return NaN;
  let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
};
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '  —  ');
const pad = (s: string, n: number) => s.padEnd(n);

for (const set of ['kw', 'nl']) {
  const ans = probes.filter((p) => p.set === set && p.pop === 'answerable' && p.pool.some((c) => c.id === p.goldId));
  const nAll = probes.filter((p) => p.set === set && p.pop === 'answerable').length;
  console.log(`\n══ ${set === 'kw' ? 'KEYWORD-SHAPED' : 'NATURAL-LANGUAGE'} questions · gold in the pool for ${ans.length}/${nAll}`);

  // 1. Ranking
  const rrTop = (p: Rec) => [...p.pool].sort((a, b) => b.rr - a.rr)[0]!.id;
  const rrWrong = ans.filter((p) => rrTop(p) !== p.goldId);
  console.log(`\n  RANKING (pool ordered by one signal)      s@1      within-pool AUC   rescues of the ${rrWrong.length} cross-encoder misses`);
  for (const [name, fn] of Object.entries(CS)) {
    const top = (p: Rec) => [...p.pool].sort((a, b) => fn(b) - fn(a))[0]!.id;
    const s1 = ans.filter((p) => top(p) === p.goldId).length;
    const aucs = ans.map((p) => { const g = p.pool.find((c) => c.id === p.goldId)!; return auc([fn(g)], p.pool.filter((c) => c.id !== p.goldId).map(fn)); }).filter(Number.isFinite);
    const rescue = rrWrong.filter((p) => top(p) === p.goldId).length;
    console.log(`  ${pad(name, 40)} ${f(100 * s1 / nAll, 1).padStart(5)}%    ${f(aucs.reduce((a, b) => a + b, 0) / aucs.length)}            ${rescue}`);
  }

  // 2. Abstention: signal on the top result (shipped order)
  const topC = (p: Rec) => p.pool.find((c) => c.id === p.top[0]) ?? [...p.pool].sort((a, b) => b.rr - a.rr)[0];
  const correct = probes.filter((p) => p.set === set && p.pop === 'answerable' && p.top[0] === p.goldId);
  const absNew = probes.filter((p) => p.set === 'both' && p.pop === 'absent-new');
  const absFam = probes.filter((p) => p.set === set && p.pop === 'absent-familiar');
  const QS: Record<string, (p: Rec) => number | undefined> = {
    'cross-encoder score (top)': (p) => topC(p)?.rr,
    'cross-encoder margin (top − 2nd)': (p) => { const s = [...p.pool].sort((a, b) => b.rr - a.rr); return s.length > 1 ? s[0]!.rr - s[1]!.rr : undefined; },
    'raw cosine (top)': (p) => topC(p)?.cos,
    'BM25 text match (top)': (p) => topC(p)?.text,
    'BM25 rank of top': (p) => { const c = topC(p); return c ? inv(c.b) : undefined; },
    'vector rank of top': (p) => { const c = topC(p); return c ? inv(c.v) : undefined; },
    'BM25 and vector agree (both top-3)': (p) => { const c = topC(p); return c ? (c.b >= 0 && c.b < 3 && c.v >= 0 && c.v < 3 ? 1 : 0) : undefined; },
    'vector hits above floor (count)': (p) => p.nVec,
    'BM25 hits (count)': (p) => p.nBm25,
  };
  const vals = (xs: Rec[], fn: (p: Rec) => number | undefined) => xs.map(fn).filter((v): v is number => v !== undefined && Number.isFinite(v));
  console.log(`\n  ABSTENTION (value on the top result)       AUC vs never-stored   AUC vs deleted   median: correct / never-stored / deleted`);
  for (const [name, fn] of Object.entries(QS)) {
    const c = vals(correct, fn), n = vals(absNew, fn), d = vals(absFam, fn);
    console.log(`  ${pad(name, 40)} ${f(auc(c, n)).padStart(8)}            ${f(auc(c, d)).padStart(8)}        ${f(med(c), 2)} / ${f(med(n), 2)} / ${f(med(d), 2)}`);
  }
}

// 3. Redundancy: Spearman over all candidates of answerable questions
const cands = probes.filter((p) => p.pop === 'answerable').flatMap((p) => p.pool);
const rank = (xs: number[]) => { const o = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length); o.forEach(([, i], k) => (r[i] = k)); return r as number[]; };
const spear = (a: number[], b: number[]) => {
  const ra = rank(a), rb = rank(b), n = a.length, ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { num += (ra[i]! - ma) * (rb[i]! - ma); da += (ra[i]! - ma) ** 2; db += (rb[i]! - ma) ** 2; }
  return num / Math.sqrt(da * db);
};
const names = ['cross-encoder score', 'BM25 rank', 'vector rank', 'raw cosine', 'BM25 text match', 'AWM composite'];
const cols = names.map((n) => cands.map(CS[n]!));
console.log(`\n══ REDUNDANCY — Spearman correlation over ${cands.length} candidates (1 = same information)`);
console.log('  ' + ''.padEnd(22) + names.map((n) => n.slice(0, 10).padStart(11)).join(''));
names.forEach((n, i) => console.log('  ' + n.slice(0, 21).padEnd(22) + names.map((_, j) => f(spear(cols[i]!, cols[j]!), 2).padStart(11)).join('')));
