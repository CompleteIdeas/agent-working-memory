/**
 * Paired comparison: baseline vs AWM_RERANK2=1, on the real tracer.
 *
 * Two things are being checked, and the second matters more than the first:
 *
 *   1. Does the simulated +8.0pp success@1 actually materialise in the pipeline?
 *   2. Is ADVERSARIAL ABSTENTION genuinely untouched? The whole safety argument
 *      for phase 9b is that reordering AFTER the gate cannot affect it. That is
 *      an argument, not a measurement — this measures it. Expect literally
 *      0 broken / 0 fixed on adversarial. Anything else falsifies the design
 *      claim and the change should not ship.
 *
 * Also verifies the baseline re-run is unchanged vs the pre-change baseline,
 * confirming phase 9b is a true no-op when the flag is off.
 *
 * Usage: node analyze.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = import.meta.dirname;
const load = (p) => existsSync(p)
  ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : null;

const base = load(join(DIR, 'baseline-recheck.jsonl'));
const arm = load(join(DIR, 'rerank2.jsonl'));
if (!base || !arm) { console.error('missing jsonl — did both arms finish?'); process.exit(1); }

const ok = (r) => (r.category === 5 ? !!r.abstained : r.postRank === 1);
const key = (r) => `${r.conv}||${r.category}||${r.q}`;
const baseMap = new Map(base.map(r => [key(r), r]));

function mcnemar(b, c) {
  if (b + c === 0) return 1;
  const chi2 = Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
  const z = Math.sqrt(chi2);
  return Math.max(0, Math.min(1, 2 * (1 - (1 / (1 + Math.exp(-1.702 * z))))));
}

const SLICES = [
  ['multi-hop', r => r.category === 1],
  ['single-hop', r => r.category === 2],
  ['temporal', r => r.category === 3],
  ['open-domain', r => r.category === 4],
  ['ALL answerable', r => r.category !== 5],
  ['ADVERSARIAL', r => r.category === 5],
];

console.log('\nPHASE 9b (AWM_RERANK2=1) vs baseline — paired');
console.log('='.repeat(92));
console.log('  slice            n     base%     arm%     delta     broken  fixed   McNemar p');
console.log('  ' + '-'.repeat(88));

for (const [name, pred] of SLICES) {
  const pairs = [];
  for (const r of arm) {
    if (!pred(r)) continue;
    const b = baseMap.get(key(r));
    if (!b) continue;
    pairs.push([ok(b), ok(r)]);
  }
  if (!pairs.length) continue;
  const n = pairs.length;
  const bOk = pairs.filter(([x]) => x).length;
  const aOk = pairs.filter(([, y]) => y).length;
  const broke = pairs.filter(([x, y]) => x && !y).length;
  const fixed = pairs.filter(([x, y]) => !x && y).length;
  const d = ((aOk - bOk) / n) * 100;
  const p = mcnemar(broke, fixed);

  let flag = '';
  if (name === 'ADVERSARIAL') {
    flag = (broke === 0 && fixed === 0)
      ? '   <-- UNCHANGED, as designed'
      : '   <-- !!! DESIGN CLAIM FALSIFIED !!!';
  }
  console.log(
    `  ${name.padEnd(15)} ${String(n).padStart(4)}  ${((bOk / n) * 100).toFixed(1).padStart(6)}%  ` +
    `${((aOk / n) * 100).toFixed(1).padStart(6)}%  ${(d >= 0 ? '+' : '') + d.toFixed(1).padStart(5)}pp  ` +
    `${String(broke).padStart(6)} ${String(fixed).padStart(6)}   ` +
    `${p < 0.001 ? '<0.001' : p.toFixed(3)}${flag}`);
}
console.log('='.repeat(92) + '\n');
