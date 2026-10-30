/**
 * Which pipeline stage drops the right answer? Runs the production recall (k=3) with the
 * onStages hook and reports, per probe, the last stage the gold memory reached:
 *   bm25 / vector (first-stage retrieval) → scored → topN (graph-walk cut) → pool (minScore)
 *   → rerankPool (what the cross-encoder sees) → top-1.
 * Also reports the gold's rank in the first-stage lists, so a pool-size or fusion change can
 * be sized before it is built.
 *
 *   REALSTORE_FIXTURE=fixture-nl.json npx tsx tests/realstore-eval/stage-diagnose.ts
 */
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const FIX = process.env.REALSTORE_FIXTURE ?? 'fixture-nl.json';
const fx = JSON.parse(readFileSync(join(dir, FIX), 'utf8'));
const items = fx.items as any[];
const work = join(tmpdir(), `awm-stagediag-${process.pid}.db`);
copyFileSync(join(dir, 'snapshot', 'store.db'), work);
// DROP_PATTERNS=1: delete consolidation's pattern-synthesis rows from the copy, to separate
// their crowding of the shortlist from the shortlist's own size and ordering.
if (process.env.DROP_PATTERNS === '1') {
  const Database = (await import('better-sqlite3')).default;
  const d = new Database(work);
  console.log(`dropped ${d.prepare("DELETE FROM engrams WHERE tags LIKE '%synth-type=pattern%'").run().changes} pattern rows`);
  d.close();
}
const store = new EngramStore(work);
const eng = new ActivationEngine(store as any);
const now = Date.parse('2026-08-24T09:27:21.841Z');

const STAGES = ['bm25', 'vector', 'scored', 'topN', 'pool', 'rerankPool'] as const;
const lost: Record<string, number> = { none: 0 };
const ranks: Record<string, number[]> = { bm25: [], vector: [], scored: [] };
let top1 = 0, inRerank = 0;
// DUMP=<name>: save each probe's first-stage lists and scored rerank pool for offline blending.
const dump: any[] = [];
for (const it of items) {
  let st: Record<string, string[]> = {};
  let rp: any[] = [];
  const res: any[] = await eng.activate({ agentId: it.agent ?? 'work', context: it.query, limit: 3, minScore: 0.05,
    requireConfidence: 0.05, internal: true, now, asOf: now, skipCalibratedGate: true, onStages: (s: any) => { st = s; }, onRerankScores: (p: any) => { rp = p; } } as any);
  const g = it.goldId;
  if (process.env.DUMP) dump.push({ goldId: g, top: res.map((r) => r.engram.id), bm25: st.bm25?.slice(0, 200), vector: st.vector?.slice(0, 200), pool: rp });
  for (const k of Object.keys(ranks)) ranks[k]!.push(st[k]?.indexOf(g) ?? -1);
  if (res[0]?.engram.id === g) top1++;
  if (st.rerankPool?.includes(g)) { inRerank++; continue; }
  // the first stage at which the gold is missing (bm25 OR vector counts as retrieved)
  const retrieved = st.bm25?.includes(g) || st.vector?.includes(g);
  const miss = !retrieved ? 'retrieval' : !st.scored?.includes(g) ? 'scored' : !st.topN?.includes(g) ? 'topN'
    : !st.pool?.includes(g) ? 'pool(minScore)' : 'rerankPool';
  lost[miss] = (lost[miss] ?? 0) + 1;
}
store.close();
if (process.env.DUMP) writeFileSync(join(tmpdir(), `awm-dump-${process.env.DUMP}-${FIX.replace('.json', '')}.json`), JSON.stringify(dump));
const n = items.length;
const pct = (x: number) => `${x} (${(100 * x / n).toFixed(1)}%)`;
console.log(`\n${FIX} · ${n} probes · k=3 · top-1 ${pct(top1)} · gold reaches the cross-encoder ${pct(inRerank)}`);
console.log('gold dropped at:', JSON.stringify(lost));
const bucket = (xs: number[]) => {
  const b = { missing: 0, '1': 0, '2-10': 0, '11-40': 0, '41-100': 0, '101+': 0 };
  for (const r of xs) { if (r < 0) b.missing++; else if (r === 0) b['1']++; else if (r < 10) b['2-10']++; else if (r < 40) b['11-40']++; else if (r < 100) b['41-100']++; else b['101+']++; }
  return JSON.stringify(b);
};
for (const k of Object.keys(ranks)) console.log(`gold rank in ${k.padEnd(7)} ${bucket(ranks[k]!)}`);
process.exit(0);
