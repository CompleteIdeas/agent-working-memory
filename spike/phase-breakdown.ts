/**
 * Activate() phase breakdown — fine-grained timing of each pipeline phase.
 * Used to decide whether candidate pool reduction is worth pursuing.
 *
 * Measures the SAME activation pipeline as production by patching in timer
 * checkpoints and reading the resulting log.
 */
import { EngramStore } from '../src/storage/sqlite.js';
import { embed, cosineSimilarity } from '../src/core/embeddings.js';
import { rerank } from '../src/core/reranker.js';
import { baseLevelActivation } from '../src/core/decay.js';

// Mirror of the private helpers in activation.ts
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

const QUERIES = [
  'USEF results submission Staff Services',
  'Education LMS architecture programs certifications',
  'Stripe webhook handler transfer.paid Connect destination charges',
];

function ms(start: bigint): number { return Number(process.hrtime.bigint() - start) / 1e6; }

async function probe(store: EngramStore, agentId: string, q: string) {
  const phases: Record<string, number> = {};

  const t0 = process.hrtime.bigint();

  // Phase 1: embed query
  const tEmb = process.hrtime.bigint();
  const queryEmbedding = await embed(q);
  phases.embed = ms(tEmb);

  // Phase 2: BM25 (the production code does TWO calls — keyword + expanded)
  const tBm = process.hrtime.bigint();
  const keywordQuery = Array.from(tokenize(q)).join(' ');
  const bm25Keyword = keywordQuery.length > 2 ? store.searchBM25WithRank(agentId, keywordQuery, 30) : [];
  const bm25Expanded = store.searchBM25WithRank(agentId, q, 30);
  phases.bm25 = ms(tBm);

  // Phase 3: fetch all active
  const tFetch = process.hrtime.bigint();
  const allActive = store.getEngramsByAgent(agentId, 'active');
  phases.fetchAll = ms(tFetch);

  // Phase 3a: cosine for all
  const tCos = process.hrtime.bigint();
  const sims = new Map<string, number>();
  for (const e of allActive) {
    if (e.embedding) sims.set(e.id, cosineSimilarity(queryEmbedding, e.embedding));
  }
  phases.cosine = ms(tCos);

  // Phase 3b-prep: batch associations
  const tAssoc = process.hrtime.bigint();
  const assocMap = store.getAssociationsForBatch(allActive.map(e => e.id));
  phases.assocBatch = ms(tAssoc);

  // Phase 3b: per-candidate scoring (the suspected next bottleneck)
  const tScore = process.hrtime.bigint();
  const queryTokens = tokenize(q);
  let totalContentChars = 0;
  for (const engram of allActive) {
    const ageDays = (Date.now() - engram.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const associations = assocMap.get(engram.id) ?? [];
    const conceptTokens = tokenize(engram.concept);
    const contentTokens = tokenize(engram.content);
    totalContentChars += engram.content.length;
    const cj = jaccard(queryTokens, conceptTokens);
    const ctj = jaccard(queryTokens, contentTokens);
    const _jaccardScore = 0.6 * cj + 0.4 * ctj;
    const _decayScore = baseLevelActivation(engram.accessCount, ageDays);
    const _hebbian = associations.length > 0
      ? associations.reduce((s, a) => s + a.weight, 0) / associations.length
      : 0;
    const _weightedDeg = associations.reduce((s, a) => s + a.weight, 0);
    const _centrality = associations.length > 0 ? Math.min(0.1, 0.03 * Math.log1p(_weightedDeg)) : 0;
    void _jaccardScore; void _decayScore; void _hebbian; void _centrality;
  }
  phases.score = ms(tScore);

  // Phase 7: reranker on top-30 (representative of production)
  const top30 = allActive
    .filter(e => sims.has(e.id))
    .sort((a, b) => (sims.get(b.id) ?? 0) - (sims.get(a.id) ?? 0))
    .slice(0, 30);
  const tRr = process.hrtime.bigint();
  try {
    await rerank(q, top30.map(e => `${e.concept}: ${e.content.slice(0, 200)}`));
  } catch { /* ok */ }
  phases.rerank = ms(tRr);

  phases.total = ms(t0);
  phases.candidates = allActive.length;
  phases.contentChars = totalContentChars;
  phases.bm25Hits = new Set([...bm25Keyword, ...bm25Expanded].map(r => r.engram.id)).size;

  return phases;
}

async function main() {
  const dbPath = process.env.AWM_DB_PATH ?? 'memory.db';
  const agentId = process.env.AWM_AGENT_ID ?? 'work';
  const store = new EngramStore(dbPath);

  // Warm
  await embed('warmup');
  try { await rerank('warmup', ['warmup']); } catch { /* ok */ }

  console.log(`\nActivate() phase breakdown — agent=${agentId}, db=${dbPath}\n`);

  for (const q of QUERIES) {
    const p = await probe(store, agentId, q); // cold
    const p2 = await probe(store, agentId, q); // warm

    console.log(`\n=== ${q} ===`);
    console.log(`candidates=${p2.candidates}, bm25-hits=${p2.bm25Hits}, content chars in scoring loop=${p2.contentChars.toLocaleString()}`);
    console.log(`              cold      warm`);
    for (const k of ['embed', 'bm25', 'fetchAll', 'cosine', 'assocBatch', 'score', 'rerank', 'total']) {
      console.log(`  ${k.padEnd(10)} ${(p as any)[k].toFixed(0).padStart(6)}ms ${(p2 as any)[k].toFixed(0).padStart(6)}ms`);
    }
  }

  store.close();
}

main().catch(e => { console.error(e); process.exit(1); });
