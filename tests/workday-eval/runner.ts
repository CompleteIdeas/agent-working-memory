/**
 * Workday Eval Runner — realistic knowledge recall benchmark.
 *
 * Simulates a coding assistant's workday across 4 distinct projects,
 * then tests whether the right memories surface in realistic scenarios.
 *
 * Run: npx tsx tests/workday-eval/runner.ts [baseUrl]
 *
 * Requires a live AWM server (npx tsx src/index.ts).
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';

// --- Types ---

interface ChallengeResult {
  name: string;
  category: string;
  score: number;     // 0-1
  hit1: boolean;     // top result from expected set?
  precision5: number; // fraction of top-5 from expected session(s)
  detail: string;
}

// --- Helpers (same pattern as self-test/runner.ts) ---

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const TMP_DIR = join(tmpdir(), 'awm-workday-eval');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

let reqCounter = 0;

async function api(method: string, path: string, body?: any): Promise<any> {
  await sleep(30);
  try {
    const url = `${BASE_URL}${path}`;
    let cmd = `curl -sf -X ${method}`;
    if (body) {
      const tmpFile = join(TMP_DIR, `req_${reqCounter++}.json`);
      writeFileSync(tmpFile, JSON.stringify(body));
      cmd += ` -H "Content-Type: application/json" -d @"${tmpFile.replace(/\\/g, '/')}"`;
    }
    cmd += ` "${url}"`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    return JSON.parse(result);
  } catch (err: any) {
    return { error: err.message };
  }
}

// --- Memory Definitions ---

interface MemoryDef {
  concept: string;
  content: string;
  tags: string[];
  eventType: string;
  surprise: number;
  causalDepth: number;
  resolutionEffort: number;
  decisionMade?: boolean;
}

const SESSION_A: MemoryDef[] = [
  { concept: 'express 5 migration breaking changes', content: 'Express 5 removes app.del(), renames app.param() signature, and requires explicit middleware — migrated all route handlers from Express 4 patterns', tags: ['session-a', 'express', 'middleware'], eventType: 'causal', surprise: 0.7, causalDepth: 0.8, resolutionEffort: 0.7 },
  { concept: 'express error handling middleware', content: 'Express 5 async errors auto-propagate to error handler — no need for try/catch wrappers in route handlers, removed 47 redundant catches', tags: ['session-a', 'express', 'middleware'], eventType: 'causal', surprise: 0.8, causalDepth: 0.7, resolutionEffort: 0.6 },
  { concept: 'stripe webhook signature verification', content: 'Stripe webhooks must verify signature using raw body before JSON parsing — added express.raw() middleware on /webhooks/stripe endpoint only', tags: ['session-a', 'stripe', 'payments'], eventType: 'decision', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.8, decisionMade: true },
  { concept: 'stripe checkout session flow', content: 'Stripe Checkout Session creates payment intent server-side, redirects to hosted page, then fires checkout.session.completed webhook — implemented full flow with idempotency keys', tags: ['session-a', 'stripe', 'payments'], eventType: 'causal', surprise: 0.5, causalDepth: 0.8, resolutionEffort: 0.7 },
  { concept: 'express middleware ordering', content: 'CORS middleware must come before routes, body parser before stripe webhook raw handler — order caused 3 hours of debugging', tags: ['session-a', 'express', 'middleware'], eventType: 'friction', surprise: 0.7, causalDepth: 0.6, resolutionEffort: 0.8 },
  { concept: 'stripe subscription lifecycle events', content: 'Handle customer.subscription.updated, invoice.payment_failed, and customer.subscription.deleted webhooks — each updates subscription status in local database', tags: ['session-a', 'stripe', 'payments'], eventType: 'causal', surprise: 0.4, causalDepth: 0.7, resolutionEffort: 0.6 },
  { concept: 'express request validation with zod', content: 'Added Zod schema validation middleware for all API endpoints — returns 400 with structured error messages on validation failure', tags: ['session-a', 'express', 'middleware'], eventType: 'decision', surprise: 0.3, causalDepth: 0.5, resolutionEffort: 0.5, decisionMade: true },
  { concept: 'postgres connection pool for express', content: 'Configured pg pool with min 5, max 20 connections for Express API — pool exhaustion was causing 503 errors under load', tags: ['session-a', 'express', 'postgres', 'database'], eventType: 'friction', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.7 },
  { concept: 'stripe test mode vs live mode keys', content: 'Stripe test mode keys start with sk_test_ and pk_test_, live mode with sk_live_ and pk_live_ — environment variable naming convention decided: STRIPE_SECRET_KEY regardless of mode', tags: ['session-a', 'stripe', 'payments'], eventType: 'decision', surprise: 0.2, causalDepth: 0.3, resolutionEffort: 0.3, decisionMade: true },
  { concept: 'express rate limiting configuration', content: 'Applied express-rate-limit with 100 req/15min per IP on auth endpoints, 1000 req/15min on API endpoints — separate limiters per route group', tags: ['session-a', 'express', 'middleware'], eventType: 'decision', surprise: 0.3, causalDepth: 0.4, resolutionEffort: 0.4, decisionMade: true },
  { concept: 'stripe payment intent error codes', content: 'Stripe card_declined has sub-codes: insufficient_funds, lost_card, stolen_card — map each to user-friendly messages in the checkout error handler', tags: ['session-a', 'stripe', 'payments'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5, resolutionEffort: 0.5 },
  { concept: 'express 5 router changes', content: 'Express 5 router no longer supports string patterns for path matching — migrated regex routes to use path-to-regexp explicitly', tags: ['session-a', 'express', 'middleware'], eventType: 'causal', surprise: 0.6, causalDepth: 0.5, resolutionEffort: 0.6 },
];

const SESSION_B: MemoryDef[] = [
  { concept: 'react memo prevents unnecessary rerenders', content: 'Wrapped 12 list item components in React.memo — reduced render count from 847 to 52 per data update, measured with React DevTools profiler', tags: ['session-b', 'react', 'performance', 'rendering'], eventType: 'causal', surprise: 0.7, causalDepth: 0.8, resolutionEffort: 0.7 },
  { concept: 'react useMemo for expensive calculations', content: 'Dashboard summary calculations were running on every render — useMemo with dependency array cut render time from 180ms to 12ms', tags: ['session-b', 'react', 'performance', 'rendering'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.6 },
  { concept: 'webpack bundle size analysis', content: 'Used webpack-bundle-analyzer to find lodash importing full library — switched to lodash-es with tree shaking, bundle dropped from 2.1MB to 890KB', tags: ['session-b', 'bundle', 'performance'], eventType: 'causal', surprise: 0.8, causalDepth: 0.7, resolutionEffort: 0.8 },
  { concept: 'react virtualization for large lists', content: 'Dashboard table with 10,000 rows caused scroll jank — implemented react-window with 50px row height, now renders only visible 20 rows', tags: ['session-b', 'react', 'performance', 'rendering'], eventType: 'decision', surprise: 0.5, causalDepth: 0.7, resolutionEffort: 0.7, decisionMade: true },
  { concept: 'code splitting with react lazy', content: 'Split dashboard into 4 lazy-loaded route chunks — initial load dropped from 3.2s to 1.1s on 3G throttled connection', tags: ['session-b', 'react', 'bundle', 'performance'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.6, decisionMade: true },
  { concept: 'react context causes full tree rerender', content: 'Theme context at root level was causing every component to rerender on theme toggle — split into ThemeContext and ThemeDispatchContext', tags: ['session-b', 'react', 'performance', 'rendering'], eventType: 'friction', surprise: 0.7, causalDepth: 0.8, resolutionEffort: 0.7 },
  { concept: 'image optimization lazy loading', content: 'Dashboard product images were loading all 200+ images eagerly — added loading=lazy and srcSet for responsive sizes, LCP improved by 40%', tags: ['session-b', 'performance', 'bundle'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5, resolutionEffort: 0.5 },
  { concept: 'react useCallback for stable references', content: 'Event handlers in parent were creating new references each render — useCallback prevented child components from re-rendering via referential equality checks', tags: ['session-b', 'react', 'performance', 'rendering'], eventType: 'causal', surprise: 0.4, causalDepth: 0.6, resolutionEffort: 0.4 },
  { concept: 'css containment for paint isolation', content: 'Added CSS contain: layout paint to dashboard widget cards — browser can now skip repainting non-visible widgets during scroll', tags: ['session-b', 'performance', 'rendering'], eventType: 'causal', surprise: 0.5, causalDepth: 0.5, resolutionEffort: 0.4 },
  { concept: 'service worker caching strategy', content: 'Implemented stale-while-revalidate caching for API responses and cache-first for static assets — offline dashboard loads in under 500ms', tags: ['session-b', 'performance', 'bundle'], eventType: 'decision', surprise: 0.4, causalDepth: 0.6, resolutionEffort: 0.6, decisionMade: true },
  { concept: 'react profiler api usage', content: 'Used React Profiler API onRender callback to log render durations to analytics — identified 3 components with consistent 50ms+ render times', tags: ['session-b', 'react', 'performance'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4, resolutionEffort: 0.3 },
];

const SESSION_C: MemoryDef[] = [
  { concept: 'github actions monorepo workflow', content: 'Set up path-based triggers in GitHub Actions — changes to packages/api/** only trigger API tests, packages/web/** triggers web tests, reduces CI time by 60%', tags: ['session-c', 'cicd', 'github-actions', 'turborepo'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.7 },
  { concept: 'turborepo remote caching setup', content: 'Enabled Turborepo remote caching with Vercel — subsequent CI builds skip unchanged packages, average build time dropped from 12min to 3min', tags: ['session-c', 'cicd', 'turborepo'], eventType: 'causal', surprise: 0.7, causalDepth: 0.6, resolutionEffort: 0.7 },
  { concept: 'docker layer caching in ci', content: 'Configured Docker BuildKit with GitHub Actions cache backend — reuses npm install layer when package-lock unchanged, saves 4 minutes per build', tags: ['session-c', 'cicd', 'docker', 'github-actions'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.6, decisionMade: true },
  { concept: 'github actions matrix strategy', content: 'Matrix strategy runs tests across Node 18/20/22 and Ubuntu/Windows in parallel — catches platform-specific bugs before merge', tags: ['session-c', 'cicd', 'github-actions'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5, resolutionEffort: 0.5, decisionMade: true },
  { concept: 'monorepo dependency graph ordering', content: 'Turborepo topological sort ensures shared-utils builds before api and web packages that depend on it — eliminated race condition in parallel builds', tags: ['session-c', 'turborepo', 'cicd'], eventType: 'friction', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.6 },
  { concept: 'docker multi-stage production build', content: 'Multi-stage Dockerfile: build stage with dev deps, production stage copies only dist and node_modules — final image 180MB vs 1.2GB', tags: ['session-c', 'docker', 'cicd'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.5 },
  { concept: 'github actions secrets management', content: 'Stored all API keys in GitHub Actions secrets, not .env files — environment-specific secrets loaded per deployment target (staging vs production)', tags: ['session-c', 'cicd', 'github-actions'], eventType: 'decision', surprise: 0.3, causalDepth: 0.4, resolutionEffort: 0.4, decisionMade: true },
  { concept: 'ci pipeline artifact caching', content: 'Cache node_modules and .turbo directories between CI runs using actions/cache@v4 — hash on package-lock.json for cache key invalidation', tags: ['session-c', 'cicd', 'github-actions', 'turborepo'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5, resolutionEffort: 0.5 },
  { concept: 'docker compose for local development', content: 'Docker Compose defines postgres, redis, api, web services — developers run docker compose up to get full environment with hot reloading', tags: ['session-c', 'docker'], eventType: 'decision', surprise: 0.3, causalDepth: 0.4, resolutionEffort: 0.5, decisionMade: true },
  { concept: 'github actions reusable workflow', content: 'Extracted common CI steps into reusable workflow in .github/workflows/shared-ci.yml — all 3 package workflows call it, reducing YAML duplication', tags: ['session-c', 'cicd', 'github-actions'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5, resolutionEffort: 0.5 },
];

const SESSION_D: MemoryDef[] = [
  { concept: 'postgres partial index optimization', content: 'Created partial index on orders WHERE status=pending — query planner now uses index scan for the 5% pending orders instead of sequential scan on full 2M row table', tags: ['session-d', 'postgres', 'indexing', 'database'], eventType: 'causal', surprise: 0.8, causalDepth: 0.8, resolutionEffort: 0.8 },
  { concept: 'postgres explain analyze usage', content: 'EXPLAIN ANALYZE revealed nested loop join on unindexed foreign key — adding index on orders.customer_id dropped query from 2.3s to 8ms', tags: ['session-d', 'postgres', 'indexing', 'queries'], eventType: 'causal', surprise: 0.7, causalDepth: 0.8, resolutionEffort: 0.7 },
  { concept: 'postgres connection pooling with pgbouncer', content: 'PgBouncer in transaction mode pools 200 app connections through 20 postgres connections — solved max_connections limit without increasing server resources', tags: ['session-d', 'postgres', 'database'], eventType: 'decision', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.7, decisionMade: true },
  { concept: 'postgres materialized view for reports', content: 'Created materialized view for monthly sales report aggregation — refreshed every 15 minutes via pg_cron, dashboard query went from 12s to 50ms', tags: ['session-d', 'postgres', 'queries', 'database'], eventType: 'decision', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.6, decisionMade: true },
  { concept: 'postgres vacuum analyze maintenance', content: 'Autovacuum settings were too conservative — dead tuples causing table bloat and slow scans, tuned autovacuum_vacuum_scale_factor to 0.05', tags: ['session-d', 'postgres', 'database'], eventType: 'friction', surprise: 0.7, causalDepth: 0.7, resolutionEffort: 0.7 },
  { concept: 'postgres composite index column order', content: 'Composite index on (tenant_id, created_at) serves both equality on tenant_id and range scan on created_at — reversed order would not support the range efficiently', tags: ['session-d', 'postgres', 'indexing', 'queries'], eventType: 'causal', surprise: 0.6, causalDepth: 0.8, resolutionEffort: 0.6 },
  { concept: 'postgres jsonb query optimization', content: 'GIN index on metadata jsonb column enables fast containment queries @> — but jsonb_path_query requires separate index strategy', tags: ['session-d', 'postgres', 'indexing', 'queries'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.5 },
  { concept: 'postgres row level security setup', content: 'Enabled RLS with tenant_id policy — every query automatically filtered to current tenant, eliminated accidental cross-tenant data leaks', tags: ['session-d', 'postgres', 'database'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.7, decisionMade: true },
  { concept: 'postgres query plan caching', content: 'Prepared statements with generic plans skip planning phase — but parameterized queries with skewed data distribution benefit from custom plans', tags: ['session-d', 'postgres', 'queries'], eventType: 'causal', surprise: 0.5, causalDepth: 0.7, resolutionEffort: 0.5 },
  { concept: 'postgres table partitioning by date', content: 'Partitioned events table by month using declarative partitioning — queries scanning last 30 days now touch only 1-2 partitions instead of full 50M row table', tags: ['session-d', 'postgres', 'database', 'queries'], eventType: 'causal', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.7 },
];

// --- Challenge Definitions ---

interface Challenge {
  name: string;
  category: 'knowledge-transfer' | 'context-switch' | 'cross-cutting' | 'noise-filter';
  query: string;
  expectedSessions: string[];  // e.g. ['session-a'] — empty for noise
  minScore?: number;
}

const CHALLENGES: Challenge[] = [
  // Knowledge Transfer (4)
  { name: 'KT1', category: 'knowledge-transfer', query: 'Setting up Express 5 with Stripe webhook signature verification and payment flow', expectedSessions: ['session-a'] },
  { name: 'KT2', category: 'knowledge-transfer', query: 'React component re-rendering performance issues useMemo useCallback optimization', expectedSessions: ['session-b'] },
  { name: 'KT3', category: 'knowledge-transfer', query: 'Adding database indexes for slow PostgreSQL queries explain analyze', expectedSessions: ['session-d'] },
  { name: 'KT4', category: 'knowledge-transfer', query: 'CI/CD pipeline for a new monorepo with GitHub Actions and remote caching', expectedSessions: ['session-c'] },

  // Context Switching (3)
  { name: 'CS1', category: 'context-switch', query: 'Back to Express error handling migration removing try catch wrappers async routes', expectedSessions: ['session-a'] },
  { name: 'CS2', category: 'context-switch', query: 'Continuing dashboard bundle optimization code splitting lazy loading webpack', expectedSessions: ['session-b'] },
  { name: 'CS3', category: 'context-switch', query: 'Resuming CI caching strategy turborepo remote cache GitHub Actions artifacts', expectedSessions: ['session-c'] },

  // Cross-Cutting (4)
  { name: 'CC1', category: 'cross-cutting', query: 'PostgreSQL connection pooling configuration for backend API application', expectedSessions: ['session-a', 'session-d'] },
  { name: 'CC2', category: 'cross-cutting', query: 'Caching strategies across projects service worker docker layer turbo cache', expectedSessions: ['session-b', 'session-c'] },
  { name: 'CC3', category: 'cross-cutting', query: 'Performance improvements with specific latency and size reduction numbers', expectedSessions: ['session-a', 'session-b', 'session-c', 'session-d'] },
  { name: 'CC4', category: 'cross-cutting', query: 'Configuration decisions for environment variables secrets and deployment settings', expectedSessions: ['session-a', 'session-c', 'session-d'] },

  // Noise Filtering (3)
  { name: 'NF1', category: 'noise-filter', query: 'PyTorch machine learning model training gradient descent backpropagation', expectedSessions: [], minScore: 0.3 },
  { name: 'NF2', category: 'noise-filter', query: 'Kubernetes pod scheduling autoscaling horizontal vertical cluster management', expectedSessions: [], minScore: 0.3 },
  { name: 'NF3', category: 'noise-filter', query: 'Swift UIKit mobile app development storyboard interface builder constraints', expectedSessions: [], minScore: 0.3 },
];

// --- Scoring ---

function scoreChallenge(
  challenge: Challenge,
  results: any[],
): ChallengeResult {
  const top5 = (results ?? []).slice(0, 5);
  const top1 = top5[0];

  if (challenge.category === 'noise-filter') {
    // For noise: results should have been queried with minScore 0.3
    const count = (results ?? []).length;
    const rejection = count === 0 ? 1.0 : Math.max(0, 1 - count * 0.25);
    return {
      name: challenge.name,
      category: challenge.category,
      score: rejection,
      hit1: count === 0,
      precision5: rejection,
      detail: `${count} results above threshold (want 0)`,
    };
  }

  // Check how many top-5 results come from expected sessions
  const matchingInTop5 = top5.filter((r: any) =>
    r.engram?.tags?.some((t: string) => challenge.expectedSessions.includes(t))
  ).length;

  const precision5 = top5.length > 0 ? matchingInTop5 / Math.min(top5.length, 5) : 0;

  const hit1 = top1?.engram?.tags?.some((t: string) =>
    challenge.expectedSessions.includes(t)
  ) ?? false;

  // Composite: 60% precision@5 + 40% hit@1
  const score = precision5 * 0.6 + (hit1 ? 1 : 0) * 0.4;

  const topConcepts = top5.slice(0, 3).map((r: any) =>
    `${r.engram?.concept} [${r.score?.toFixed(2)}]`
  ).join(', ');

  return {
    name: challenge.name,
    category: challenge.category,
    score,
    hit1,
    precision5,
    detail: `P@5=${precision5.toFixed(2)} Hit@1=${hit1 ? 'Y' : 'N'} | Top: ${topConcepts || 'none'}`,
  };
}

// --- Main ---

async function main() {
  console.log('AgentWorkingMemory Workday Eval');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('');

  // Health check
  const health = await api('GET', '/health');
  if (health.status !== 'ok') {
    console.error(`FATAL: Cannot reach server at ${BASE_URL}`);
    process.exit(1);
  }
  console.log(`Server: OK (${health.version})`);

  // Fresh agent for isolation
  const agent = await api('POST', '/agent/register', { name: 'workday-eval-agent' });
  const agentId = agent.id;
  console.log(`Agent: ${agentId}`);

  // =========================================================
  // PHASE 1: Seed memories across 4 sessions
  // =========================================================
  console.log('\n=== PHASE 1: SEEDING MEMORIES ===');

  const sessions: [string, MemoryDef[]][] = [
    ['Session A (Express + Stripe)', SESSION_A],
    ['Session B (React Performance)', SESSION_B],
    ['Session C (CI/CD Monorepo)', SESSION_C],
    ['Session D (PostgreSQL)', SESSION_D],
  ];

  let totalSeeded = 0;
  let activeCount = 0;
  let stagingCount = 0;
  let discardCount = 0;

  for (const [label, memories] of sessions) {
    let sessionActive = 0, sessionStaging = 0, sessionDiscard = 0;

    for (const mem of memories) {
      const res = await api('POST', '/memory/write', {
        agentId,
        concept: mem.concept,
        content: mem.content,
        tags: mem.tags,
        eventType: mem.eventType,
        surprise: mem.surprise,
        causalDepth: mem.causalDepth,
        resolutionEffort: mem.resolutionEffort,
        decisionMade: mem.decisionMade,
      });

      if (res.disposition === 'active') { sessionActive++; activeCount++; }
      else if (res.disposition === 'staging') { sessionStaging++; stagingCount++; }
      else { sessionDiscard++; discardCount++; }
      totalSeeded++;
    }

    console.log(`  ${label}: ${memories.length} written (${sessionActive} active, ${sessionStaging} staging, ${sessionDiscard} discard)`);
  }

  console.log(`  Total: ${totalSeeded} seeded (${activeCount} active, ${stagingCount} staging, ${discardCount} discard)`);

  // =========================================================
  // PHASE 2: Build Hebbian associations via co-activation
  // =========================================================
  console.log('\n=== PHASE 2: BUILDING ASSOCIATIONS ===');

  const associationQueries = [
    // Session A internal associations
    'Express 5 migration middleware Stripe webhook payment handling',
    'Express error handling async routes middleware ordering',
    'Stripe checkout session payment intent webhook signature verification',
    // Session B internal associations
    'React performance useMemo useCallback memo re-rendering optimization',
    'Dashboard bundle size webpack code splitting lazy loading',
    'React virtualization profiler rendering performance',
    // Session C internal associations
    'GitHub Actions monorepo CI pipeline turborepo remote caching',
    'Docker layer caching multi-stage build CI optimization',
    // Session D internal associations
    'PostgreSQL index optimization explain analyze query performance',
    'Postgres connection pooling partitioning materialized views',
    'Database composite index partial index GIN jsonb optimization',
  ];

  for (const ctx of associationQueries) {
    // Each query runs 3 times to build Hebbian strength
    for (let i = 0; i < 3; i++) {
      await api('POST', '/memory/activate', { agentId, context: ctx });
    }
  }
  console.log(`  Ran ${associationQueries.length} association-building queries (3x each)`);

  // =========================================================
  // PHASE 3: Run recall challenges
  // =========================================================
  console.log('\n=== PHASE 3: RECALL CHALLENGES ===');

  const challengeResults: ChallengeResult[] = [];

  for (const challenge of CHALLENGES) {
    const activateParams: any = { agentId, context: challenge.query };
    if (challenge.minScore !== undefined) {
      activateParams.minScore = challenge.minScore;
    }

    const res = await api('POST', '/memory/activate', activateParams);
    const result = scoreChallenge(challenge, res.results ?? []);
    challengeResults.push(result);

    const icon = result.score >= 0.6 ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${result.name} (${result.score.toFixed(2)}) — ${result.detail}`);
  }

  // =========================================================
  // PHASE 4: Report
  // =========================================================
  console.log('\n' + '='.repeat(65));
  console.log('WORKDAY EVAL REPORT');
  console.log('='.repeat(65));

  const categoryWeights: Record<string, number> = {
    'knowledge-transfer': 0.30,
    'context-switch': 0.25,
    'cross-cutting': 0.25,
    'noise-filter': 0.20,
  };

  const categoryLabels: Record<string, string> = {
    'knowledge-transfer': 'KNOWLEDGE TRANSFER',
    'context-switch': 'CONTEXT SWITCHING',
    'cross-cutting': 'CROSS-CUTTING',
    'noise-filter': 'NOISE FILTERING',
  };

  const categoryScores: Record<string, number> = {};

  for (const [cat, weight] of Object.entries(categoryWeights)) {
    const catResults = challengeResults.filter(r => r.category === cat);
    const avgScore = catResults.reduce((s, r) => s + r.score, 0) / catResults.length;
    categoryScores[cat] = avgScore;

    const passed = catResults.filter(r => r.score >= 0.6).length;
    console.log(`\n${categoryLabels[cat]} (weight ${weight * 100}%)`);
    console.log(`  Score: ${(avgScore * 100).toFixed(1)}% | Passed: ${passed}/${catResults.length}`);

    for (const r of catResults) {
      const icon = r.score >= 0.6 ? 'PASS' : 'FAIL';
      console.log(`    [${icon}] ${r.name}: P@5=${r.precision5.toFixed(2)} Hit@1=${r.hit1 ? 'Y' : 'N'} (${(r.score * 100).toFixed(0)}%)`);
    }
  }

  // Overall weighted score
  let overall = 0;
  for (const [cat, score] of Object.entries(categoryScores)) {
    overall += score * (categoryWeights[cat] ?? 0);
  }

  console.log('\n' + '-'.repeat(65));
  console.log(`OVERALL SCORE: ${(overall * 100).toFixed(1)}%`);

  if (overall >= 0.9) console.log('GRADE: EXCELLENT');
  else if (overall >= 0.75) console.log('GRADE: GOOD');
  else if (overall >= 0.6) console.log('GRADE: FAIR');
  else console.log('GRADE: NEEDS WORK');

  // Identify weakest category
  const weakest = Object.entries(categoryScores).sort((a, b) => a[1] - b[1])[0];
  if (weakest && weakest[1] < 0.9) {
    console.log(`\nWEAKEST: ${categoryLabels[weakest[0]]} (${(weakest[1] * 100).toFixed(1)}%)`);
    const failures = challengeResults.filter(r => r.category === weakest[0] && r.score < 0.6);
    if (failures.length > 0) {
      console.log('Failing challenges:');
      for (const f of failures) {
        console.log(`  - ${f.name}: ${f.detail}`);
      }
    }
  }

  // Memory stats
  const stats = await api('GET', `/agent/${agentId}/stats`);
  console.log(`\nMEMORY STATS: ${stats.engrams?.active ?? '?'} active, ${stats.engrams?.staging ?? '?'} staging, ${stats.associations ?? '?'} associations`);

  console.log('\n' + '='.repeat(65));

  process.exit(overall >= 0.6 ? 0 : 1);
}

main().catch(err => {
  console.error('Workday eval failed:', err);
  process.exit(1);
});
