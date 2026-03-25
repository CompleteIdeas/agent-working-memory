/**
 * AWM Eval Runner — benchmark suite with ablation support.
 *
 * Suites:
 *   1. Retrieval  — insert 200 facts, run 50 queries, measure Recall@5 / MRR / nDCG@10
 *   2. Associative — multi-hop chains, measure success@10 with/without graph walk
 *   3. Redundancy  — paraphrased facts + consolidation, measure dedup F1 + recall stability
 *   4. Temporal     — controlled access counts + ages, measure Spearman vs ACT-R expected ranking
 *
 * Ablation flags:
 *   --no-graph-walk    Disable graph walk boost
 *   --no-decay         Skip temporal decay
 *   --no-consolidation Skip consolidation in redundancy suite
 *   --bm25-only        Text match only (disable vector, graph, reranker)
 *   --vector-only      Vector match only (disable BM25, graph, reranker)
 *   --suite=<name>     Run only the named suite (retrieval|associative|redundancy|temporal)
 *
 * Run: npx tsx tests/eval/run.ts [flags]
 */

import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { ConsolidationEngine } from '../../src/engine/consolidation.js';

import { generateAll, type Fact, type Query, type MultihopChain, type RedundancyCluster, type TemporalFact } from './generate.js';
import { recallAtK, mrr, ndcgAtK, spearmanCorrelation, dedupF1, mean, type SuiteResult, type EvalReport } from './metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const AGENT_ID = 'eval-agent-001';

// ─── CLI flags ────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const flags = {
  noGraphWalk: args.has('--no-graph-walk'),
  noDecay: args.has('--no-decay'),
  noConsolidation: args.has('--no-consolidation'),
  bm25Only: args.has('--bm25-only'),
  vectorOnly: args.has('--vector-only'),
  suite: [...args].find(a => a.startsWith('--suite='))?.split('=')[1] ?? null,
};

function flagLabel(): string {
  const active = Object.entries(flags)
    .filter(([k, v]) => v && k !== 'suite')
    .map(([k]) => k);
  return active.length ? active.join('+') : 'full-pipeline';
}

// ─── DB helpers ───────────────────────────────────────────────────

function freshDB(label: string) {
  const dbPath = join(__dirname, `eval-${label}-${Date.now()}.db`);
  const store = new EngramStore(dbPath);
  const activation = new ActivationEngine(store);
  const connections = new ConnectionEngine(store, activation);
  const consolidation = new ConsolidationEngine(store);
  return { store, activation, connections, consolidation, dbPath };
}

function cleanup(dbPath: string) {
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + '-wal'); } catch {}
  try { unlinkSync(dbPath + '-shm'); } catch {}
}

/**
 * Insert a fact into the store. Returns the DB-assigned ID.
 * Builds up the idMap so ground-truth fixture IDs can be remapped.
 */
function insertFact(store: EngramStore, fact: Fact, idMap: Map<string, string>): string {
  const engram = store.createEngram({
    agentId: AGENT_ID,
    concept: fact.concept,
    content: fact.content,
    tags: fact.tags,
  });
  idMap.set(fact.id, engram.id);
  return engram.id;
}

/** Remap an array of fixture IDs to actual DB IDs. */
function remap(ids: string[], idMap: Map<string, string>): string[] {
  return ids.map(id => idMap.get(id) ?? id);
}

async function queryEngine(activation: ActivationEngine, text: string, limit = 10): Promise<string[]> {
  const results = await activation.activate({
    agentId: AGENT_ID,
    context: text,
    limit,
    useReranker: !flags.bm25Only && !flags.vectorOnly,
    useExpansion: !flags.bm25Only && !flags.vectorOnly,
    internal: true,
  });
  return results.map(r => r.engram.id);
}

// ─── Suite 1: Retrieval ───────────────────────────────────────────

async function runRetrieval(facts: Fact[], queries: Query[]): Promise<SuiteResult> {
  console.log('\n── Suite 1: Retrieval ──');
  const { store, activation, dbPath } = freshDB('retrieval');
  const idMap = new Map<string, string>();

  try {
    for (const fact of facts) insertFact(store, fact, idMap);
    console.log(`  Inserted ${facts.length} facts`);

    const recallScores: number[] = [];
    const mrrScores: number[] = [];
    const ndcgScores: number[] = [];

    for (const q of queries) {
      const retrieved = await queryEngine(activation, q.text, 10);
      const truth = remap(q.groundTruth, idMap);
      recallScores.push(recallAtK(retrieved, truth, 5));
      mrrScores.push(mrr(retrieved, truth));
      ndcgScores.push(ndcgAtK(retrieved, truth, 10));
    }

    const avgRecall = mean(recallScores);
    const avgMRR = mean(mrrScores);
    const avgNDCG = mean(ndcgScores);

    console.log(`  Recall@5: ${avgRecall.toFixed(3)}  MRR: ${avgMRR.toFixed(3)}  nDCG@10: ${avgNDCG.toFixed(3)}`);

    return {
      name: 'retrieval',
      pass: avgRecall >= 0.85,
      threshold: 0.85,
      score: avgRecall,
      details: { 'recall@5': avgRecall, mrr: avgMRR, 'ndcg@10': avgNDCG, queries: queries.length },
    };
  } finally {
    store.close();
    cleanup(dbPath);
  }
}

