// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * For every query the pinned run MISSED (gold not in top-k), find the STAGE where the
 * gold was lost. Re-runs each miss at a wide k with the same pinned clock and asks:
 *
 *   A. is the gold in the top-K at all?        -> if no: never entered the pool (retrieval)
 *   B. if yes, what rank, and its rerankerScore vs the winner's?  (rerank ordering)
 *   C. did the passage the reranker saw actually contain the identifier?
 *
 * MEMORY: the first version held one engine for all 88 misses and reached 4.4 GB RSS
 * (native ONNX buffers + sqlite page cache, NOT V8 heap — --max-old-space-size did
 * not bind) and was OOM-killed three times on a box already at 94% commit. This
 * version is INCREMENTAL: it appends one JSON line per miss to an output file as it
 * goes, skips misses already in that file on restart, and processes in batches of
 * BATCH misses per process — run it in a shell loop and it resumes where it stopped.
 *
 *   REALSTORE_TRACE=<trace.jsonl> PROBE_OUT=<out.jsonl> PROBE_BATCH=15 \
 *     npx tsx tests/realstore-eval/miss-stage-probe.ts
 *   (exit code 3 = more to do; 0 = all misses probed)
 *
 * Summarize with: npx tsx tests/realstore-eval/miss-stage-probe.ts --summary
 */
import { readFileSync, copyFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = import.meta.dirname;
const TRACE = process.env.REALSTORE_TRACE ?? join(HERE, 'trace-pinned-aug24.jsonl');
const OUT = process.env.PROBE_OUT ?? join(HERE, 'miss-stage-pinned-aug24.jsonl');
const WIDE_K = Number(process.env.PROBE_K ?? 50);
const BATCH = Number(process.env.PROBE_BATCH ?? 15);

const fx = JSON.parse(readFileSync(join(HERE, 'fixture.json'), 'utf8'));
const byGold = new Map<string, any>(fx.items.map((it: any) => [it.goldId, it]));
const trace = readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const misses = trace.filter(r => r.rank < 0);
const done = new Set<string>(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).goldId) : []);

if (process.argv.includes('--summary')) {
  const rows = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const notInWide = rows.filter(r => r.wideRank < 0).length;
  const inWide = rows.filter(r => r.wideRank >= 0);
  const hist: Record<string, number> = {};
  for (const r of inWide) { const b = r.wideRank < 5 ? '4-5' : r.wideRank < 10 ? '6-10' : r.wideRank < 20 ? '11-20' : '21-50'; hist[b] = (hist[b] ?? 0) + 1; }
  const gaps = inWide.map(r => r.rrGap).filter((g: number) => g !== null).sort((a: number, b: number) => a - b);
  const identIn = inWide.filter(r => r.identInPassage === true).length;
  console.log(`misses probed: ${rows.length} of ${misses.length}  (wide k=${WIDE_K})`);
  console.log(`  A. gold NOT in top-${WIDE_K}      : ${notInWide}  (${(100 * notInWide / rows.length).toFixed(0)}%)  <- never retrieved into the pool`);
  console.log(`  B. gold in top-${WIDE_K}, not top-3: ${inWide.length}  (${(100 * inWide.length / rows.length).toFixed(0)}%)  <- reranker saw it, ranked it lower`);
  console.log(`     rank buckets: ${JSON.stringify(hist)}`);
  if (gaps.length) console.log(`     reranker gap (winner - gold): median ${gaps[gaps.length >> 1].toFixed(3)}  p25 ${gaps[gaps.length >> 2].toFixed(3)}  p75 ${gaps[(gaps.length * 3) >> 2].toFixed(3)}  max ${gaps[gaps.length - 1].toFixed(3)}`);
  console.log(`  C. identifier IN the passage the reranker saw: ${identIn} of ${inWide.length}   absent: ${inWide.length - identIn}`);
  console.log('\nexamples (in-pool misses):');
  for (const r of inWide.slice(0, 6)) console.log(`  rank ${r.wideRank + 1}  rr gold ${r.rrGold?.toFixed(3)} vs win ${r.rrWin?.toFixed(3)}  ident-in-passage=${r.identInPassage}\n    Q: ${r.query.slice(0, 72)}\n    gold: ${r.goldConcept.slice(0, 64)}\n    win : ${r.winConcept.slice(0, 64)}`);
  process.exit(0);
}

const todo = misses.filter(m => !done.has(m.goldId)).slice(0, BATCH);
if (todo.length === 0) { console.log(`all ${misses.length} misses already probed -> ${OUT}`); process.exit(0); }

const { EngramStore } = await import('../../src/storage/sqlite.js');
const { ActivationEngine } = await import('../../src/engine/activation.js');
const { buildRerankPassage, rerankTruncation, rerankWindowMode } = await import('../../src/core/rerank-window.js');

const SNAP = join(HERE, 'snapshot', process.env.REALSTORE_SNAPSHOT ?? 'store.db');
const WORK = join(tmpdir(), `awm-missprobe-${process.pid}.db`);
copyFileSync(SNAP, WORK);
const store = new EngramStore(WORK);
const eng = new ActivationEngine(store);
const NOW = Date.parse(((store as any).db.prepare('SELECT MAX(created_at) AS m FROM engrams').get() as { m: string }).m);

for (const m of todo) {
  const it = byGold.get(m.goldId);
  // 0.14.5: query as the gold's own agent (fixture `agent`); 'work' hardcoded here scored
  // every personal gold as 'not in pool' by construction.
  const res: any[] = await eng.activate({ agentId: it?.agent ?? 'work', context: m.query, limit: WIDE_K, internal: true, now: NOW, asOf: NOW } as any);
  const idx = res.findIndex(r => r.engram.id === m.goldId);
  const row: any = { goldId: m.goldId, query: m.query, wideRank: idx, rrGold: null, rrWin: null, rrGap: null, identInPassage: null, goldConcept: '', winConcept: res[0]?.engram?.concept ?? '' };
  if (idx >= 0) {
    const gold = res[idx], win = res[0];
    row.rrGold = gold.phaseScores?.rerankerScore ?? null;
    row.rrWin = win.phaseScores?.rerankerScore ?? null;
    row.rrGap = row.rrWin !== null && row.rrGold !== null ? row.rrWin - row.rrGold : null;
    row.goldConcept = gold.engram.concept;
    const ident = String(it?.identifier ?? '').toLowerCase();
    const passage = buildRerankPassage(gold.engram.concept, gold.engram.content, m.query, rerankTruncation(), rerankWindowMode(), gold.engram.tags).toLowerCase();
    row.identInPassage = ident ? passage.includes(ident) : null;
  }
  appendFileSync(OUT, JSON.stringify(row) + '\n');
}

store.close();
for (const s of ['', '-wal', '-shm']) { try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch {} }
const remaining = misses.length - done.size - todo.length;
console.log(`probed ${todo.length} this batch; ${done.size + todo.length}/${misses.length} done; ${remaining} remaining`);
process.exit(remaining > 0 ? 3 : 0);
