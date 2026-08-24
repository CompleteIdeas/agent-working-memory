/**
 * Offline second-stage reordering policy simulator.
 *
 * Reads candidates.jsonl (one pass of the real pipeline, all scores captured)
 * and simulates reordering policies WITHOUT re-running any model. This is the
 * cheap way to find out whether a second stage is worth building, and which one.
 *
 * WHY REORDERING THE FINAL TOP-K IS THE SAFE SHAPE
 * ------------------------------------------------
 * AWM's abstention gate (activation.ts:921-933) reads rerankerScore maxima and
 * margins. A policy that REORDERS the already-returned top-K cannot change those
 * inputs, so adversarial abstention is provably unaffected — the failure mode
 * that has repeatedly bitten this codebase. Changing the blend WEIGHT inside the
 * pipeline would not have that guarantee, because it shifts item.score and thus
 * which items survive minScore. Every policy here is post-gate by construction.
 *
 * Run: node simulate.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rows = readFileSync(join(import.meta.dirname, 'candidates.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const CAT = { 1: 'multi-hop', 2: 'single-hop', 3: 'temporal', 4: 'open-domain' };

/** Reorder the first K candidates by `keyFn`, leave the tail untouched. */
const reorderTopK = (cands, K, keyFn) => {
  const head = cands.slice(0, K).slice().sort((a, b) => keyFn(b) - keyFn(a));
  return head.concat(cands.slice(K));
};

const POLICIES = {
  'baseline (as shipped)': c => c,

  'pure reranker, top-3': c => reorderTopK(c, 3, x => x.reranker),
  'pure reranker, top-5': c => reorderTopK(c, 5, x => x.reranker),
  'pure reranker, top-10': c => reorderTopK(c, 10, x => x.reranker),

  // Only override when the reranker is decisive about it — margin between the
  // best and second-best reranker score inside the window.
  'reranker top-5, margin>0.05': c => {
    const w = c.slice(0, 5).map(x => x.reranker).sort((a, b) => b - a);
    return (w.length >= 2 && w[0] - w[1] > 0.05) ? reorderTopK(c, 5, x => x.reranker) : c;
  },
  'reranker top-5, margin>0.15': c => {
    const w = c.slice(0, 5).map(x => x.reranker).sort((a, b) => b - a);
    return (w.length >= 2 && w[0] - w[1] > 0.15) ? reorderTopK(c, 5, x => x.reranker) : c;
  },

  // Heavier reranker weight in a re-blend, applied only to the top-5 window.
  'reblend top-5 w=0.85': c => reorderTopK(c, 5, x => 0.15 * x.composite + 0.85 * x.reranker),
  'reblend top-5 w=0.95': c => reorderTopK(c, 5, x => 0.05 * x.composite + 0.95 * x.reranker),

  'ORACLE (ceiling, top-10)': c => reorderTopK(c, 10, x => (x.gold ? 1e9 : x.reranker)),
};

const goldRank = cands => { const i = cands.findIndex(c => c.gold); return i < 0 ? 0 : i + 1; };

const base = rows.map(r => goldRank(r.cands));

console.log(`\nSECOND-STAGE REORDERING — simulated on ${rows.length} answerable queries`);
console.log('='.repeat(96));
console.log('policy                          s@1      delta    broken  fixed  |  multi  single  temporal  open');
console.log('-'.repeat(96));

for (const [name, fn] of Object.entries(POLICIES)) {
  const ranks = rows.map(r => goldRank(fn(r.cands)));
  const s1 = ranks.filter(x => x === 1).length;
  const b = ranks.filter((x, i) => base[i] === 1 && x !== 1).length;
  const c = ranks.filter((x, i) => base[i] !== 1 && x === 1).length;

  const per = {};
  for (const k of [1, 2, 3, 4]) {
    const idx = rows.map((r, i) => (r.category === k ? i : -1)).filter(i => i >= 0);
    per[k] = idx.length ? (100 * idx.filter(i => ranks[i] === 1).length / idx.length) : 0;
  }

  const s1p = 100 * s1 / rows.length;
  const d = s1p - (100 * base.filter(x => x === 1).length / rows.length);
  console.log(
    `${name.padEnd(31)} ${s1p.toFixed(1).padStart(5)}%  ${(d >= 0 ? '+' : '') + d.toFixed(1).padStart(5)}pp  ` +
    `${String(b).padStart(6)} ${String(c).padStart(6)}  |  ` +
    `${per[1].toFixed(1).padStart(5)} ${per[2].toFixed(1).padStart(6)} ${per[3].toFixed(1).padStart(8)} ${per[4].toFixed(1).padStart(6)}`);
}

console.log('='.repeat(96));

// How often does the shipped blend disagree with the reranker about rank 1?
let disagree = 0, blendWins = 0, rerankWins = 0;
for (const r of rows) {
  const c = r.cands;
  if (c.length < 2) continue;
  const byRerank = c.slice().sort((a, b) => b.reranker - a.reranker)[0];
  if (byRerank === c[0]) continue;
  disagree++;
  if (c[0].gold) blendWins++;
  else if (byRerank.gold) rerankWins++;
}
console.log(`\nBLEND vs RERANKER disagreement about rank 1:`);
console.log(`  disagreed on ${disagree}/${rows.length} queries (${(100 * disagree / rows.length).toFixed(1)}%)`);
console.log(`  of those — blend was right ${blendWins}, reranker was right ${rerankWins}` +
            (rerankWins + blendWins ? `  (reranker right ${(100 * rerankWins / (rerankWins + blendWins)).toFixed(0)}% of decided cases)` : ''));
console.log();