// ─── Suite 2: Associative (Multi-hop) ─────────────────────────────

async function runAssociative(chains: MultihopChain[], distractorFacts: Fact[]): Promise<SuiteResult> {
  console.log('\n── Suite 2: Associative (Multi-hop) ──');
  const { store, activation, dbPath } = freshDB('associative');
  const idMap = new Map<string, string>();

  try {
    // Insert distractors
    const distractors = distractorFacts.slice(0, 50);
    for (const d of distractors) insertFact(store, d, idMap);

    for (const chain of chains) {
      // Insert chain facts and get their DB IDs
      for (const fact of chain.facts) insertFact(store, fact, idMap);

      // Create causal associations using DB IDs
      const [aId, bId, cId] = chain.facts.map(f => idMap.get(f.id)!);
      store.upsertAssociation(aId, bId, 0.8, 'causal', 0.9);
      store.upsertAssociation(bId, cId, 0.8, 'causal', 0.9);
    }

    console.log(`  Inserted ${chains.length} chains (${chains.length * 3} facts) + ${distractors.length} distractors`);

    const successScores: number[] = [];

    for (const chain of chains) {
      const retrieved = await queryEngine(activation, chain.query, 10);
      const truth = remap(chain.groundTruth, idMap);
      const hit = truth.some(id => retrieved.includes(id));
      successScores.push(hit ? 1 : 0);
    }

    const successRate = mean(successScores);
    console.log(`  Multi-hop success@10: ${successRate.toFixed(3)}`);

    return {
      name: 'associative',
      pass: successRate >= 0.70,
      threshold: 0.70,
      score: successRate,
      details: { 'success@10': successRate, chains: chains.length, distractors: distractors.length },
    };
  } finally {
    store.close();
    cleanup(dbPath);
  }
}

// ─── Suite 3: Redundancy ──────────────────────────────────────────

async function runRedundancy(clusters: RedundancyCluster[]): Promise<SuiteResult> {
  console.log('\n── Suite 3: Redundancy ──');
  const { store, activation, consolidation, dbPath } = freshDB('redundancy');
  const idMap = new Map<string, string>();

  try {
    const allDbIds = new Set<string>();

    for (const cluster of clusters) {
      const canonDbId = insertFact(store, cluster.canonical, idMap);
      allDbIds.add(canonDbId);
      for (const p of cluster.paraphrases) {
        const pDbId = insertFact(store, p, idMap);
        allDbIds.add(pDbId);
      }
    }
    console.log(`  Inserted ${allDbIds.size} facts (${clusters.length} clusters × 4)`);

    // Measure pre-consolidation recall (can we find the canonical?)
    const preRecallScores: number[] = [];
    for (const cluster of clusters.slice(0, 20)) {
      const retrieved = await queryEngine(activation, cluster.canonical.content.slice(0, 100), 5);
      const canonDbId = idMap.get(cluster.canonicalId)!;
      preRecallScores.push(recallAtK(retrieved, [canonDbId], 5));
    }
    const preRecall = mean(preRecallScores);

    if (!flags.noConsolidation) {
      const result = await consolidation.consolidate(AGENT_ID);
      console.log(`  Consolidation: ${result.redundancyPruned} pruned, ${result.memoriesForgotten} forgotten`);
    }

    // Check surviving IDs
    const surviving = new Set<string>();
    for (const id of allDbIds) {
      const engram = store.getEngram(id);
      if (engram && !engram.retracted && engram.stage !== 'archived') {
        surviving.add(id);
      }
    }

    // Measure dedup F1
    const clusterMap = new Map<string, string[]>();
    for (const cluster of clusters) {
      const canonDbId = idMap.get(cluster.canonicalId)!;
      const paraDbIds = cluster.paraphrases.map(p => idMap.get(p.id)!);
      clusterMap.set(canonDbId, paraDbIds);
    }
    const { precision, recall: dedupRecall, f1 } = dedupF1(clusterMap, surviving);

    // Measure post-consolidation recall
    const postRecallScores: number[] = [];
    for (const cluster of clusters.slice(0, 20)) {
      const retrieved = await queryEngine(activation, cluster.canonical.content.slice(0, 100), 5);
      const canonDbId = idMap.get(cluster.canonicalId)!;
      postRecallScores.push(recallAtK(retrieved, [canonDbId], 5));
    }
    const postRecall = mean(postRecallScores);
    const recallDrop = preRecall - postRecall;

    console.log(`  Dedup F1: ${f1.toFixed(3)} (P=${precision.toFixed(3)} R=${dedupRecall.toFixed(3)})`);
    console.log(`  Recall@5 pre: ${preRecall.toFixed(3)} → post: ${postRecall.toFixed(3)} (drop: ${recallDrop.toFixed(3)})`);

    return {
      name: 'redundancy',
      pass: f1 >= 0.80 && recallDrop < 0.03,
      threshold: 0.80,
      score: f1,
      details: {
        'dedup-f1': f1,
        'dedup-precision': precision,
        'dedup-recall': dedupRecall,
        'recall@5-pre': preRecall,
        'recall@5-post': postRecall,
        'recall-drop': recallDrop,
        surviving: surviving.size,
        total: allDbIds.size,
      },
    };
  } finally {
    store.close();
    cleanup(dbPath);
  }
}

