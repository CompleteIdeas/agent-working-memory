/**
 * End-to-end activate() timing — uses the actual ActivationEngine,
 * not a hand-rolled phase replay. Tests whether the BM25 fix +
 * batch assoc fix actually deliver in the real recall path.
 */
import { EngramStore } from '../src/storage/sqlite.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { embed } from '../src/core/embeddings.js';
import { rerank } from '../src/core/reranker.js';

const QUERIES = [
  'USEF results submission Staff Services',
  'Education LMS architecture programs certifications',
  'short query',
  'Stripe webhook handler transfer.paid Connect destination charges',
  'sprint current work completed findings pending',
];

async function main() {
  const dbPath = process.env.AWM_DB_PATH ?? 'memory.db';
  const agentId = process.env.AWM_AGENT_ID ?? 'work';
  const store = new EngramStore(dbPath);
  const engine = new ActivationEngine(store);

  // Warm
  await embed('warmup');
  try { await rerank('warmup', ['warmup', 'warmup2']); } catch { /* ok */ }
  await engine.activate({ agentId, context: 'warmup', limit: 5 });

  console.log(`\nactivate() end-to-end timings (ms) — agent=${agentId}, db=${dbPath}\n`);
  console.log('Q'.padEnd(70), 'cold', 'warm', 'top1');
  console.log('-'.repeat(110));

  for (const q of QUERIES) {
    const t1 = process.hrtime.bigint();
    const r1 = await engine.activate({ agentId, context: q, limit: 5 });
    const cold = Number(process.hrtime.bigint() - t1) / 1e6;

    const t2 = process.hrtime.bigint();
    const r2 = await engine.activate({ agentId, context: q, limit: 5 });
    const warm = Number(process.hrtime.bigint() - t2) / 1e6;

    const top = r2[0]?.engram.concept.slice(0, 35) ?? '(none)';
    console.log(
      q.slice(0, 68).padEnd(70),
      cold.toFixed(0).padStart(5),
      warm.toFixed(0).padStart(5),
      top,
    );
  }

  store.close();
}

main().catch(e => { console.error(e); process.exit(1); });
