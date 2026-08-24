/**
 * Long-memory truncation eval.
 *
 * Measures success@1 and the gold's own cross-encoder score as a function of
 * WHERE IN THE MEMORY the answer sits. Everything else is held constant, so any
 * cliff is attributable to position alone.
 *
 * The key diagnostic is `gold rerank` per bucket: the reranker sees only the
 * first 400 chars (activation.ts:867), so if truncation is the mechanism, the
 * gold's cross-encoder score should collapse once the answer moves past that
 * boundary — while BM25 (which indexes full content, sqlite.ts:251) still finds
 * it. That combination is "retrievable but not rankable".
 *
 * Arms:
 *   (default)                      current behaviour
 *   AWM_RERANK2=1                  phase 9b on — makes the reranker authoritative
 *   AWM_RERANK_WINDOW=query        query-aware densest window instead of prefix
 *   AWM_RERANK_TRUNC=1200          wider fixed prefix
 *
 * Run: npx tsx tests/longmem-eval/runner.ts
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { buildCorpus, BUCKETS } from './corpus.js';

const DB = join(import.meta.dirname, '..', '..', 'data', '_longmem.db');
const AGENT = 'longmem-eval';

async function main() {
  for (const e of ['', '-wal', '-shm']) { try { if (existsSync(DB + e)) unlinkSync(DB + e); } catch { /* */ } }

  const arm = [
    process.env.AWM_RERANK2 === '1' ? 'rerank2' : null,
    process.env.AWM_RERANK_WINDOW ? `window=${process.env.AWM_RERANK_WINDOW}` : null,
    process.env.AWM_RERANK_TRUNC ? `trunc=${process.env.AWM_RERANK_TRUNC}` : null,
  ].filter(Boolean).join('+') || 'baseline';

  const corpus = buildCorpus(Number(process.env.LONGMEM_REPS ?? 3));
  const store = new EngramStore(DB);
  const activation = new ActivationEngine(store);
  const connections = new ConnectionEngine(store, activation);

  process.stderr.write(`seeding ${corpus.length} long memories...\n`);
  const idOf = new Map<string, string>();
  for (const m of corpus) {
    const res: any = await performWrite({ store, connectionEngine: connections } as any, {
      agentId: AGENT, concept: m.concept, content: m.content,
      project: 'LongMem', topic: m.id.split('-')[0],
      intent: 'finding', confidenceLevel: 'verified',
      memoryClass: 'canonical',        // matches the real store's long-memory class
      tags: [m.id],
    } as any);
    if (res?.engram?.id) idOf.set(m.id, res.engram.id);
  }

  const byBucket = new Map<string, { n: number; s1: number; s5: number; ranks: number[]; gr: number[]; tm: number[] }>();
  for (const b of BUCKETS) byBucket.set(b.name, { n: 0, s1: 0, s5: 0, ranks: [], gr: [], tm: [] });

  for (const m of corpus) {
    const goldId = idOf.get(m.id);
    if (!goldId) continue;
    const results: any[] = await activation.activate({
      agentId: AGENT, context: m.query, limit: 10, internal: true,
    } as any);

    const idx = results.findIndex(r => r.engram.id === goldId);
    const rank = idx < 0 ? 0 : idx + 1;
    const bucket = byBucket.get(m.bucket)!;
    bucket.n++;
    if (rank === 1) bucket.s1++;
    if (rank >= 1 && rank <= 5) bucket.s5++;
    bucket.ranks.push(rank);
    if (idx >= 0) {
      bucket.gr.push(results[idx].phaseScores?.rerankerScore ?? 0);
      bucket.tm.push(results[idx].phaseScores?.textMatch ?? 0);
    }
  }
  store.close?.();

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pct = (k: number, d: number) => (d ? `${(100 * k / d).toFixed(1)}%` : '—');

  console.log(`\n${'='.repeat(84)}`);
  console.log(` LONG-MEMORY TRUNCATION EVAL  ·  arm=${arm}  ·  ${corpus.length} memories`);
  console.log(` (reranker truncates passages at 400 chars — buckets straddle that boundary)`);
  console.log('='.repeat(84));
  console.log(' answer offset        n    s@1      s@5     mean rank   gold rerank   gold BM25');
  console.log(' ' + '-'.repeat(82));
  for (const b of BUCKETS) {
    const s = byBucket.get(b.name)!;
    const found = s.ranks.filter(r => r > 0);
    console.log(
      ` ${b.name.padEnd(18)} ${String(s.n).padStart(3)}  ${pct(s.s1, s.n).padStart(6)}  ${pct(s.s5, s.n).padStart(6)}   ` +
      `${(found.length ? avg(found) : 0).toFixed(2).padStart(8)}   ${avg(s.gr).toFixed(3).padStart(11)}   ${avg(s.tm).toFixed(3).padStart(9)}`);
  }
  const all = [...byBucket.values()];
  const tot = all.reduce((a, s) => a + s.n, 0);
  const totS1 = all.reduce((a, s) => a + s.s1, 0);
  console.log(' ' + '-'.repeat(82));
  console.log(` OVERALL              ${String(tot).padStart(3)}  ${pct(totS1, tot).padStart(6)}`);
  console.log('='.repeat(84));
  console.log('\n Read: if truncation is the mechanism, `gold rerank` collapses past 400 while');
  console.log(' `gold BM25` stays high — the memory is retrievable but not rankable.\n');
  process.exit(0);
}
main().catch(e => { console.error('\nERROR:', e); process.exit(1); });
