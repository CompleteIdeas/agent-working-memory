/**
 * Empirical BM25 score distribution — SQLite vs PGlite.
 *
 * Seeds identical corpora into both backends, runs identical queries,
 * collects the raw bm25Score arrays so we can pick a calibration that
 * makes PGlite's ts_rank_cd output cover the same band as SQLite's
 * |rank|/(1+|rank|) normalization.
 *
 * Run: npx tsx scripts/measure-bm25.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { PGliteEngramStore } from '../src/storage/pglite.js';

const AGENT = 'measure';

const FACTS: Array<{ concept: string; content: string }> = [
  { concept: 'auth jwt',           content: 'JWT access tokens are signed with HS256, valid for 15 minutes' },
  { concept: 'auth rbac',          content: 'Role-based access control: admin, editor, viewer roles via Auth.js middleware' },
  { concept: 'db indexes',         content: 'PostgreSQL composite indexes on the slow query path improve latency 10x' },
  { concept: 'db pool',            content: 'PgBouncer transaction pooling at 6432, pool_size 25' },
  { concept: 'react bundle',       content: 'React production bundle split with Vite manual chunks, lazy load routes' },
  { concept: 'react virtual',      content: 'React virtual scrolling via react-window for the 10000-row table' },
  { concept: 'ci speed',           content: 'CI pipeline parallelized with GitHub Actions matrix, build time 8 minutes' },
  { concept: 'ci docker',          content: 'Docker layer caching with buildx, base image alpine 3.20' },
  { concept: 'logging trace',      content: 'Structured logging with pino, correlation IDs across services' },
  { concept: 'cross perf',         content: 'Performance profiling: useMemo for expensive selectors, virtualization for lists' },
  { concept: 'auth session',       content: 'Sessions stored in Redis with 7-day TTL, sliding expiration' },
  { concept: 'db migration',       content: 'Database migrations via Prisma, rollback strategy via backup snapshots' },
  { concept: 'react state',        content: 'State management with Zustand, persisted to localStorage' },
  { concept: 'react routing',      content: 'React Router v6 with code splitting per route' },
  { concept: 'ci tests',           content: 'CI runs jest unit tests in parallel + playwright e2e on push' },
];

const QUERIES = [
  'JWT token expiration policy',
  'database connection pooling',
  'React bundle optimization techniques',
  'CI Docker layer caching',
  'session storage strategy',
  'PostgreSQL index strategy for slow queries',
  'role-based access control roles',
  'state management persistence',
  'logging with correlation IDs',
  'performance profiling React',
];

async function measureSqlite() {
  const tmp = mkdtempSync(join(tmpdir(), 'awm-bm25-sq-'));
  const store = new EngramStore(join(tmp, 'test.db'));
  for (const f of FACTS) {
    store.createEngram({ agentId: AGENT, concept: f.concept, content: f.content });
  }
  const scores: number[] = [];
  for (const q of QUERIES) {
    const hits = store.searchBM25WithRank(AGENT, q, 5);
    for (const h of hits) scores.push(h.bm25Score);
  }
  store.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  return scores;
}

async function measurePglite() {
  const tmp = mkdtempSync(join(tmpdir(), 'awm-bm25-pg-'));
  const store = new PGliteEngramStore(join(tmp, 'pg'));
  await store.ready();
  for (const f of FACTS) {
    await store.createEngram({ agentId: AGENT, concept: f.concept, content: f.content });
  }
  const scores: number[] = [];
  for (const q of QUERIES) {
    const hits = await store.searchBM25WithRank(AGENT, q, 5);
    for (const h of hits) scores.push(h.bm25Score);
  }
  await store.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  return scores;
}

function stats(label: string, xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) { console.log(`${label}: empty`); return; }
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const p50 = sorted[Math.floor(n * 0.5)];
  const p25 = sorted[Math.floor(n * 0.25)];
  const p75 = sorted[Math.floor(n * 0.75)];
  const p95 = sorted[Math.floor(n * 0.95)];
  console.log(`${label.padEnd(10)} n=${n} min=${sorted[0].toFixed(4)} p25=${p25.toFixed(4)} p50=${p50.toFixed(4)} mean=${mean.toFixed(4)} p75=${p75.toFixed(4)} p95=${p95.toFixed(4)} max=${sorted[n-1].toFixed(4)}`);
}

async function main() {
  console.log('Measuring BM25 score distributions on identical corpus + queries...\n');
  const sq = await measureSqlite();
  stats('SQLite', sq);
  const pg = await measurePglite();
  stats('PGlite', pg);

  // Suggested calibration: multiplier that maps PGlite p50 to SQLite p50
  if (pg.length > 0 && sq.length > 0) {
    const sqMean = sq.reduce((a, b) => a + b, 0) / sq.length;
    const pgMean = pg.reduce((a, b) => a + b, 0) / pg.length;
    console.log();
    console.log('Calibration analysis:');
    console.log(`  SQLite mean (target): ${sqMean.toFixed(4)}`);
    console.log(`  PGlite raw mean:      ${pgMean.toFixed(4)}`);
    console.log(`  Raw ratio (SQ/PG):    ${(sqMean / pgMean).toFixed(2)}x`);

    // Test a few calibrations with x/(1+x) normalization
    console.log('\n  PGlite-normalized samples (raw*M / (1 + raw*M)):');
    for (const M of [1, 5, 10, 20, 50]) {
      const normed = pg.map(x => (x * M) / (1 + x * M));
      const nmean = normed.reduce((a, b) => a + b, 0) / normed.length;
      const nmin = Math.min(...normed);
      const nmax = Math.max(...normed);
      console.log(`    M=${M.toString().padStart(2)}: mean=${nmean.toFixed(4)} [${nmin.toFixed(4)}, ${nmax.toFixed(4)}]  (target mean ~${sqMean.toFixed(2)})`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
