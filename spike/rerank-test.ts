/**
 * Test rerank batch vs loop directly.
 */
import { rerank } from '../src/core/reranker.js';

const passages = [
  'USEF Results Export Skill Created — automates the 7-step process',
  'USEF results skill updated with API and officials lookup',
  'USEF API field name traps — singular vs plural',
  'USEF May 7 2026 finalized batch — canonical record',
  'USEF results May 7 2026 batch finalized',
  'random unrelated content about coffee',
  'database migration plan for the next sprint',
  'AWM BM25 latency root cause SQLite plan trap',
  'channel push delivery telemetry',
  'salience filter user feedback auto-promote',
  'recall latency optimization 0.7.6 -> 0.7.13',
  'sprint plan for cycle 27 EquiHub',
  'pool reduction filter survivors candidates',
  'cross-encoder reranker top-K reduction',
  'short content',
];

async function main() {
  // Warm
  await rerank('warmup', ['warmup1', 'warmup2']);

  console.log('\n=== Re-rank perf ===\n');

  for (let trial = 0; trial < 3; trial++) {
    const t0 = process.hrtime.bigint();
    const results = await rerank('USEF results submission', passages);
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`Trial ${trial + 1}: ${elapsed.toFixed(0)}ms — top: "${passages[results[0].index].slice(0, 60)}" (${results[0].score.toFixed(3)})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
