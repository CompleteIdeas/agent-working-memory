/**
 * Phase breakdown that mirrors the 0.7.7+ production path:
 * pool filter applied BEFORE deep scoring + assoc batch.
 *
 * Prior phase-breakdown.ts pre-dated the pool reduction and gave misleading
 * "after-fix" numbers because it still fetched associations for all 10K.
 */
import { EngramStore } from '../src/storage/sqlite.js';
import { embed, cosineSimilarity } from '../src/core/embeddings.js';
import { rerank } from '../src/core/reranker.js';
import { expandQuery } from '../src/core/query-expander.js';
import { baseLevelActivation } from '../src/core/decay.js';

const QUERIES = [
  'USEF results submission Staff Services',
  'Education LMS architecture programs certifications',
  'short query',
  'Stripe webhook handler transfer.paid Connect destination charges',
  'AWM BM25 latency root cause SQLite',
];

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function ms(start: bigint): number { return Number(process.hrtime.bigint() - start) / 1e6; }

async function probe(store: EngramStore, agentId: string, q: string) {
  const phases: Record<string, number> = {};
  const t0 = process.hrtime.bigint();

  // Phase 0: Query expansion (subject to 5s timeout in production)
  const tExp = process.hrtime.bigint();
  let expanded = q;
  try {
    expanded = await Promise.race([
      expandQuery(q),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
  } catch { /* keep original */ }
  phases.expand = ms(tExp);

  // Phase 1: embed
  const tEmb = process.hrtime.bigint();
  const queryEmbedding = await embed(q);
  phases.embed = ms(tEmb);

  // Phase 2: BM25 (TWO calls in production — keyword + expanded)
  const tBm = process.hrtime.bigint();
  const keywordQuery = Array.from(tokenize(q)).join(' ');
  const bm25K = keywordQuery.length > 2 ? store.searchBM25WithRank(agentId, keywordQuery, 30) : [];
  const bm25E = store.searchBM25WithRank(agentId, expanded, 30);
  phases.bm25 = ms(tBm);

  // Build BM25 score map
  const bm25Map = new Map<string, number>();
  for (const r of [...bm25K, ...bm25E]) {
    bm25Map.set(r.engram.id, Math.max(bm25Map.get(r.engram.id) ?? 0, r.bm25Score));
  }

  // Phase 3: SLIM fetch (cached in 0.7.10+)
  const tFetch = process.hrtime.bigint();
  const slimActive = store.getEngramsByAgentSlim(agentId, 'active');
  phases.fetchAll = ms(tFetch);

  // Phase 3a: cosine on slim entries
  const tCos = process.hrtime.bigint();
  const sims = new Map<string, number>();
  for (const e of slimActive) {
    if (e.embedding) sims.set(e.id, cosineSimilarity(queryEmbedding, e.embedding));
  }
  phases.cosine = ms(tCos);

  const simValues = Array.from(sims.values());
  const simMean = simValues.length > 0 ? simValues.reduce((a, b) => a + b, 0) / simValues.length : 0;
  const stdDev = Math.max(simValues.length > 1
    ? Math.sqrt(simValues.reduce((s, x) => s + (x - simMean) ** 2, 0) / simValues.length)
    : 0.15, 0.10);

  // Phase 3a': POOL FILTER on slim entries
  const tFilter = process.hrtime.bigint();
  const queryTokens = tokenize(q);
  const survivorIds = new Set<string>();
  for (const e of slimActive) {
    const bm25 = bm25Map.get(e.id) ?? 0;
    if (bm25 > 0) { survivorIds.add(e.id); continue; }
    const s = sims.get(e.id);
    if (s !== undefined && (s - simMean) / stdDev > 0.5) { survivorIds.add(e.id); continue; }
    const ct = tokenize(e.concept);
    if (ct.size === 0) continue;
    let overlap = 0;
    for (const w of ct) if (queryTokens.has(w)) overlap++;
    if (overlap > 0) survivorIds.add(e.id);
  }
  phases.poolFilter = ms(tFilter);

  // Phase 3a'': hydrate survivors (full Engram rows)
  const tHydrate = process.hrtime.bigint();
  const survivors = store.getEngramsByIds(Array.from(survivorIds));
  phases.hydrate = ms(tHydrate);

  // Phase 3b: aggregate assoc stats on hydrated survivors (0.7.12+)
  const tAssoc = process.hrtime.bigint();
  const assocStats = store.getAssociationStatsForBatch(survivors.map(e => e.id));
  phases.assocBatch = ms(tAssoc);

  // Phase 3c: deep score loop using stats
  const tScore = process.hrtime.bigint();
  for (const e of survivors) {
    const ageDays = (Date.now() - e.createdAt.getTime()) / 86400000;
    const stats = assocStats.get(e.id) ?? { count: 0, sumWeight: 0 };
    const ct = tokenize(e.concept);
    const cct = tokenize(e.content);
    const _j = 0.6 * jaccard(queryTokens, ct) + 0.4 * jaccard(queryTokens, cct);
    const _d = baseLevelActivation(e.accessCount, ageDays);
    const _h = stats.count > 0 ? stats.sumWeight / stats.count : 0;
    void _j; void _d; void _h;
  }
  phases.score = ms(tScore);

  // Phase 7: reranker on top-30
  const top30 = survivors.slice(0, 30);
  const tRr = process.hrtime.bigint();
  try { await rerank(q, top30.map(e => `${e.concept}: ${e.content.slice(0, 200)}`)); } catch { /* ok */ }
  phases.rerank = ms(tRr);

  phases.total = ms(t0);
  phases.candidates = slimActive.length;
  phases.survivors = survivors.length;

  return phases;
}

async function main() {
  const dbPath = process.env.AWM_DB_PATH ?? 'memory.db';
  const agentId = process.env.AWM_AGENT_ID ?? 'work';
  const store = new EngramStore(dbPath);

  await embed('warmup');
  try { await rerank('warmup', ['warmup']); } catch { /* ok */ }
  try { await expandQuery('warmup'); } catch { /* ok */ }

  console.log(`\nProduction phase breakdown — agent=${agentId}\n`);

  for (const q of QUERIES) {
    const cold = await probe(store, agentId, q);
    const warm = await probe(store, agentId, q);

    console.log(`\n=== ${q} ===`);
    console.log(`candidates=${warm.candidates} survivors=${warm.survivors}`);
    console.log(`              cold      warm`);
    for (const k of ['expand', 'embed', 'bm25', 'fetchAll', 'cosine', 'poolFilter', 'hydrate', 'assocBatch', 'score', 'rerank', 'total']) {
      console.log(`  ${k.padEnd(11)} ${(cold as any)[k].toFixed(0).padStart(6)}ms ${(warm as any)[k].toFixed(0).padStart(6)}ms`);
    }
  }

  store.close();
}

main().catch(e => { console.error(e); process.exit(1); });
