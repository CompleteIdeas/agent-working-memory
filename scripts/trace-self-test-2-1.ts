/**
 * Replicates test:self section 2.1 exactly, side-by-side SQLite vs PGlite.
 * Goal: characterize what PGlite is returning for "database query optimization
 * indexes" that causes precision <= 0.5.
 *
 * test 2.1 corpus: 3 distinct topics written in section 2 (DB, React, Git).
 * Earlier sections 1.1-1.4 write ~17 more engrams (decisions, friction
 * repeats). Only ONE engram is "DB-relevant" by the test's filter
 * (tag in [database,sql] OR concept includes 'database'), so the test passes
 * ONLY when the activation either returns 1 result (the DB one) or returns
 * many with the DB one in the majority. Realistically: passes iff top-1
 * is DB AND nothing else clears the abstention floor.
 *
 * Run: npx tsx scripts/trace-self-test-2-1.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { PGliteEngramStore } from '../src/storage/pglite.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { ConnectionEngine } from '../src/engine/connections.js';
import { performWrite } from '../src/core/write-pipeline.js';

const AGENT = 'self21-trace';

// Section 1.1-1.4 writes (paraphrased from runner.ts 56-143 — they shape the
// agent's prior state before section 2 writes hit)
const PRIOR_WRITES = [
  { concept: 'project decision A', content: 'Decided to use TypeScript for the new payments backend rewrite', eventType: 'decision', decisionMade: true, surprise: 0.5, causalDepth: 0.6 },
  { concept: 'project decision B', content: 'Switched from REST to GraphQL for the mobile API after performance tests', eventType: 'decision', decisionMade: true, surprise: 0.5, causalDepth: 0.6 },
  { concept: 'project decision C', content: 'Will deploy via blue-green using AWS CodeDeploy for zero-downtime', eventType: 'decision', decisionMade: true, surprise: 0.5, causalDepth: 0.6 },
  { concept: 'project decision D', content: 'Adopt feature flags via LaunchDarkly for safer rollouts', eventType: 'decision', decisionMade: true, surprise: 0.5, causalDepth: 0.6 },
  { concept: 'project decision E', content: 'Use pgBouncer to manage database connection pooling at scale', eventType: 'decision', decisionMade: true, surprise: 0.5, causalDepth: 0.6 },
  // 5x friction repeats (drops in novelty after first)
  { concept: 'friction 0', content: 'API returned 429 rate limit, retried after backoff in attempt 0', eventType: 'friction', surprise: 0.15, resolutionEffort: 0.25 },
  { concept: 'friction 1', content: 'API returned 429 rate limit, retried after backoff in attempt 1', eventType: 'friction', surprise: 0.15, resolutionEffort: 0.25 },
  { concept: 'friction 2', content: 'API returned 429 rate limit, retried after backoff in attempt 2', eventType: 'friction', surprise: 0.15, resolutionEffort: 0.25 },
  { concept: 'friction 3', content: 'API returned 429 rate limit, retried after backoff in attempt 3', eventType: 'friction', surprise: 0.15, resolutionEffort: 0.25 },
  { concept: 'friction 4', content: 'API returned 429 rate limit, retried after backoff in attempt 4', eventType: 'friction', surprise: 0.15, resolutionEffort: 0.25 },
];

// Section 2 distinct-topic writes
const SECTION_2_WRITES = [
  { concept: 'database optimization', content: 'Use composite indexes on frequently queried column combinations for better database query performance', eventType: 'causal', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.5, tags: ['database', 'sql'] },
  { concept: 'react rendering', content: 'React useMemo and useCallback prevent unnecessary re-renders in component trees', eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.4, tags: ['react', 'frontend'] },
  { concept: 'git branching', content: 'Feature branches should be short-lived to minimize merge conflicts in git workflows', eventType: 'decision', decisionMade: true, surprise: 0.3, causalDepth: 0.4, tags: ['git', 'workflow'] },
];

const QUERY = 'database query optimization indexes';
const isDbRelevant = (e: any) =>
  (e.tags?.some((t: string) => ['database', 'sql'].includes(t))) ||
  (e.concept?.includes('database') ?? false);

async function seedAndQuery(label: string, factory: () => Promise<{ store: any; close: () => Promise<void> | void }>) {
  console.log('\n=========================================================================');
  console.log('Backend: ' + label);
  console.log('=========================================================================');

  const { store, close } = await factory();
  const activation = new ActivationEngine(store);
  const connection = new ConnectionEngine(store, activation);

  // Seed prior writes
  let totalWritten = 0;
  for (const w of [...PRIOR_WRITES, ...SECTION_2_WRITES]) {
    const res = await performWrite(
      { store, connectionEngine: connection },
      {
        agentId: AGENT,
        concept: w.concept,
        content: w.content,
        tags: (w as any).tags,
        eventType: w.eventType as any,
        surprise: (w as any).surprise,
        causalDepth: (w as any).causalDepth,
        resolutionEffort: (w as any).resolutionEffort,
        decisionMade: (w as any).decisionMade,
      },
    );
    if (res.action === 'create') totalWritten++;
  }
  console.log('Seeded ' + totalWritten + ' new engrams (out of ' + (PRIOR_WRITES.length + SECTION_2_WRITES.length) + ' attempts)');

  // Settle async work
  await new Promise(r => setTimeout(r, 1500));

  // Run the query the test runs
  console.log('\nQuery: ' + QUERY);
  const results = await activation.activate({
    agentId: AGENT,
    context: QUERY,
    // No limit — test uses default
  });

  console.log('Returned ' + results.length + ' results, confidence=' + (results[0]?.confidence?.toFixed(3) ?? 'n/a'));
  console.log('\nrank | score   | conf   | stage    | txt    | vec    | rerank | DB? | concept');
  console.log('-----+---------+--------+----------+--------+--------+--------+-----+------------------------');
  let dbCount = 0;
  const top5 = results.slice(0, 5);
  for (let i = 0; i < top5.length; i++) {
    const r = top5[i];
    const ps = r.phaseScores;
    const isDb = isDbRelevant(r.engram);
    if (isDb) dbCount++;
    const stage = r.engram.stage.padEnd(8);
    console.log(
      String(i + 1).padStart(3) + ' | ' +
      r.score.toFixed(3) + '   | ' +
      (r.confidence?.toFixed(2) ?? '----') + '   | ' + stage + ' | ' +
      ps.textMatch.toFixed(2) + '   | ' +
      ps.vectorMatch.toFixed(2) + '   | ' +
      ps.rerankerScore.toFixed(2) + '   | ' +
      (isDb ? ' YES' : ' no ') + ' | ' +
      r.engram.concept.slice(0, 50),
    );
  }

  const precision = top5.length > 0 ? dbCount / Math.min(top5.length, 5) : 0;
  console.log('\nDB-relevant in top-5: ' + dbCount + '/' + top5.length);
  console.log('Precision: ' + precision.toFixed(3) + ' — test passes if > 0.5');
  console.log('Result: ' + (precision > 0.5 ? 'PASS' : 'FAIL'));

  await close();
}

async function main() {
  await seedAndQuery('SQLite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-21-sq-'));
    const store = new EngramStore(join(tmp, 'test.db'));
    return {
      store, close: () => {
        store.close();
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      },
    };
  });

  await seedAndQuery('PGlite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-21-pg-'));
    const store = new PGliteEngramStore(join(tmp, 'pg'));
    await store.ready();
    return {
      store, close: async () => {
        await store.close();
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      },
    };
  });
}

main().catch(err => { console.error(err); process.exit(1); });
