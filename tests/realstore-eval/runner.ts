/**
 * Real-store benchmark — the replacement for LoCoMo.
 *
 * WHY LoCoMo WAS RETIRED
 * ----------------------
 * It was useful for learning how to benchmark this product, but it does not
 * represent the system. Measured differences against the live store:
 *   - LoCoMo passages median 115 chars; real canonical memories median 1,965
 *   - LoCoMo is seeded in one shot, so ACT-R decay, Hebbian weights and
 *     salience reinforcement are all near-uniform and contribute nothing
 *   - LoCoMo has no supersession, no staging history, no cross-session use
 *   - LoCoMo REWARDS indiscriminate retention, so AWM's salience filter — the
 *     product — caps its score at ~50% no matter how good ranking gets
 *   - and it is structurally blind to the 400-char rerank truncation, which
 *     affects 79% of real ground-truth identifiers
 *
 * WHAT THIS MEASURES INSTEAD
 * --------------------------
 *   corpus      the real store, frozen (real lengths, decay, supersession, edges)
 *   queries     the real keyword-dense register, not invented questions
 *   truth       unique-identifier hold-out, verified through FTS
 *   selectivity correct abstention scores POSITIVELY
 *   economics   net tokens saved vs the ~2,106-token cost of the agent going
 *               and reading the codebase instead
 *
 * Each run works on a COPY of the snapshot: activation mutates access counts and
 * auto-checkpoint state, and a benchmark must not drift the thing it measures.
 *
 * Run: npx tsx tests/realstore-eval/runner.ts
 *      REALSTORE_LIMIT=300 npx tsx tests/realstore-eval/runner.ts   (subset)
 */
import { readFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { recallConfigFingerprint } from '../../src/core/recall-config.js';

// Selectable so option 1 can run against a re-embedded (backfilled) copy.
const SNAP = join(import.meta.dirname, 'snapshot', process.env.REALSTORE_SNAPSHOT ?? 'store.db');
// Fixture is selectable: the identifier fixture cannot express options that add
// vocabulary the body lacks (its gold contains the query term 300/300 by
// construction), so the category fixture exists for those. Same metrics either way.
const FIXTURE = join(import.meta.dirname, process.env.REALSTORE_FIXTURE ?? 'fixture.json');
const WORK = join(tmpdir(), `awm-realstore-${process.pid}.db`);

/** Cost the agent pays when AWM does NOT surface the fact: it reads the code. */
const FALLBACK_TOKENS = 2106;
/** Real recalls return ~6.7 results on average in this store; 10 was arbitrary. */
const RECALL_LIMIT = Number(process.env.REALSTORE_K ?? 7);
const GRANULARITY = (process.env.REALSTORE_GRANULARITY ?? 'full') as 'full' | 'compact' | 'auto';
const est = (s: string) => Math.max(Math.ceil(s.split(/\s+/).filter(Boolean).length * 1.3), Math.ceil(s.length / 4));

interface Item {
  query: string; goldId: string | null; identifier: string | null;
  offset?: number; contentLen?: number; memoryClass?: string;
  beyondTruncation?: boolean; adversarial?: boolean;
}

async function main() {
  if (!existsSync(SNAP)) { console.error('no snapshot — run node tests/realstore-eval/snapshot.mjs'); process.exit(1); }
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const limit = Number(process.env.REALSTORE_LIMIT ?? fx.items.length);
  // Held-out slice support: a fix diagnosed on one slice must be confirmed on
  // data it was not tuned against, or it is just overfitting.
  const offset = Number(process.env.REALSTORE_OFFSET ?? 0);
  // DETERMINISTIC SHUFFLE before slicing. The fixture is written in goldId
  // order, so `slice(0, n)` is a biased PREFIX, not a sample — measured, 60
  // prefix probes gave s@1 41.7% where 450 gave 56.4%, which reads as noise but
  // is actually a different query population. A seeded shuffle makes a small n
  // representative, so short runs are comparable to long ones and to each
  // other. The seed is fixed, so the sample is identical across arms.
  const seeded = (arr: Item[], seed = 1337): Item[] => {
    const a = [...arr];
    let x = seed;
    for (let i = a.length - 1; i > 0; i--) {
      x = (x * 1664525 + 1013904223) >>> 0;          // LCG — reproducible
      const j = x % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const pool: Item[] = process.env.REALSTORE_NO_SHUFFLE === '1' ? fx.items : seeded(fx.items);
  const items: Item[] = pool.slice(offset, offset + limit);
  // Adversarial probes are generic absent-fact queries, valid for ANY fixture —
  // fall back to the identifier fixture's set so the selectivity guard still
  // runs when a fixture (e.g. category) does not define its own.
  const advs: Item[] = fx.adversarialItems
    ?? JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.json'), 'utf8')).adversarialItems
    ?? [];

  for (const s of ['', '-wal', '-shm']) { try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch {} }
  copyFileSync(SNAP, WORK);

  const store = new EngramStore(WORK);
  const activation = new ActivationEngine(store);

  console.log(`\nREAL-STORE BENCHMARK · arm=${recallConfigFingerprint()}`);
  console.log(`k=${RECALL_LIMIT} granularity=${GRANULARITY}`);
  console.log(`corpus ${fx.corpusEngrams} engrams · ${items.length} answerable · ${advs.length} adversarial\n`);

  const buckets = {
    'visible (<400)': [] as boolean[],
    'beyond (>400)': [] as boolean[],
  };
  const byClass: Record<string, boolean[]> = {};
  let s1 = 0, s5 = 0, rr = 0, usefulTok = 0, missTok = 0, n = 0;
  // Read-time cost is a campaign guard: warm recall is ~900ms and already ~90%
  // cross-encoder, so an arm that buys accuracy with latency has moved the cost.
  const lat: number[] = [];
  // SUFFICIENCY: retrieval is only half the job. If the delivered text does not
  // contain the answer-bearing identifier, the agent got a pointer, not a fact —
  // and still has to go read the code, so the token saving is illusory.
  let sufficient = 0, retrievedForSuff = 0;

  for (const it of items) {
    const _t0 = process.hrtime.bigint();
    const res: any[] = await activation.activate({
      agentId: 'work', context: it.query, limit: RECALL_LIMIT,
      granularity: GRANULARITY, internal: true,
    } as any);
    lat.push(Number(process.hrtime.bigint() - _t0) / 1e6);
    const idx = res.findIndex(r => r.engram.id === it.goldId);
    const hit1 = idx === 0;
    const hit5 = idx >= 0 && idx < 5;
    n++;
    if (hit1) s1++;
    if (hit5) s5++;
    if (idx >= 0) rr += 1 / (idx + 1);

    // Cost what the agent ACTUALLY receives. Charging full bodies when the
    // caller asked for compact summaries overstates the price of a recall and
    // makes the economics look worse than they are.
    const text = res.map(r => `${r.engram.concept}: ${r.summary ?? r.engram.content}`).join('\n');
    if (hit5) usefulTok += est(text); else missTok += est(text);

    if (idx >= 0 && (it.identifier || (it as any).category)) {
      retrievedForSuff++;
      const needle = String(it.identifier ?? (it as any).category).toLowerCase();
      const delivered = String(res[idx].summary ?? res[idx].engram.content).toLowerCase();
      if (delivered.includes(needle)) sufficient++;
    }

    (it.beyondTruncation ? buckets['beyond (>400)'] : buckets['visible (<400)']).push(hit1);
    const c = it.memoryClass ?? 'unknown';
    (byClass[c] ??= []).push(hit1);
  }

  // Selectivity: silence on absent facts is the CORRECT answer and is rewarded.
  let abstained = 0, advWasteTok = 0;
  for (const a of advs) {
    const res: any[] = await activation.activate({
      agentId: 'work', context: a.query, limit: 10, minScore: 0.3, abstentionThreshold: 0.3, internal: true,
    } as any);
    if (res.length === 0) abstained++;
    else advWasteTok += est(res.map(r => `${r.engram.concept}: ${r.engram.content}`).join('\n'));
  }

  store.close?.();
  for (const s of ['', '-wal', '-shm']) { try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch {} }

  const pct = (k: number, d: number) => (d ? `${(100 * k / d).toFixed(1)}%` : '—');
  console.log(`  success@1 ${pct(s1, n)}   success@5 ${pct(s5, n)}   MRR ${(rr / Math.max(n, 1) * 100).toFixed(1)}%`);
  console.log(`  adversarial correctly silent: ${pct(abstained, advs.length)}   <- selectivity is rewarded here`);
  const sorted = [...lat].sort((a, b) => a - b);
  const p = (q: number) => (sorted.length ? sorted[Math.floor(sorted.length * q)] : 0);
  console.log(`  recall latency  p50 ${p(0.5).toFixed(0)}ms  p90 ${p(0.9).toFixed(0)}ms  (n=${sorted.length})`);
  // Retrieval is only half the job. A summary that ranks the right memory first
  // but omits the answer-bearing identifier leaves the agent still needing to go
  // read the code — so the token "saving" is illusory. EFFECTIVE = both.
  console.log(`  SUFFICIENCY ${pct(sufficient, retrievedForSuff)} of retrieved golds actually CONTAIN the answer` +
              `  (${sufficient}/${retrievedForSuff})`);
  console.log(`  EFFECTIVE ANSWER RATE ${pct(sufficient, n)}  (retrieved AND sufficient, of all ${n})\n`);

  console.log('  BY IDENTIFIER POSITION (the 400-char rerank window):');
  for (const [k, v] of Object.entries(buckets)) {
    if (!v.length) continue;
    console.log(`    ${k.padEnd(16)} n=${String(v.length).padStart(4)}   s@1 ${pct(v.filter(Boolean).length, v.length).padStart(6)}`);
  }
  console.log('\n  BY MEMORY CLASS:');
  for (const [k, v] of Object.entries(byClass)) {
    console.log(`    ${k.padEnd(16)} n=${String(v.length).padStart(4)}   s@1 ${pct(v.filter(Boolean).length, v.length).padStart(6)}`);
  }

  // ECONOMICS — credit only SUFFICIENT recalls.
  //
  // The earlier version credited any top-5 retrieval with saving the fallback.
  // That is wrong in exactly the way the H3 "efficiency" metric was wrong: it
  // treats a recall that ranks the right memory first but omits the answer as a
  // win, when the agent must still go read the code and pays the fallback
  // anyway. Only a recall that DELIVERS the fact avoids that cost.
  //
  //   sufficient recall  -> avoids FALLBACK_TOKENS, having spent its own tokens
  //   retrieved-but-not-sufficient -> spent tokens AND still pays the fallback
  //   miss               -> spent tokens AND still pays the fallback
  const spentTok = usefulTok + missTok + advWasteTok;
  const net = sufficient * FALLBACK_TOKENS - spentTok;
  console.log('  TOKEN ECONOMICS (credit only recalls that DELIVER the answer):');
  console.log(`    spent ${spentTok.toLocaleString()} tok · answers delivered ${sufficient}/${n}`);
  console.log(`    NET ${net >= 0 ? '+' : ''}${net.toLocaleString()} tok over ${n} recalls  ` +
              `(${net >= 0 ? '+' : ''}${Math.round(net / Math.max(n, 1))}/recall)
`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
