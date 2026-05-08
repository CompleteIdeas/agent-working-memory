/**
 * Recall quality A/B test: compare top-K results between pool-filter ON and OFF.
 *
 * Run twice in separate processes:
 *   AWM_DISABLE_POOL_FILTER=1 npx tsx spike/recall-quality.ts > /tmp/old.json
 *   npx tsx spike/recall-quality.ts > /tmp/new.json
 *   node -e "const o=require('/tmp/old.json'),n=require('/tmp/new.json'); ..."
 *
 * Or just run with AWM_RECALL_QUALITY_BOTH=1 to do A/B in-process (one cold model load).
 */
import { EngramStore } from '../src/storage/sqlite.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { embed } from '../src/core/embeddings.js';
import { rerank } from '../src/core/reranker.js';

const QUERIES = [
  'USEF results submission Staff Services',
  'Education LMS architecture programs certifications',
  'Stripe webhook handler transfer.paid Connect destination charges',
  'sprint current work completed findings pending',
  'AWM BM25 latency root cause SQLite',
  'Freshdesk ticket triage USEA database',
  'horse registration RM transfer record manager',
  'membership renewal magic link auth',
];

async function runMode(label: string, dbPath: string, agentId: string, disableFilter: boolean) {
  process.env.AWM_DISABLE_POOL_FILTER = disableFilter ? '1' : '0';
  const store = new EngramStore(dbPath);
  const engine = new ActivationEngine(store);

  const results: Record<string, { id: string; concept: string; score: number }[]> = {};
  for (const q of QUERIES) {
    const r = await engine.activate({ agentId, context: q, limit: 10 });
    results[q] = r.map(item => ({
      id: item.engram.id,
      concept: item.engram.concept.slice(0, 50),
      score: Math.round(item.score * 1000) / 1000,
    }));
  }
  store.close();
  return { label, results };
}

async function main() {
  const dbPath = process.env.AWM_DB_PATH ?? 'memory.db';
  const agentId = process.env.AWM_AGENT_ID ?? 'work';

  // Warm shared models
  await embed('warmup');
  try { await rerank('warmup', ['warmup']); } catch { /* ok */ }

  const oldRun = await runMode('OFF (pre-fix)', dbPath, agentId, true);
  const newRun = await runMode('ON  (post-fix)', dbPath, agentId, false);

  console.log('\nRecall quality A/B — pool filter\n');
  let totalIntersect5 = 0;
  let totalIntersect10 = 0;
  let totalQueries = 0;
  let topMatch = 0;

  for (const q of QUERIES) {
    const o = oldRun.results[q] ?? [];
    const n = newRun.results[q] ?? [];
    const oIds5 = new Set(o.slice(0, 5).map(r => r.id));
    const nIds5 = new Set(n.slice(0, 5).map(r => r.id));
    const oIds10 = new Set(o.slice(0, 10).map(r => r.id));
    const nIds10 = new Set(n.slice(0, 10).map(r => r.id));
    const inter5 = [...oIds5].filter(id => nIds5.has(id)).length;
    const inter10 = [...oIds10].filter(id => nIds10.has(id)).length;
    const top1Same = o[0]?.id === n[0]?.id;

    console.log(`Q: ${q}`);
    console.log(`  top1 same:      ${top1Same ? '✓' : '✗'}  (old: "${o[0]?.concept ?? '(none)'}" vs new: "${n[0]?.concept ?? '(none)'}")`);
    console.log(`  top-5 overlap:  ${inter5}/5`);
    console.log(`  top-10 overlap: ${inter10}/10`);
    if (inter5 < 5 || inter10 < 8) {
      console.log(`  diff:`);
      console.log(`    old: ${o.slice(0, 5).map(r => r.concept).join(' | ')}`);
      console.log(`    new: ${n.slice(0, 5).map(r => r.concept).join(' | ')}`);
    }
    console.log();

    totalIntersect5 += inter5;
    totalIntersect10 += inter10;
    totalQueries++;
    if (top1Same) topMatch++;
  }

  console.log('=== AGGREGATE ===');
  console.log(`top1 match:        ${topMatch}/${totalQueries}`);
  console.log(`avg top-5 overlap: ${(totalIntersect5 / totalQueries).toFixed(2)}/5`);
  console.log(`avg top-10 overlap:${(totalIntersect10 / totalQueries).toFixed(2)}/10`);
}

main().catch(e => { console.error(e); process.exit(1); });
