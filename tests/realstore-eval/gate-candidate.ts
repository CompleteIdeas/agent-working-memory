/**
 * The best signals from signal-gestalt.ts, fitted the HONEST way: per agent, on the store's own
 * synthetic calibration probes only (as the shipped gate is), thresholds by the shipped rule.
 * Compared with the shipped three-signal gate on the same recalls.
 *   npx tsx tests/realstore-eval/gate-candidate.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fitLogistic, thresholds } from '../../src/engine/abstention-gate.js';

const S = JSON.parse(readFileSync(join(tmpdir(), 'awm-signals.json'), 'utf8'));
const DN = JSON.parse(readFileSync(join(tmpdir(), 'awm-density.json'), 'utf8'));
const lg = (p: number) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
const inv = (r: number) => (r < 0 ? 0 : 1 / (1 + r));
function f(p: any, d: any) {
  const t = p.pool.find((c: any) => c.id === p.top[0]) ?? [...p.pool].sort((a: any, b: any) => b.rr - a.rr)[0];
  if (!t) return null;
  const s = [...p.pool].sort((a: any, b: any) => b.rr - a.rr).find((c: any) => c.id !== t.id);
  const mc = p.pool.reduce((a: number, c: any) => a + c.cos, 0) / p.pool.length;
  return { rrTop: lg(t.rr), cosTop: t.cos, rrMargin: lg(t.rr) - lg(s?.rr ?? 1e-6), vRank: inv(t.v), cosRel: t.cos - mc, bm25Top: d.bTop, dGap: d.cGap,
    dTop: d.cTop, c70: Math.log1p(Math.min(50, d.c70)), nAny: Math.log1p(d.nAny), bRank: inv(t.b) };
}
const SETS: Record<string, string[]> = {
  'PROPOSED v2: shipped + bm25Top, dTop, dGap, c70, bRank': ['rrTop', 'cosTop', 'rrMargin', 'bm25Top', 'dTop', 'dGap', 'c70', 'bRank'],
  'PROPOSED v2 + nAny (needs an FTS count query)': ['rrTop', 'cosTop', 'rrMargin', 'bm25Top', 'dTop', 'dGap', 'c70', 'bRank', 'nAny'],
  'shipped (rrTop, cosTop, rrMargin)': ['rrTop', 'cosTop', 'rrMargin'],
  '+ vector rank, cosine vs pool': ['rrTop', 'cosTop', 'rrMargin', 'vRank', 'cosRel'],
  '+ raw BM25 of best match': ['rrTop', 'cosTop', 'rrMargin', 'vRank', 'cosRel', 'bm25Top'],
  '+ raw BM25 + cosine gap (density)': ['rrTop', 'cosTop', 'rrMargin', 'vRank', 'cosRel', 'bm25Top', 'dGap'],
};
for (const [name, keys] of Object.entries(SETS)) {
  const gates: Record<string, any> = {};
  for (const agent of Object.keys(S.calib)) {
    const rows = S.calib[agent].map((p: any, i: number) => ({ x: f(p, DN.calib[agent][i]), y: p.goldId ? 1 : 0, ok: !!p.goldId && p.top[0] === p.goldId }))
      .filter((r: any) => r.x).map((r: any) => ({ ...r, x: keys.map((k) => r.x[k]) }));
    const m = fitLogistic(rows.map((r: any) => r.x), rows.map((r: any) => r.y));
    const sc = (x: number[]) => x.reduce((a, v, j) => a + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b);
    gates[agent] = { sc, ...thresholds(rows.filter((r: any) => r.ok).map((r: any) => sc(r.x)), rows.filter((r: any) => !r.y).map((r: any) => sc(r.x))) };
  }
  console.log(`\n${name}`);
  for (const set of ['kw', 'nl']) {
    const band = (p: any, i: number) => {
      const x = f(p, DN.probes[i]); if (!x) return 'empty';
      const g = gates[p.agent ?? 'work'] ?? gates.work; const s = g.sc(keys.map((k) => (x as any)[k]));
      return s >= g.answerAt ? 'answer' : s >= g.withholdBelow ? 'low' : 'withhold';
    };
    const all = (S.probes as any[]).map((p, i) => ({ p, b: band(p, i) })).filter(({ p }) => p.set === set || p.set === 'both');
    const corr = all.filter(({ p }) => p.pop === 'answerable' && p.top[0] === p.goldId);
    const c = (xs: any[], b: string) => xs.filter((x) => x.b === b).length;
    const nw = all.filter(({ p }) => p.pop === 'absent-new'), fm = all.filter(({ p }) => p.pop === 'absent-familiar');
    console.log(`  ${set}: correct withheld ${c(corr, 'withhold')}/${corr.length} (low ${c(corr, 'low')}) · never-stored withheld ${c(nw, 'withhold')}/${nw.length} (answered ${c(nw, 'answer')}) · deleted withheld ${c(fm, 'withhold')}/${fm.length} (answered ${c(fm, 'answer')})`);
  }
}

// Matched operating points: for each model, sweep the withhold threshold over the labelled NL
// scores and report absent-withheld at the SAME number of correct answers withheld.
console.log('\nmatched operating points (NL): at N correct withheld -> never-stored withheld / deleted withheld   (kw deleted withheld at kw correct withheld = 3)');
for (const [name, keys] of Object.entries(SETS)) {
  const gates: Record<string, (x: number[]) => number> = {};
  for (const agent of Object.keys(S.calib)) {
    const rows = S.calib[agent].map((p: any, i: number) => ({ x: f(p, DN.calib[agent][i]), y: p.goldId ? 1 : 0 })).filter((r: any) => r.x).map((r: any) => ({ ...r, x: keys.map((k) => r.x[k]) }));
    const m = fitLogistic(rows.map((r: any) => r.x), rows.map((r: any) => r.y));
    gates[agent] = (x) => x.reduce((a, v, j) => a + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b);
  }
  const score = (p: any, i: number) => { const x = f(p, DN.probes[i]); return x ? (gates[p.agent ?? 'work'] ?? gates.work)!(keys.map((k) => (x as any)[k])) : NaN; };
  const sc = (S.probes as any[]).map((p, i) => ({ p, s: score(p, i) })).filter((r) => Number.isFinite(r.s));
  const line: string[] = [];
  for (const set of ['nl', 'kw']) {
    const corr = sc.filter(({ p }) => p.set === set && p.pop === 'answerable' && p.top[0] === p.goldId).map((r) => r.s).sort((a, b) => a - b);
    const nw = sc.filter(({ p }) => p.set === 'both' && p.pop === 'absent-new').map((r) => r.s);
    const del = sc.filter(({ p }) => p.set === set && p.pop === 'absent-familiar').map((r) => r.s);
    for (const n of set === 'nl' ? [6, 12, 22] : [3]) {
      const thr = corr[n]!; // withholding everything below the (n+1)th lowest correct score withholds exactly n correct
      line.push(`${set}@${n}: ${nw.filter((s) => s < thr).length}/${nw.length} · ${del.filter((s) => s < thr).length}/${del.length}`);
    }
  }
  console.log(`  ${name.padEnd(52)} ${line.join('   ')}`);
}
