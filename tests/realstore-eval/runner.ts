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

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const FIXTURE = join(import.meta.dirname, 'fixture.json');
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
  const items: Item[] = fx.items.slice(0, limit);
  const advs: Item[] = fx.adversarialItems;

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

  for (const it of items) {
    const res: any[] = await activation.activate({
      agentId: 'work', context: it.query, limit: RECALL_LIMIT,
      granularity: GRANULARITY, internal: true,
    } as any);
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
  console.log(`  adversarial correctly silent: ${pct(abstained, advs.length)}   <- selectivity is rewarded here\n`);

  console.log('  BY IDENTIFIER POSITION (the 400-char rerank window):');
  for (const [k, v] of Object.entries(buckets)) {
    if (!v.length) continue;
    console.log(`    ${k.padEnd(16)} n=${String(v.length).padStart(4)}   s@1 ${pct(v.filter(Boolean).length, v.length).padStart(6)}`);
  }
  console.log('\n  BY MEMORY CLASS:');
  for (const [k, v] of Object.entries(byClass)) {
    console.log(`    ${k.padEnd(16)} n=${String(v.length).padStart(4)}   s@1 ${pct(v.filter(Boolean).length, v.length).padStart(6)}`);
  }

  // Economics: a hit saves the fallback minus what the recall itself cost; a
  // miss means the agent pays the fallback anyway and AWM contributed nothing.
  const avgHitCost = s5 > 0 ? usefulTok / s5 : 0;
  const net = Math.round(s5 * (FALLBACK_TOKENS - avgHitCost) - missTok - advWasteTok);
  console.log('\n  TOKEN ECONOMICS (vs ~2,106-token cost of reading the code instead):');
  console.log(`    useful ${usefulTok.toLocaleString()} tok · wasted ${(missTok + advWasteTok).toLocaleString()} tok`);
  console.log(`    NET SAVED ${net.toLocaleString()} tok over ${n} recalls  (${Math.round(net / Math.max(n, 1))}/recall)\n`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
