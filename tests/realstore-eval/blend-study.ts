/**
 * Offline blend study: which final-order rule keeps the real-store gains of the 0.21.1 blend
 * without its losses on synthetic corpora?
 *
 * Reads BLEND_DUMP files written by tests/realstore-eval/runner.ts and tests/longmem-eval/runner.ts
 * (each probe: the gold id, AWM's returned order, and exactly what the final blend saw: every
 * candidate's cross-encoder score `rr`, its rank-normalised BM25+vector fusion `fused`, and its
 * stale penalty). Re-orders the SAME pool under each rule, so no recall is re-run.
 *
 *   npx tsx tests/realstore-eval/blend-study.ts <dump dir>
 *
 * The "shipped" rule must reproduce AWM's own first result on every probe; the script reports
 * any mismatch, because a study that cannot reproduce the product measures something else.
 * Parameters are chosen on even-indexed probes and reported on odd ones as well as overall.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type Cand = { id: string; rr: number; fused: number; stale: number };
type Blend = { natural: boolean; naturalModel: boolean; poolHasQuestions: boolean; blendA: number; byRank: boolean; cands: Cand[] };
type Probe = { goldId: string; top: string[]; blend: Blend | null };

const dir = process.argv[2];
if (!dir) { console.error('usage: blend-study.ts <dump dir>'); process.exit(1); }
const SUITES = ['identifier', 'category', 'nl', 'nl-wq', 'public', 'public99', 'longmem'];
const REAL = new Set(['identifier', 'category', 'nl', 'nl-wq']);

const rankNorm = (cs: Cand[], f: (c: Cand) => number) =>
  new Map([...cs].sort((a, b) => f(b) - f(a)).map((c, i, arr) => [c.id, arr.length > 1 ? 1 - i / (arr.length - 1) : 1]));
const logit = (p: number) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(q / (1 - q)); };

/** The shipped key, exactly as src/engine/activation.ts computes it. */
function shippedOrder(b: Blend): string[] {
  const rrN = b.byRank ? rankNorm(b.cands, c => c.rr) : null;
  const key = (c: Cand) => (b.blendA * (rrN ? rrN.get(c.id)! : c.rr) + (1 - b.blendA) * c.fused) * c.stale;
  return [...b.cands].sort((x, y) => key(y) - key(x)).map(c => c.id);
}
const ceOrder = (b: Blend) => [...b.cands].sort((x, y) => y.rr * y.stale - x.rr * x.stale).map(c => c.id);

type Rule = { name: string; order: (b: Blend) => string[] };
const rules: Rule[] = [
  { name: 'shipped', order: shippedOrder },
  { name: 'ce-only', order: ceOrder },
];
// Logit blend: the cross-encoder's score in logit space, min-max within the pool, so saturated
// scores near 1 keep their separation instead of being outvoted by a 0.05 slice of fused rank.
for (const a of [0.7, 0.8, 0.85, 0.9, 0.95]) {
  rules.push({
    name: `logit a=${a}`, order: (b) => {
      if (b.byRank) return shippedOrder(b);
      const ls = b.cands.map(c => logit(c.rr)); const lo = Math.min(...ls), hi = Math.max(...ls);
      const ln = (c: Cand) => hi > lo ? (logit(c.rr) - lo) / (hi - lo) : 1;
      const key = (c: Cand) => (a * ln(c) + (1 - a) * c.fused) * c.stale;
      return [...b.cands].sort((x, y) => key(y) - key(x)).map(c => c.id);
    },
  });
}
// Margin gate: keep the cross-encoder's order when its top-two logit margin is at least d;
// blend (shipped) only when the cross-encoder is unsure.
for (const d of [0.25, 0.5, 1, 1.5, 2, 3]) {
  rules.push({
    name: `gate d=${d}`, order: (b) => {
      const ce = [...b.cands].sort((x, y) => y.rr * y.stale - x.rr * x.stale);
      if (ce.length < 2) return ce.map(c => c.id);
      const m = logit(ce[0]!.rr * ce[0]!.stale) - logit(ce[1]!.rr * ce[1]!.stale);
      return m >= d ? ce.map(c => c.id) : shippedOrder(b);
    },
  });
}
// Tie band: only candidates within d (logit) of the cross-encoder's best are re-ordered by the
// blend; everything below keeps the cross-encoder's order.
for (const d of [0.25, 0.5, 1, 1.5, 2, 3]) {
  rules.push({
    name: `band d=${d}`, order: (b) => {
      const ce = [...b.cands].sort((x, y) => y.rr * y.stale - x.rr * x.stale);
      if (ce.length < 2) return ce.map(c => c.id);
      const top = logit(ce[0]!.rr * ce[0]!.stale);
      const inBand = new Set(ce.filter(c => top - logit(c.rr * c.stale) <= d).map(c => c.id));
      const sh = shippedOrder(b).filter(id => inBand.has(id));
      return [...sh, ...ce.filter(c => !inBand.has(c.id)).map(c => c.id)];
    },
  });
}

