/**
 * Offline: how should the cross-encoder's verdict be combined with the first-stage ranks?
 * Reads the per-probe dumps stage-diagnose.ts writes with DUMP=<name> (each rerank-pool
 * candidate's cross-encoder score, plus the BM25 and vector rank lists) and scores top-1
 * for several orderings of the SAME pool, so no recall is re-run.
 *
 *   npx tsx tests/realstore-eval/blend-offline.ts A
 *
 * Orderings (RRF k=60; ranks are within the full first-stage lists, rr rank within the pool):
 *   shipped       AWM's own returned order
 *   rr            cross-encoder score alone
 *   rrf2          BM25 rank + vector rank, no cross-encoder
 *   rrf3(w)       rrf2 + w × cross-encoder rank
 * To keep the choice of w honest, w is picked on even-indexed probes and reported on odd ones.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const name = process.argv[2] ?? 'A';
const K = 60;
type Cand = { id: string; rr: number };
type Probe = { goldId: string; top: string[]; bm25?: string[]; vector?: string[]; pool: Cand[] };

function order(p: Probe, w: number | null): string[] {
  const b = new Map((p.bm25 ?? []).map((id, i) => [id, i]));
  const v = new Map((p.vector ?? []).map((id, i) => [id, i]));
  const rrRank = new Map([...p.pool].sort((x, y) => y.rr - x.rr).map((c, i) => [c.id, i]));
  const s = (id: string) => {
    let x = 0;
    const bi = b.get(id); if (bi !== undefined) x += 1 / (K + bi);
    const vi = v.get(id); if (vi !== undefined) x += 1 / (K + vi);
    if (w !== null) x += w / (K + rrRank.get(id)!);
    return x;
  };
  return [...p.pool].sort((x, y) => s(y.id) - s(x.id)).map((c) => c.id);
}
const at1 = (ps: Probe[], f: (p: Probe) => string[]) => ps.filter((p) => f(p)[0] === p.goldId).length;
const pct = (x: number, n: number) => `${(100 * x / n).toFixed(1)}%`.padStart(6);
const WS = [0.5, 1, 1.5, 2, 3, 5];

for (const fx of ['fixture-nl', 'fixture-category', 'fixture']) {
  const f = join(tmpdir(), `awm-dump-${name}-${fx}.json`);
  if (!existsSync(f)) { console.log(`${fx}: no dump`); continue; }
  const ps = JSON.parse(readFileSync(f, 'utf8')) as Probe[];
  const n = ps.length;
  const even = ps.filter((_, i) => i % 2 === 0), odd = ps.filter((_, i) => i % 2 === 1);
  const bestW = WS.reduce((a, w) => (at1(even, (p) => order(p, w)) > at1(even, (p) => order(p, a)) ? w : a), WS[0]!);
  console.log(`\n${name} · ${fx} · ${n} probes`);
  console.log(`  shipped ${pct(at1(ps, (p) => p.top), n)}   rr ${pct(at1(ps, (p) => [...p.pool].sort((x, y) => y.rr - x.rr).map((c) => c.id)), n)}   rrf2 ${pct(at1(ps, (p) => order(p, null)), n)}`);
  console.log(`  rrf3(w): ${WS.map((w) => `w=${w} ${pct(at1(ps, (p) => order(p, w)), n)}`).join('  ')}`);
  console.log(`  held-out: w picked on even = ${bestW}; odd half shipped ${pct(at1(odd, (p) => p.top), odd.length)} vs rrf3 ${pct(at1(odd, (p) => order(p, bestW)), odd.length)}`);
}

// Convex combination on scores (Bruch et al.): final = a·rr + (1−a)·minmax(rrf2) within the pool.
// The cross-encoder's own confidence then decides how much it overrides the first stage.
// One `a` for all fixtures, chosen by the mean of the three top-1 rates, so no fixture gets its own.
function convex(p: Probe, a: number): string[] {
  const f = new Map(order(p, null).map((id, i, arr) => [id, arr.length > 1 ? 1 - i / (arr.length - 1) : 1]));
  return [...p.pool].sort((x, y) => (a * y.rr + (1 - a) * f.get(y.id)!) - (a * x.rr + (1 - a) * f.get(x.id)!)).map((c) => c.id);
}
const sets = ['fixture-nl', 'fixture-category', 'fixture'].map((fx) => {
  const f = join(tmpdir(), `awm-dump-${name}-${fx}.json`);
  return existsSync(f) ? { fx, ps: JSON.parse(readFileSync(f, 'utf8')) as Probe[] } : null;
}).filter(Boolean) as Array<{ fx: string; ps: Probe[] }>;
const AS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
console.log(`\nconvex a·rr + (1−a)·rank-normalised rrf2 — top-1 per fixture (shipped in brackets)`);
for (const a of AS) {
  console.log(`  a=${a}`.padEnd(9) + sets.map(({ fx, ps }) => `${fx.replace('fixture-', '').replace('fixture', 'ident')} ${pct(at1(ps, (p) => convex(p, a)), ps.length)} (${pct(at1(ps, (p) => p.top), ps.length).trim()})`).join('   '));
}

// Same blend on the cross-encoder's RANK within the pool (rank-normalised 0..1) instead of its
// sigmoid score: for a model whose scores saturate near 1, the score carries no order at the top.
function convexRank(p: Probe, a: number): string[] {
  const rrN = new Map([...p.pool].sort((x, y) => y.rr - x.rr).map((c, i, arr) => [c.id, arr.length > 1 ? 1 - i / (arr.length - 1) : 1]));
  const f = new Map(order(p, null).map((id, i, arr) => [id, arr.length > 1 ? 1 - i / (arr.length - 1) : 1]));
  const k = (id: string) => a * rrN.get(id)! + (1 - a) * f.get(id)!;
  return [...p.pool].sort((x, y) => k(y.id) - k(x.id)).map((c) => c.id);
}
console.log(`\nconvex on ranks: a·rank(rr) + (1−a)·rank(rrf2)`);
for (const a of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  console.log(`  a=${a}`.padEnd(9) + sets.map(({ fx, ps }) => `${fx.replace('fixture-', '').replace('fixture', 'ident')} ${pct(at1(ps, (p) => convexRank(p, a)), ps.length)}`).join('   '));
}
console.log('  rr alone '.padEnd(9) + sets.map(({ fx, ps }) => `${fx.replace('fixture-', '').replace('fixture', 'ident')} ${pct(at1(ps, (p) => [...p.pool].sort((x, y) => y.rr - x.rr).map((c) => c.id)), ps.length)}`).join('   '));

// Route the blend weight by the QUERY'S SHAPE (Robert, 2026-10-30: "the type of question could be
// a signal"). The shape comes from the query text only, never from which fixture it is in. Dumps
// are in fixture order (stage-diagnose.ts does not shuffle), so dump[i] is fixture item i.
const FX: Record<string, string> = { 'fixture-nl': 'fixture-nl.json', 'fixture-category': 'fixture-category.json', 'fixture': 'fixture.json' };
const SW = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that not but all any can will would should could into than then there their they them its we our i my you why about'.split(' '));
const natural = (q: string) => {
  const w = q.toLowerCase().match(/[a-z0-9_.\-/]+/g) ?? [];
  const qword = /^(what|how|why|when|where|which|who|did|do|does|is|are|was|were|can|should|has|have)\b/i.test(q.trim()) || q.trim().endsWith('?');
  return qword || w.filter((t) => SW.has(t)).length / Math.max(1, w.length) >= 0.3;
};
console.log('\nrouted by query shape: natural -> a_nat, keyword -> a_kw   (share of each fixture routed natural)');
const queries = Object.fromEntries(sets.map(({ fx }) => [fx, (JSON.parse(readFileSync(join(import.meta.dirname, FX[fx]!), 'utf8')).items as any[]).map((i) => String(i.query))]));
for (const fx of Object.keys(queries)) {
  const qs = queries[fx]!; console.log(`  ${fx}: ${(100 * qs.filter(natural).length / qs.length).toFixed(1)}% routed natural`);
}
for (const [aNat, aKw] of [[0.5, 0.85], [0.5, 0.9], [0.6, 0.85], [0.7, 0.85], [0.5, 0.95]] as const) {
  console.log(`  a_nat=${aNat} a_kw=${aKw}  ` + sets.map(({ fx, ps }) => {
    const qs = queries[fx]!;
    const hit = ps.filter((p, i) => convex(p, natural(qs[i] ?? '') ? aNat : aKw)[0] === p.goldId).length;
    return `${fx.replace('fixture-', '').replace('fixture', 'ident')} ${pct(hit, ps.length)}`;
  }).join('   '));
}
