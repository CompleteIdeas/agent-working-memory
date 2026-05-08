/**
 * Phase-instrumented recall spike — measures where the 11-23s recall floor goes.
 *
 * Run: npx tsx spike/recall-phases.ts
 *
 * Reuses the production memory.db. Read-only — no writes, no engine state mutation.
 */
import { EngramStore } from '../src/storage/sqlite.js';
import { embed, cosineSimilarity } from '../src/core/embeddings.js';
import { rerank } from '../src/core/reranker.js';

const QUERIES = [
  'USEF results submission Staff Services',
  'Education LMS architecture programs certifications',
  'short query',
  'Stripe webhook handler transfer.paid Connect destination charges',
];

interface PhaseTimes {
  query: string;
  candidates: number;
  embedQuery: number;
  bm25: number;
  fetchAllActive: number;
  cosineAll: number;
  associationsLoop: number;
  rerank: number;
  total: number;
}

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function probe(store: EngramStore, agentId: string, q: string): Promise<PhaseTimes> {
  const t0 = process.hrtime.bigint();

  // Phase 1: embed query
  const tEmb = process.hrtime.bigint();
  const queryEmbedding = await embed(q);
  const embedQuery = ms(tEmb);

  // Phase 2: BM25
  const tBm = process.hrtime.bigint();
  const bm25 = store.searchBM25WithRank(agentId, q, 30);
  const bm25Ms = ms(tBm);

  // Phase 3: fetch all active engrams
  const tFetch = process.hrtime.bigint();
  const allActive = store.getEngramsByAgent(agentId, 'active');
  const fetchAllActive = ms(tFetch);

  // Phase 4: cosine sim across full pool
  const tCos = process.hrtime.bigint();
  const sims = new Map<string, number>();
  for (const eng of allActive) {
    if (eng.embedding) sims.set(eng.id, cosineSimilarity(queryEmbedding, eng.embedding));
  }
  const cosineAll = ms(tCos);

  // Phase 5: association lookup — batch (post-fix) vs N+1 (pre-fix)
  const tAssocBatch = process.hrtime.bigint();
  const assocMap = store.getAssociationsForBatch(allActive.map(e => e.id));
  const associationsLoop = ms(tAssocBatch);

  // Phase 6: reranker on top-30 by cosine
  const top30 = allActive
    .filter(e => sims.has(e.id))
    .sort((a, b) => (sims.get(b.id) ?? 0) - (sims.get(a.id) ?? 0))
    .slice(0, 30);

  const tRr = process.hrtime.bigint();
  try {
    await rerank(q, top30.map(e => `${e.concept}: ${e.content.slice(0, 200)}`));
  } catch (e) {
    // Reranker may not be available — continue
    process.stderr.write(`  (rerank failed: ${(e as Error).message})\n`);
  }
  const rerankMs = ms(tRr);

  const total = ms(t0);

  return {
    query: q,
    candidates: allActive.length,
    embedQuery,
    bm25: bm25Ms,
    fetchAllActive,
    cosineAll,
    associationsLoop,
    rerank: rerankMs,
    total,
  };
}

async function main() {
  const dbPath = process.env.AWM_DB_PATH ?? 'memory.db';
  const agentId = process.env.AWM_AGENT_ID ?? 'work';
  const store = new EngramStore(dbPath);

  process.stderr.write('Warming up embedding + reranker models (first call is slow)...\n');
  await embed('warmup');
  try { await rerank('warmup', ['warmup', 'warmup2']); } catch { /* ok */ }

  console.log(`\nPhase timings (ms) — agent=${agentId}, db=${dbPath}\n`);
  console.log('Q'.padEnd(56), 'cand', 'embed', 'bm25', 'fetch', 'cosin', 'assoc', 'rrank', 'total');
  console.log('-'.repeat(120));

  // Run each query twice — first cold, second warm
  for (const q of QUERIES) {
    const cold = await probe(store, agentId, q);
    const warm = await probe(store, agentId, q);
    const fmt = (t: PhaseTimes, tag: string) =>
      [
        `${tag} ${q.slice(0, 50)}`.padEnd(56),
        String(t.candidates).padStart(4),
        t.embedQuery.toFixed(0).padStart(5),
        t.bm25.toFixed(0).padStart(4),
        t.fetchAllActive.toFixed(0).padStart(5),
        t.cosineAll.toFixed(0).padStart(5),
        t.associationsLoop.toFixed(0).padStart(5),
        t.rerank.toFixed(0).padStart(5),
        t.total.toFixed(0).padStart(5),
      ].join(' ');
    console.log(fmt(cold, '[c]'));
    console.log(fmt(warm, '[w]'));
  }

  store.close();
}

main().catch(e => { console.error(e); process.exit(1); });