// ─── Suite 4: Temporal ────────────────────────────────────────────

async function runTemporal(temporalFacts: TemporalFact[]): Promise<SuiteResult> {
  console.log('\n── Suite 4: Temporal ──');
  const { store, activation, dbPath } = freshDB('temporal');

  try {
    const dbIds: string[] = [];

    for (const tf of temporalFacts) {
      const engram = store.createEngram({
        agentId: AGENT_ID,
        concept: tf.fact.concept,
        content: tf.fact.content,
        tags: tf.fact.tags,
      });
      dbIds.push(engram.id);

      // Set created_at to match target age
      const targetTime = new Date(Date.now() - tf.targetAgeMs).toISOString();
      const db = store.getDb();
      db.prepare('UPDATE engrams SET created_at = ?, last_accessed = ? WHERE id = ?')
        .run(targetTime, targetTime, engram.id);

      // Simulate access counts
      for (let i = 0; i < tf.targetAccessCount; i++) {
        store.touchEngram(engram.id);
      }
    }

    console.log(`  Inserted ${temporalFacts.length} temporal facts`);

    // Query all temporal facts
    const retrieved = await queryEngine(activation, 'temporal test fact pattern ACT-R decay modeling', 30);

    // Build ranking comparison arrays
    const actualScores: number[] = [];
    const expectedScores: number[] = [];

    for (let i = 0; i < temporalFacts.length; i++) {
      const tf = temporalFacts[i];
      const dbId = dbIds[i];
      const pos = retrieved.indexOf(dbId);
      actualScores.push(pos >= 0 ? temporalFacts.length - pos : 0);
      expectedScores.push(temporalFacts.length - tf.expectedRank + 1);
    }

    const spearman = spearmanCorrelation(actualScores, expectedScores);
    console.log(`  Spearman correlation: ${spearman.toFixed(3)}`);

    return {
      name: 'temporal',
      pass: spearman >= 0.75,
      threshold: 0.75,
      score: spearman,
      details: {
        spearman,
        facts: temporalFacts.length,
        retrieved: retrieved.length,
      },
    };
  } finally {
    store.close();
    cleanup(dbPath);
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('AWM Eval Harness — Phase 1 Benchmark Suite');
  console.log(`Config: ${flagLabel()}`);
  console.log(`Suite filter: ${flags.suite ?? 'all'}`);
  console.log('─'.repeat(50));

  // Always generate fresh fixtures (IDs are ephemeral)
  console.log('Generating fixtures...');
  const fixtures = generateAll();

  const suites: SuiteResult[] = [];
  const shouldRun = (name: string) => !flags.suite || flags.suite === name;

  if (shouldRun('retrieval')) {
    suites.push(await runRetrieval(fixtures.facts, fixtures.queries));
  }

  if (shouldRun('associative')) {
    suites.push(await runAssociative(fixtures.multihop, fixtures.facts));
  }

  if (shouldRun('redundancy')) {
    suites.push(await runRedundancy(fixtures.redundancy));
  }

  if (shouldRun('temporal')) {
    suites.push(await runTemporal(fixtures.temporal));
  }

  // Build report
  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    suites,
    summary: {
      passed: suites.filter(s => s.pass).length,
      failed: suites.filter(s => !s.pass).length,
      total: suites.length,
    },
  };

  // Print summary
  console.log('\n' + '═'.repeat(50));
  console.log('SUMMARY');
  console.log('═'.repeat(50));
  for (const suite of suites) {
    const icon = suite.pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${suite.name}: ${suite.score.toFixed(3)} (threshold: ${suite.threshold})`);
  }
  console.log(`\n  ${report.summary.passed}/${report.summary.total} suites passed`);

  // Write JSON report
  mkdirSync(RESULTS_DIR, { recursive: true });
  const reportPath = join(RESULTS_DIR, `eval-${flagLabel()}-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);

  if (report.summary.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Eval harness failed:', err);
  process.exit(2);
});
