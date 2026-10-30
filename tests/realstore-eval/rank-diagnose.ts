/**
 * Where does AWM lose the right answer? Per probe, at a wide k, where the gold sits under:
 *   final   — AWM's returned order (what the agent gets)
 *   rerank  — the cross-encoder score alone
 *   textOnly / vectorOnly — the first-stage channels alone
 * and the per-phase signals of the gold vs the winner. Classifies each top-1 miss:
 *   A. not in the pool at all            → first-stage retrieval
 *   B. in pool; cross-encoder also ranks it below #1 → reranker
 *   C. cross-encoder ranks it #1 but the final order does not → AWM's own boosts/reorder
 *
 *   REALSTORE_FIXTURE=fixture-nl.json npx tsx tests/realstore-eval/rank-diagnose.ts
 */
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const FIX = process.env.REALSTORE_FIXTURE ?? 'fixture-nl.json';
const fx = JSON.parse(readFileSync(join(dir, FIX), 'utf8'));
const seeded = <T,>(arr: T[], seed = 1337): T[] => {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};
const LIMIT = Number(process.env.REALSTORE_LIMIT ?? fx.items.length);
const items = seeded(fx.items as any[]).slice(0, LIMIT);
// 10, not more: the rerank pool is max(limit*4, 40), so any limit <= 10 keeps it at 40 — the
// pool production k=3 uses. A wider limit would diagnose a configuration nobody runs.
const WIDE = 10;
const work = join(tmpdir(), `awm-rankdiag-${process.pid}.db`);
copyFileSync(join(dir, 'snapshot', 'store.db'), work);
const store = new EngramStore(work);
const eng = new ActivationEngine(store as any);
const now = Date.parse('2026-08-24T09:27:21.841Z');

const rankBy = (res: any[], key: (r: any) => number, gold: string) =>
  [...res].sort((a, b) => key(b) - key(a)).findIndex((r) => r.engram.id === gold);
const sig = (r: any) => r && ({
  score: +r.score.toFixed(3), rr: +(r.phaseScores.rerankerScore ?? 0).toFixed(3), text: +(r.phaseScores.textMatch ?? 0).toFixed(3),
  vec: +(r.phaseScores.vectorMatch ?? 0).toFixed(3), decay: +(r.phaseScores.decayScore ?? 0).toFixed(3),
  hebb: +(r.phaseScores.hebbianBoost ?? 0).toFixed(3), graph: +(r.phaseScores.graphBoost ?? 0).toFixed(3),
  conf: +(r.phaseScores.confidenceGate ?? 0).toFixed(3), len: r.engram.content.length, cls: r.engram.memoryClass,
});

const rows: any[] = [];
for (const it of items) {
  const res: any[] = await eng.activate({ agentId: it.agent ?? 'work', context: it.query, limit: WIDE, minScore: 0, requireConfidence: 0,
    internal: true, now, asOf: now, skipCalibratedGate: true } as any);
  const g = it.goldId;
  const finalRank = res.findIndex((r) => r.engram.id === g);
  const row = {
    goldId: g, query: it.query, finalRank,
    rerankRank: finalRank < 0 ? -1 : rankBy(res, (r) => r.phaseScores.rerankerScore ?? 0, g),
    textRank: finalRank < 0 ? -1 : rankBy(res, (r) => r.phaseScores.textMatch ?? 0, g),
    vectorRank: finalRank < 0 ? -1 : rankBy(res, (r) => r.phaseScores.vectorMatch ?? 0, g),
    gold: sig(res[finalRank]), top: sig(res[0]),
  };
  rows.push(row);
}
store.close();
writeFileSync(join(tmpdir(), `awm-rankdiag-${FIX.replace('.json', '')}.json`), JSON.stringify(rows));

const n = rows.length;
const hit1 = rows.filter((r) => r.finalRank === 0).length;
const miss = rows.filter((r) => r.finalRank !== 0);
const A = miss.filter((r) => r.finalRank < 0);
const B = miss.filter((r) => r.finalRank > 0 && r.rerankRank > 0);
const C = miss.filter((r) => r.finalRank > 0 && r.rerankRank === 0);
console.log(`\n${FIX} · ${n} probes · AWM top-1 ${hit1} (${(100 * hit1 / n).toFixed(1)}%)`);
console.log(`misses ${miss.length}:`);
console.log(`  A. not in the top-${WIDE} pool         ${A.length}`);
console.log(`  B. in pool, cross-encoder also below #1  ${B.length}`);
console.log(`  C. cross-encoder ranks it #1, final order does not  ${C.length}   <- AWM's own scoring overrode the reranker`);
// Oracle orderings within the same pool: what top-1 would be if we sorted by one signal.
const oracle = (k: string) => rows.filter((r) => r.finalRank >= 0 && (r as any)[k] === 0).length;
console.log(`\nwithin the same ${WIDE}-candidate pool, top-1 if ordered by:`);
console.log(`  AWM final order    ${hit1}`);
console.log(`  cross-encoder only ${oracle('rerankRank')}`);
console.log(`  text match only    ${oracle('textRank')}`);
console.log(`  vector only        ${oracle('vectorRank')}`);
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
if (C.length) {
  console.log(`\nC cases — gold vs winner, medians: rr ${med(C.map((r) => r.gold.rr))} vs ${med(C.map((r) => r.top.rr))}`
    + ` · decay ${med(C.map((r) => r.gold.decay))} vs ${med(C.map((r) => r.top.decay))}`
    + ` · hebb ${med(C.map((r) => r.gold.hebb))} vs ${med(C.map((r) => r.top.hebb))}`
    + ` · conf ${med(C.map((r) => r.gold.conf))} vs ${med(C.map((r) => r.top.conf))}`
    + ` · len ${med(C.map((r) => r.gold.len))} vs ${med(C.map((r) => r.top.len))}`);
}
if (B.length) {
  console.log(`B cases — gold rerank rank median ${med(B.map((r) => r.rerankRank))}; gold rr ${med(B.map((r) => r.gold.rr))} vs winner rr ${med(B.map((r) => r.top.rr))}`
    + ` · gold len ${med(B.map((r) => r.gold.len))} vs winner len ${med(B.map((r) => r.top.len))}`);
}
process.exit(0);