// Fusion variants: the same blend, but the first-stage term weights the vector rank by wv
// (shipped: wv = 1, RRF k = 60 over BM25 and vector ranks, rank-normalised within the pool).
// On the synthetic corpora the blend's wrong picks are mostly the vector channel's #1, its right
// picks almost always BM25's #1.
function fusedWith(b: Blend, wv: number): Map<string, number> {
  const K = 60;
  const s = (c: any) => (c.bm25Rank >= 0 ? 1 / (K + c.bm25Rank) : 0) + (c.vecRank >= 0 ? wv / (K + c.vecRank) : 0);
  return new Map([...b.cands].sort((x, y) => s(y) - s(x)).map((c, i, arr) => [c.id, arr.length > 1 ? 1 - i / (arr.length - 1) : 1]));
}
function blendWith(b: Blend, wv: number): string[] {
  const f = fusedWith(b, wv);
  const rrN = b.byRank ? rankNorm(b.cands, c => c.rr) : null;
  const key = (c: Cand) => (b.blendA * (rrN ? rrN.get(c.id)! : c.rr) + (1 - b.blendA) * f.get(c.id)!) * c.stale;
  return [...b.cands].sort((x, y) => key(y) - key(x)).map(c => c.id);
}
for (const wv of [0.75, 0.5, 0.25, 0]) rules.push({ name: `vec w=${wv}`, order: (b) => blendWith(b, wv) });
// Vector weight only on keyword-shaped queries (natural ones keep the shipped fusion).
for (const wv of [0.5, 0.25, 0]) rules.push({ name: `kwvec w=${wv}`, order: (b) => b.natural ? shippedOrder(b) : blendWith(b, wv) });

// Combined: keep the cross-encoder's order when it is sure (top-two logit margin >= dK for keyword
// queries, dN for natural ones); otherwise blend, with the vector rank weighted wv on keyword queries.
const ceMargin = (b: Blend) => {
  const ce = [...b.cands].sort((x, y) => y.rr * y.stale - x.rr * x.stale);
  return { ce, m: ce.length < 2 ? Infinity : logit(ce[0]!.rr * ce[0]!.stale) - logit(ce[1]!.rr * ce[1]!.stale) };
};
for (const wv of [0.25, 0.5]) for (const dK of [1, 1.5, 2, 99]) for (const dN of [1, 1.5, 99]) {
  rules.push({ name: `combo w=${wv} dK=${dK} dN=${dN}`, order: (b) => {
    const { ce, m } = ceMargin(b);
    if (m >= (b.natural ? dN : dK)) return ce.map(c => c.id);
    return b.natural ? shippedOrder(b) : blendWith(b, wv);
  } });
}
const data: Record<string, Probe[]> = {};
for (const s of SUITES) {
  const f = join(dir, `${s}.json`);
  if (existsSync(f)) data[s] = JSON.parse(readFileSync(f, 'utf8'));
}
const present = SUITES.filter(s => data[s]);

// 1. Reproduce the product.
for (const s of present) {
  const ps = data[s]!;
  const withBlend = ps.filter(p => p.blend && p.blend.cands.length > 1);
  const mism = withBlend.filter(p => shippedOrder(p.blend!)[0] !== p.top[0]).length;
  console.log(`${s.padEnd(10)} probes ${String(ps.length).padStart(4)} · blended ${String(withBlend.length).padStart(4)} · shipped-replay mismatches on top-1: ${mism}`);
}

// 2. Score every rule. A probe without a blend keeps AWM's own order under every rule.
const at1 = (ps: Probe[], r: Rule) => ps.filter(p => (p.blend && p.blend.cands.length > 1 ? r.order(p.blend) : p.top)[0] === p.goldId).length;
const at3 = (ps: Probe[], r: Rule) => ps.filter(p => (p.blend && p.blend.cands.length > 1 ? r.order(p.blend) : p.top).slice(0, 3).includes(p.goldId)).length;
const pct = (x: number, n: number) => (100 * x / n).toFixed(1).padStart(5);
console.log(`\ns@1 by rule (s@3 in brackets); real suites: ${[...REAL].filter(s => data[s]).join(', ')}`);
console.log('rule'.padEnd(14) + present.map(s => s.padStart(15)).join(''));
const base: Record<string, number> = {};
for (const s of present) base[s] = at1(data[s]!, rules[0]!);
for (const r of rules) {
  const cells = present.map(s => {
    const ps = data[s]!; const a = at1(ps, r), c = at3(ps, r);
    const flag = REAL.has(s) && a < base[s]! ? '!' : ' ';
    return `${pct(a, ps.length)}${flag}(${pct(c, ps.length)})`.padStart(15);
  });
  console.log(r.name.padEnd(14) + cells.join(''));
}

// 3. Held-out: choose each family's parameter on even probes (no real-suite regression, then the
//    best synthetic mean), report the odd half.
const half = (ps: Probe[], k: 0 | 1) => ps.filter((_, i) => i % 2 === k);
for (const fam of ['logit', 'gate', 'band', 'vec', 'kwvec', 'combo']) {
  const cand = rules.filter(r => r.name.startsWith(fam));
  const score = (r: Rule, k: 0 | 1) => {
    let ok = true; let syn = 0; let nSyn = 0;
    for (const s of present) {
      const h = half(data[s]!, k); const a = at1(h, r), b0 = at1(h, rules[0]!);
      if (REAL.has(s) && a < b0) ok = false;
      if (!REAL.has(s)) { syn += a / h.length; nSyn++; }
    }
    return { ok, syn: nSyn ? syn / nSyn : 0 };
  };
  const picks = cand.map(r => ({ r, ...score(r, 0) })).filter(x => x.ok).sort((a, b) => b.syn - a.syn);
  if (!picks.length) { console.log(`\n${fam}: no setting avoids a real-suite drop on the even half`); continue; }
  const best = picks[0]!.r;
  console.log(`\n${fam}: picked on even half → ${best.name}; odd half:`);
  for (const s of present) {
    const h = half(data[s]!, 1);
    console.log(`  ${s.padEnd(10)} shipped ${pct(at1(h, rules[0]!), h.length)}  ${best.name} ${pct(at1(h, best), h.length)}`);
  }
}
