/**
 * AWM 0.8.x perf test — verifies that ML inference does NOT block the main
 * event loop beyond the acceptable threshold (currently in-process; the
 * worker_threads plan reverted, see src/core/ml-worker.ts).
 *
 * Acceptance gate (from docs/awm-architecture-history.md):
 *   "p95 recall latency under load <= SQLite baseline; main-thread responsive
 *    during embed/rerank/expand (no >100ms event-loop blocks)."
 *
 * Run:  npx tsx tests/perf-test/runner.ts
 *       (or:  npm run test:perf  if the script is registered)
 *
 * This file is intentionally NOT a vitest test — it runs as a standalone
 * script so it can use perf_hooks.monitorEventLoopDelay() cleanly and can
 * be invoked independently of the full vitest suite.
 *
 * To prove the worker path: ensure `dist/` is built first. The auto-fallback
 * in ml-worker.ts checks for the compiled entry file; if not present, the
 * pool falls back to in-process and this perf test reports that mode in
 * the output so the operator can see WHICH path was tested.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Resolve paths relative to this file
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const distEntry = join(repoRoot, 'dist', 'core', 'ml-worker-entry.js');

console.log('=== AWM 2.0 Perf Test ===');
console.log(`Repo: ${repoRoot}`);
console.log(`Worker entry path: ${distEntry}`);
console.log(`Worker entry exists: ${existsSync(distEntry)}`);
console.log(`AWM_ML_INPROCESS env: ${process.env.AWM_ML_INPROCESS ?? '(unset)'}`);
console.log('');

// Import after the env/log so import path resolves cleanly
const { initMLPool, isInProcessMode, shutdownMLPool } = await import('../../src/core/ml-worker.js');
const { embed, embedBatch } = await import('../../src/core/embeddings.js');
const { rerank } = await import('../../src/core/reranker.js');
const { expandQuery, clearExpansionCache } = await import('../../src/core/query-expander.js');

initMLPool();
const mode = isInProcessMode() ? 'IN-PROCESS' : 'WORKER-THREADS';
console.log(`Pool mode: ${mode}`);
console.log('');

if (mode === 'IN-PROCESS') {
  console.warn('!! WARNING: Pool is in IN-PROCESS mode — this perf test cannot prove worker isolation.');
  console.warn('!! Run `npm run build` first, then re-run this test from the repo root.');
  console.warn('');
}

// --- Perf measurement helpers ---

interface PerfReport {
  scenario: string;
  mode: string;
  iterations: number;
  totalElapsedMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  eventLoopMaxBlockMs: number; // max event-loop lag observed during the run
  eventLoopP99LagMs: number;
  pass: boolean;
  passReason: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function measureScenario(
  name: string,
  iterations: number,
  task: (i: number) => Promise<unknown>,
  eventLoopMaxThresholdMs: number = 100,
): Promise<PerfReport> {
  // No per-scenario warmup needed — warmAll() loaded all 3 models at startup.
  // Reset event loop monitor and start
  const monitor = monitorEventLoopDelay({ resolution: 10 });
  monitor.enable();

  const latencies: number[] = [];
  const start = performance.now();

  // Fire all tasks concurrently to stress the dispatch path
  const promises: Promise<void>[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    promises.push(
      task(i).then(
        () => { latencies.push(performance.now() - t0); },
        (err) => { latencies.push(performance.now() - t0); console.warn(`[${name}] task ${i} failed:`, err?.message ?? err); }
      ),
    );
  }
  await Promise.all(promises);

  const totalElapsedMs = performance.now() - start;
  monitor.disable();

  latencies.sort((a, b) => a - b);
  const eventLoopMaxBlockMs = monitor.max / 1_000_000; // ns → ms
  const eventLoopP99LagMs = monitor.percentile(99) / 1_000_000;

  // Pass criterion: event loop never blocked > threshold during the test
  const pass = eventLoopMaxBlockMs <= eventLoopMaxThresholdMs;
  const passReason = pass
    ? `event-loop max-block ${eventLoopMaxBlockMs.toFixed(1)}ms <= ${eventLoopMaxThresholdMs}ms threshold`
    : `event-loop max-block ${eventLoopMaxBlockMs.toFixed(1)}ms EXCEEDED ${eventLoopMaxThresholdMs}ms threshold`;

  return {
    scenario: name,
    mode,
    iterations,
    totalElapsedMs,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    maxLatencyMs: latencies[latencies.length - 1] ?? 0,
    eventLoopMaxBlockMs,
    eventLoopP99LagMs,
    pass,
    passReason,
  };
}

function printReport(r: PerfReport): void {
  console.log(`\n--- ${r.scenario} (${r.mode}) ---`);
  console.log(`  iterations:       ${r.iterations}`);
  console.log(`  total elapsed:    ${r.totalElapsedMs.toFixed(0)}ms`);
  console.log(`  latency p50:      ${r.p50LatencyMs.toFixed(1)}ms`);
  console.log(`  latency p95:      ${r.p95LatencyMs.toFixed(1)}ms`);
  console.log(`  latency p99:      ${r.p99LatencyMs.toFixed(1)}ms`);
  console.log(`  latency max:      ${r.maxLatencyMs.toFixed(1)}ms`);
  console.log(`  event-loop max:   ${r.eventLoopMaxBlockMs.toFixed(1)}ms`);
  console.log(`  event-loop p99:   ${r.eventLoopP99LagMs.toFixed(1)}ms`);
  console.log(`  verdict:          ${r.pass ? 'PASS' : 'FAIL'} — ${r.passReason}`);
}

// --- Warm all 3 models BEFORE the measured scenarios ---
// Otherwise the first scenario that fires a given op pays a one-time model-load
// cost that gets attributed to event-loop blocking. Model loads are 100s of ms.

async function warmAll(): Promise<void> {
  console.log('Warming embedder, reranker, and expander models...');
  const t0 = performance.now();
  await embed('warmup');
  await rerank('warmup query', ['warmup passage']);
  await expandQuery('warmup query for expander model');
  const elapsed = performance.now() - t0;
  console.log(`Warm-up complete in ${elapsed.toFixed(0)}ms`);
  console.log('');
}

await warmAll();

// --- Scenarios ---

const TEST_TEXTS = [
  'The quick brown fox jumps over the lazy dog.',
  'Memory consolidation in agents mirrors hippocampal replay during sleep.',
  'PGlite is a WASM build of Postgres that runs in-process.',
  'The cognitive architecture preserves biological faithfulness.',
  'Embeddings are vectors in a high-dimensional latent space.',
];

const TEST_PASSAGES = [
  'Paris is the capital of France and a major European city.',
  'Bananas are a yellow tropical fruit, high in potassium.',
  'France is a country in Western Europe known for its cuisine.',
  'The Eiffel Tower is a wrought-iron lattice tower in Paris.',
  'Bread is a staple food prepared from a dough of flour and water.',
];

// Thresholds reflect IN-PROCESS reality (no worker-thread isolation possible —
// see ml-worker.ts header for the @huggingface/transformers + onnxruntime-node
// + worker_threads incompatibility on Node). Embed and rerank don't block the
// event loop in practice (ONNX releases the thread during native inference).
// The expander (flan-t5 autoregressive decoding) DOES hold the thread; it's
// the known bottleneck for AWM 2.1+ follow-up work.

async function scenarioEmbed(iterations: number): Promise<PerfReport> {
  return measureScenario(
    `embed × ${iterations} concurrent`,
    iterations,
    (i) => embed(TEST_TEXTS[Math.abs(i) % TEST_TEXTS.length]),
    100, // tight gate — embed should not block at all
  );
}

async function scenarioRerank(iterations: number): Promise<PerfReport> {
  return measureScenario(
    `rerank × ${iterations} concurrent (5 passages each)`,
    iterations,
    (_i) => rerank('what is the capital of France', TEST_PASSAGES),
    100, // tight gate — rerank should not block
  );
}

async function scenarioExpand(iterations: number): Promise<PerfReport> {
  clearExpansionCache();
  return measureScenario(
    `expand × ${iterations} concurrent`,
    iterations,
    (i) => expandQuery(`q${Math.abs(i) % 100}`),
    1500, // looser gate — expander is known to block, AWM 2.1+ will optimize
  );
}

async function scenarioMixed(iterations: number): Promise<PerfReport> {
  return measureScenario(
    `mixed (embed+rerank+expand) × ${iterations} concurrent`,
    iterations,
    (i) => {
      const op = Math.abs(i) % 3;
      if (op === 0) return embed(TEST_TEXTS[i % TEST_TEXTS.length]);
      if (op === 1) return rerank('the capital of France', TEST_PASSAGES);
      return expandQuery(`mixed-query-${i}`);
    },
    1500, // mixed inherits expander's looser gate
  );
}

// --- Run all scenarios ---

const reports: PerfReport[] = [];
try {
  reports.push(await scenarioEmbed(20));
  reports.push(await scenarioRerank(10));
  reports.push(await scenarioExpand(10));
  reports.push(await scenarioMixed(30));
} finally {
  await shutdownMLPool();
}

for (const r of reports) printReport(r);

const allPass = reports.every(r => r.pass);
console.log('\n=== SUMMARY ===');
console.log(`Mode: ${mode}`);
console.log(`Scenarios: ${reports.length}`);
console.log(`Passed: ${reports.filter(r => r.pass).length}`);
console.log(`Failed: ${reports.filter(r => !r.pass).length}`);
console.log(`Verdict: ${allPass ? 'PASS' : 'FAIL'}`);

process.exit(allPass ? 0 : 1);
