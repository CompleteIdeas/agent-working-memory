/**
 * Paired arm comparison for the D11 re-test.
 *
 * Every arm probes the identical query set in the identical order, so the arms
 * are PAIRED. Comparing two marginal success@1 percentages throws that pairing
 * away; McNemar on the discordant pairs does not, and is materially more
 * sensitive. It also answers the question that actually matters here — not "did
 * the average move" but "what did this arm BREAK that the baseline got right",
 * which is the literal definition of the displacing-gold regression.
 *
 * Usage: node analyze.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = import.meta.dirname;
const ARMS = ['baseline', 'spread', 'spread-inhibit', 'spread-inject-inhib'];

const load = (arm) => {
  const p = join(DIR, `${arm}.jsonl`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
};

/** success@1 for answerable; correct abstention for adversarial. */
const ok = (r) => (r.category === 5 ? !!r.abstained : r.postRank === 1);
const key = (r) => `${r.conv}||${r.category}||${r.q}`;

/** Two-sided McNemar with continuity correction; normal approx on chi-square(1). */
function mcnemar(b, c) {
  if (b + c === 0) return { chi2: 0, p: 1 };
  const chi2 = Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
  const z = Math.sqrt(chi2);
  // two-sided normal tail
  const p = 2 * (1 - (1 / (1 + Math.exp(-1.702 * z))));  // logistic approx to Phi
  return { chi2, p: Math.max(0, Math.min(1, p)) };
}

const base = load('baseline');
if (!base) { console.error('baseline.jsonl missing — did the run finish?'); process.exit(1); }
const baseMap = new Map(base.map(r => [key(r), r]));

const SLICES = [
  ['multi-hop',   r => r.category === 1],
  ['single-hop',  r => r.category === 2],
  ['temporal',    r => r.category === 3],
  ['open-domain', r => r.category === 4],
  ['ADVERSARIAL', r => r.category === 5],
];

console.log('\nD11 RE-TEST — paired comparison vs baseline');
console.log('='.repeat(94));
console.log('b = baseline RIGHT, arm WRONG (broken)    c = baseline WRONG, arm RIGHT (fixed)');
console.log('='.repeat(94));

for (const arm of ARMS.slice(1)) {
  const rows = load(arm);
  if (!rows) { console.log(`\n${arm}: (no data)`); continue; }

  console.log(`\n### ${arm}`);
  console.log('  slice          n     base%    arm%     delta      broken  fixed    McNemar p');
  console.log('  ' + '-'.repeat(88));

  for (const [name, pred] of SLICES) {
    const pairs = [];
    for (const r of rows) {
      if (!pred(r)) continue;
      const bRec = baseMap.get(key(r));
      if (!bRec) continue;
      pairs.push([ok(bRec), ok(r)]);
    }
    if (!pairs.length) continue;

    const n = pairs.length;
    const baseOk = pairs.filter(([x]) => x).length;
    const armOk = pairs.filter(([, y]) => y).length;
    const b = pairs.filter(([x, y]) => x && !y).length;   // broken
    const c = pairs.filter(([x, y]) => !x && y).length;   // fixed
    const { p } = mcnemar(b, c);
    const dPct = ((armOk - baseOk) / n) * 100;

    const flag = name === 'ADVERSARIAL' || name === 'single-hop'
      ? (dPct < -0.05 ? '  <-- STRIKE CONDITION' : '')
      : '';

    console.log(
      `  ${name.padEnd(13)} ${String(n).padStart(4)}  ` +
      `${((baseOk / n) * 100).toFixed(1).padStart(6)}%  ${((armOk / n) * 100).toFixed(1).padStart(6)}%  ` +
      `${(dPct >= 0 ? '+' : '') + dPct.toFixed(1).padStart(5)}pp  ` +
      `${String(b).padStart(6)} ${String(c).padStart(6)}    ` +
      `${p < 0.001 ? '<0.001' : p.toFixed(3)}${flag}`);
  }
}

console.log('\n' + '='.repeat(94));
console.log('Reading (per PRE-REGISTRATION.md):');
console.log('  * Arms 2-3 CANNOT recover out-of-pool gold — boost is in-pool only. Flat multi-hop');
console.log('    there is EXPECTED, not a refutation. Only the inject arm tests the hypothesis.');
console.log('  * STRIKE if single-hop OR adversarial falls. Either alone trips it.');
console.log('  * multi-hop gain under ~3pp is inside noise; lean on McNemar p and the fixed/broken');
console.log('    counts rather than the delta.');
console.log('='.repeat(94) + '\n');
