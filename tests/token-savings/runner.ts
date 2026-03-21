/**
 * Token Savings Benchmark — measures context window reduction from AWM memory recall.
 *
 * Simulates a coding assistant that accumulates conversation history across tasks.
 * Compares:
 *   Baseline: stuff all prior conversation into context (N tokens)
 *   AWM:      retrieve only relevant memories from AWM (M tokens)
 *
 * Measures:
 *   - Token savings = (N - M) / N
 *   - Recall accuracy (do retrieved memories contain the needed information?)
 *   - Quality-per-token = accuracy / tokens_used
 *
 * Run: npx tsx tests/token-savings/runner.ts [baseUrl]
 * Requires a live AWM server (npx tsx src/index.ts).
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';

// --- Helpers ---

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const TMP_DIR = join(tmpdir(), 'awm-token-savings');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

let reqCounter = 0;

async function api(method: string, path: string, body?: any): Promise<any> {
  await sleep(20);
  try {
    const url = `${BASE_URL}${path}`;
    let cmd = `curl -sf -X ${method}`;
    if (body) {
      const tmpFile = join(TMP_DIR, `req_${reqCounter++}.json`);
      writeFileSync(tmpFile, JSON.stringify(body));
      cmd += ` -H "Content-Type: application/json" -d @"${tmpFile.replace(/\\/g, '/')}"`;
    }
    cmd += ` "${url}"`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(result);
  } catch (err: any) {
    return { error: err.message };
  }
}

/**
 * Rough token count (GPT-style: ~4 chars per token).
 * Good enough for relative comparisons.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Simulated Conversation History ---

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  task: string; // which task this turn belongs to
}

interface RecallChallenge {
  name: string;
  query: string;
  expectedTask: string; // which task's info should be recalled
  expectedKeywords: string[]; // keywords that should appear in recalled memories
}

// Simulate 5 development tasks with realistic conversation lengths
const CONVERSATION_HISTORY: ConversationTurn[] = [
  // Task 1: Setting up authentication (12 turns)
  { role: 'user', content: 'I need to add JWT authentication to our Express API. We\'re using Express 4 with TypeScript.', task: 'auth' },
  { role: 'assistant', content: 'I\'ll set up JWT auth with jsonwebtoken and express-jwt middleware. First, let\'s install the dependencies: npm install jsonwebtoken express-jwt bcryptjs. We\'ll need a secret key stored in .env.', task: 'auth' },
  { role: 'user', content: 'Should we use RS256 or HS256 for the JWT algorithm?', task: 'auth' },
  { role: 'assistant', content: 'For a single-service API, HS256 is simpler and faster. RS256 is better for microservices where multiple services need to verify tokens without sharing secrets. Since we\'re a monolith, HS256 with a strong 256-bit secret is the right choice. Store it as JWT_SECRET in .env, minimum 32 characters.', task: 'auth' },
  { role: 'user', content: 'What about refresh tokens?', task: 'auth' },
  { role: 'assistant', content: 'We\'ll implement a dual-token strategy: access tokens (15 min TTL) and refresh tokens (7 day TTL). Refresh tokens are stored in the database with a token family for rotation detection. If a refresh token is reused, we invalidate the entire family (prevents token theft). The refresh token endpoint is POST /auth/refresh.', task: 'auth' },
  { role: 'user', content: 'How do we handle token revocation for logout?', task: 'auth' },
  { role: 'assistant', content: 'We\'ll add a token blacklist table in PostgreSQL with the jti (JWT ID) claim. On logout, add the access token\'s jti to the blacklist with its expiry time. Middleware checks the blacklist on each request. We run a cleanup job hourly to remove expired entries. The blacklist table: id, jti, expires_at, created_at.', task: 'auth' },
  { role: 'user', content: 'Should we add rate limiting to the auth endpoints?', task: 'auth' },
  { role: 'assistant', content: 'Yes, critical for auth endpoints. Use express-rate-limit with these limits: /auth/login: 5 attempts per 15 minutes per IP, /auth/refresh: 10 per minute, /auth/register: 3 per hour. Store rate limit data in Redis for distributed deployments, or in-memory for single instance.', task: 'auth' },
  { role: 'user', content: 'One more thing — we need role-based access control.', task: 'auth' },
  { role: 'assistant', content: 'I\'ll implement RBAC with three roles: admin, editor, viewer. Roles are stored in the users table. We create an authorize() middleware factory that takes allowed roles: authorize([\'admin\', \'editor\']). It checks the JWT payload\'s role claim after authentication. Admin can manage users, editor can CRUD content, viewer is read-only.', task: 'auth' },

  // Task 2: Database optimization (10 turns)
  { role: 'user', content: 'Our PostgreSQL queries are getting slow. The main table has 2 million rows and searches take 3-5 seconds.', task: 'db-opt' },
  { role: 'assistant', content: 'Let\'s start by analyzing the slow queries. Run EXPLAIN ANALYZE on the problematic queries. Common issues: missing indexes on WHERE clause columns, sequential scans on large tables, N+1 queries from the ORM. What\'s the table schema and the slow query?', task: 'db-opt' },
  { role: 'user', content: 'The main query joins users, orders, and order_items. It filters by date range and user status.', task: 'db-opt' },
  { role: 'assistant', content: 'Create a composite index: CREATE INDEX idx_orders_user_date ON orders(user_id, created_at DESC). Also add a partial index for active users: CREATE INDEX idx_users_active ON users(id) WHERE status = \'active\'. For the join, make sure order_items has an index on order_id. After adding indexes, run ANALYZE to update statistics.', task: 'db-opt' },
  { role: 'user', content: 'The EXPLAIN output shows a hash join taking 2 seconds.', task: 'db-opt' },
  { role: 'assistant', content: 'The hash join is expensive because it\'s building a hash table for the entire orders table. Increase work_mem to 256MB for this session: SET work_mem = \'256MB\'. Also consider using a materialized view for the report query that gets refreshed hourly. Query went from 3.5s to 180ms after adding the composite index and increasing work_mem.', task: 'db-opt' },
  { role: 'user', content: 'We also have a full-text search that\'s slow.', task: 'db-opt' },
  { role: 'assistant', content: 'Switch from LIKE \'%term%\' to PostgreSQL tsvector/tsquery. Create a GIN index: CREATE INDEX idx_products_search ON products USING GIN(to_tsvector(\'english\', name || \' \' || description)). Query with: WHERE to_tsvector(\'english\', name || \' \' || description) @@ plainto_tsquery(\'english\', $1). This gives 50-100x speedup.', task: 'db-opt' },
  { role: 'user', content: 'Should we add connection pooling?', task: 'db-opt' },
  { role: 'assistant', content: 'Yes, use PgBouncer in transaction mode. Set pool_size = 20, max_client_conn = 100. Our app currently opens a new connection per request which is wasteful. With PgBouncer, connections are reused. Set the app\'s connection string to point to PgBouncer (port 6432) instead of Postgres directly. This reduced our connection overhead from 50ms to 2ms.', task: 'db-opt' },

  // Task 3: React performance optimization (8 turns)
  { role: 'user', content: 'Our React dashboard is rendering slowly. The main table component with 500 rows takes 2 seconds to render.', task: 'react-perf' },
  { role: 'assistant', content: 'Several approaches: 1) Virtualize the table with react-window or @tanstack/virtual — only renders visible rows. 2) Memoize row components with React.memo. 3) Use useMemo for sorted/filtered data. 4) Check for unnecessary re-renders with React DevTools Profiler. The biggest win is usually virtualization.', task: 'react-perf' },
  { role: 'user', content: 'We implemented react-window. Load time dropped to 200ms but scrolling is still janky.', task: 'react-perf' },
  { role: 'assistant', content: 'Janky scrolling usually means row rendering is expensive. Profile each row: are there complex calculations, heavy formatting, or many child components? Use React.memo on RowComponent with a custom areEqual that compares only the data props. Also check if you\'re creating new objects/functions on each render (inline handlers, computed styles).', task: 'react-perf' },
  { role: 'user', content: 'The bundle size is also 2.5MB. How do we reduce it?', task: 'react-perf' },
  { role: 'assistant', content: 'Run npx webpack-bundle-analyzer to identify the biggest chunks. Common culprits: moment.js (replace with dayjs), lodash (use lodash-es with tree-shaking), large icon libraries (import individual icons). Enable code splitting with React.lazy and dynamic imports for routes. Target: main bundle under 250KB, lazy-load everything else.', task: 'react-perf' },
  { role: 'user', content: 'We found that chart.js is 500KB in the bundle.', task: 'react-perf' },
  { role: 'assistant', content: 'Replace chart.js with a lighter alternative: recharts (180KB) or visx (tree-shakeable). If you must keep chart.js, dynamically import it: const Chart = lazy(() => import(\'./ChartComponent\')). Also register only the chart types you use instead of importing the full library. Our bundle dropped from 2.5MB to 800KB after these changes.', task: 'react-perf' },

  // Task 4: CI/CD pipeline setup (8 turns)
  { role: 'user', content: 'We need to set up CI/CD with GitHub Actions for our Node.js monorepo using Turborepo.', task: 'cicd' },
  { role: 'assistant', content: 'Create .github/workflows/ci.yml with matrix strategy for Node 18 and 20. Use turbo prune to only build affected packages. Cache turbo artifacts with actions/cache using hash of turbo.json + lockfile. Run lint, type-check, and test in parallel using turbo run lint test typecheck --parallel.', task: 'cicd' },
  { role: 'user', content: 'How should we handle deployment to staging vs production?', task: 'cicd' },
  { role: 'assistant', content: 'Use environment-based workflows: push to main triggers staging deploy, creating a release tag triggers production. Use GitHub Environments with required reviewers for production. Store secrets per environment: STAGING_DB_URL, PROD_DB_URL. The deploy job uses a reusable workflow that takes the environment name as input.', task: 'cicd' },
  { role: 'user', content: 'Our tests take 15 minutes. Can we speed them up?', task: 'cicd' },
  { role: 'assistant', content: 'Three strategies: 1) Use turbo\'s remote cache with Vercel — cache test results across CI runs. 2) Split tests into shards with --shard flag: jobs: test: strategy: matrix: shard: [1/4, 2/4, 3/4, 4/4]. 3) Only run tests for affected packages: turbo run test --filter=...[HEAD~1]. This brought our CI from 15 min to 3.5 min.', task: 'cicd' },
  { role: 'user', content: 'We also need Docker builds for the API service.', task: 'cicd' },
  { role: 'assistant', content: 'Multi-stage Dockerfile: Stage 1 (builder): FROM node:20-alpine, COPY, npm ci, turbo prune api --docker, npm run build. Stage 2 (runner): FROM node:20-alpine, copy only built artifacts and node_modules. Use BuildKit with --mount=type=cache for npm cache. Image size went from 1.2GB to 180MB. Add to CI as a separate job after tests pass.', task: 'cicd' },

  // Task 5: Error handling and logging (6 turns)
  { role: 'user', content: 'We need better error handling and structured logging across the API.', task: 'logging' },
  { role: 'assistant', content: 'Use pino for structured JSON logging (it\'s Fastify-compatible and much faster than winston). Create a centralized error handler middleware that catches all errors, logs them with context (requestId, userId, path), and returns appropriate HTTP responses. Use custom error classes: AppError extends Error with statusCode and isOperational flag.', task: 'logging' },
  { role: 'user', content: 'How do we add request tracing?', task: 'logging' },
  { role: 'assistant', content: 'Generate a unique requestId per request using crypto.randomUUID(). Add it to the pino logger child context: req.log = logger.child({ requestId }). Pass it through all service calls. Return it in the X-Request-Id response header so clients can reference it in bug reports. This makes debugging production issues trivial — grep logs by requestId.', task: 'logging' },
  { role: 'user', content: 'What about monitoring and alerting?', task: 'logging' },
  { role: 'assistant', content: 'Ship pino logs to Datadog or Grafana Loki via pino-transport. Set up alerts for: error rate > 1% (5 min window), p99 latency > 2s, memory usage > 80%. Add health check endpoint that returns { status, uptime, memory, connections }. Use prom-client for Prometheus metrics: request_duration_histogram, error_count_total, active_connections_gauge.', task: 'logging' },
];

const RECALL_CHALLENGES: RecallChallenge[] = [
  {
    name: 'Auth-JWT',
    query: 'What JWT algorithm and token strategy did we decide on for authentication?',
    expectedTask: 'auth',
    expectedKeywords: ['HS256', 'refresh', 'access', '15 min', '7 day'],
  },
  {
    name: 'Auth-RBAC',
    query: 'How does our role-based access control work?',
    expectedTask: 'auth',
    expectedKeywords: ['admin', 'editor', 'viewer', 'authorize'],
  },
  {
    name: 'DB-Index',
    query: 'What database indexes did we add for the slow query?',
    expectedTask: 'db-opt',
    expectedKeywords: ['composite', 'idx_orders', 'partial', 'GIN'],
  },
  {
    name: 'DB-Pool',
    query: 'How is our database connection pooling configured?',
    expectedTask: 'db-opt',
    expectedKeywords: ['PgBouncer', 'transaction', 'pool_size', '6432'],
  },
  {
    name: 'React-Bundle',
    query: 'How did we reduce the React bundle size?',
    expectedTask: 'react-perf',
    expectedKeywords: ['chart.js', 'lazy', 'code splitting', '800KB'],
  },
  {
    name: 'React-Virtual',
    query: 'What virtualization approach did we use for the table?',
    expectedTask: 'react-perf',
    expectedKeywords: ['react-window', 'visible rows', 'React.memo'],
  },
  {
    name: 'CI-Speed',
    query: 'How did we speed up the CI pipeline from 15 minutes?',
    expectedTask: 'cicd',
    expectedKeywords: ['shard', 'turbo', 'cache', '3.5 min'],
  },
  {
    name: 'CI-Docker',
    query: 'What does our Docker build look like for the API?',
    expectedTask: 'cicd',
    expectedKeywords: ['multi-stage', 'alpine', 'prune', '180MB'],
  },
  {
    name: 'Log-Trace',
    query: 'How do we trace requests across the API?',
    expectedTask: 'logging',
    expectedKeywords: ['requestId', 'pino', 'X-Request-Id', 'child'],
  },
  {
    name: 'Cross-Perf',
    query: 'What performance optimizations have we made across the project?',
    expectedTask: 'all',
    expectedKeywords: ['index', 'virtual', 'cache', 'pool'],
  },
];

// --- Main ---

async function main() {
  console.log('AgentWorkingMemory Token Savings Benchmark');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // Check server
  const health = await api('GET', '/health');
  if (health.error) {
    console.error('Server not running. Start with: npx tsx src/index.ts');
    process.exit(1);
  }
  console.log(`Server: OK (${health.version})`);

  const agentId = crypto.randomUUID();
  console.log(`Agent: ${agentId}`);

  // Calculate baseline token count (full conversation history)
  const fullHistory = CONVERSATION_HISTORY.map(t => `${t.role}: ${t.content}`).join('\n');
  const baselineTokens = estimateTokens(fullHistory);
  console.log(`\nConversation: ${CONVERSATION_HISTORY.length} turns across 5 tasks`);
  console.log(`Baseline tokens (full history): ${baselineTokens.toLocaleString()}`);

  // =========================================================
  // PHASE 1: Seed all conversation turns as memories
  // =========================================================
  console.log('\n=== PHASE 1: SEEDING CONVERSATION HISTORY ===');

  let activeCount = 0;
  let stagingCount = 0;

  for (const turn of CONVERSATION_HISTORY) {
    const hasFact = turn.content.length > 80;
    const hasDecision = /decided|chose|use|implement|create|add|set up|switch|replace/i.test(turn.content);
    const hasNumber = /\d+/.test(turn.content);

    const res = await api('POST', '/memory/write', {
      agentId,
      concept: `${turn.task} ${turn.role} conversation`,
      content: turn.content,
      tags: [turn.task, turn.role],
      eventType: hasDecision ? 'decision' : hasFact ? 'causal' : 'observation',
      surprise: hasDecision ? 0.6 : hasNumber ? 0.5 : 0.3,
      causalDepth: hasDecision ? 0.7 : hasFact ? 0.6 : 0.3,
      resolutionEffort: hasFact ? 0.5 : 0.3,
      decisionMade: hasDecision,
    });

    if (res.disposition === 'active') activeCount++;
    else stagingCount++;
  }

  console.log(`  Seeded: ${CONVERSATION_HISTORY.length} turns (${activeCount} active, ${stagingCount} staging)`);

  // Wait for embeddings
  console.log('  Waiting for embeddings...');
  await sleep(5000);

  // Build associations
  console.log('  Building associations...');
  const topics = ['authentication JWT tokens', 'database optimization PostgreSQL', 'React performance bundle', 'CI/CD GitHub Actions Docker', 'logging monitoring errors'];
  for (const topic of topics) {
    for (let i = 0; i < 2; i++) {
      await api('POST', '/memory/activate', { agentId, context: topic });
    }
  }

  // =========================================================
  // PHASE 2: Recall challenges — measure token savings
  // =========================================================
  console.log('\n=== PHASE 2: RECALL CHALLENGES ===\n');

  let totalBaselineTokens = 0;
  let totalAWMTokens = 0;
  let totalHits = 0;
  let totalKeywordsExpected = 0;
  let totalKeywordsFound = 0;

  const results: { name: string; baselineTokens: number; awmTokens: number; savings: number; accuracy: number; qualityPerToken: number }[] = [];

  for (const challenge of RECALL_CHALLENGES) {
    // Baseline: all conversation turns for the expected task (or all for cross-cutting)
    const relevantTurns = challenge.expectedTask === 'all'
      ? CONVERSATION_HISTORY
      : CONVERSATION_HISTORY.filter(t => t.task === challenge.expectedTask);
    const baselineContext = relevantTurns.map(t => `${t.role}: ${t.content}`).join('\n');
    const challengeBaselineTokens = estimateTokens(baselineContext);

    // AWM: retrieve top 5 memories
    const res = await api('POST', '/memory/activate', {
      agentId,
      context: challenge.query,
      limit: 5,
      includeStaging: true,
    });

    const memories = res.results ?? [];
    const awmContext = memories.map((r: any) => r.engram?.content ?? '').join('\n');
    const awmTokens = estimateTokens(awmContext) + estimateTokens(challenge.query);

    // Check accuracy: how many expected keywords appear in retrieved memories?
    const allRetrievedText = awmContext.toLowerCase();
    let keywordsFound = 0;
    for (const kw of challenge.expectedKeywords) {
      if (allRetrievedText.includes(kw.toLowerCase())) keywordsFound++;
    }
    const accuracy = challenge.expectedKeywords.length > 0
      ? keywordsFound / challenge.expectedKeywords.length : 0;

    const savings = 1 - awmTokens / challengeBaselineTokens;
    const qualityPerToken = accuracy / (awmTokens / 1000); // accuracy per 1K tokens

    results.push({
      name: challenge.name,
      baselineTokens: challengeBaselineTokens,
      awmTokens,
      savings,
      accuracy,
      qualityPerToken,
    });

    totalBaselineTokens += challengeBaselineTokens;
    totalAWMTokens += awmTokens;
    totalKeywordsExpected += challenge.expectedKeywords.length;
    totalKeywordsFound += keywordsFound;
    if (accuracy >= 0.5) totalHits++;

    const status = accuracy >= 0.5 ? 'PASS' : 'FAIL';
    const savingsPct = (savings * 100).toFixed(0);
    const accPct = (accuracy * 100).toFixed(0);
    console.log(`  [${status}] ${challenge.name}: savings=${savingsPct}% accuracy=${accPct}% (${keywordsFound}/${challenge.expectedKeywords.length} keywords) baseline=${challengeBaselineTokens} awm=${awmTokens}`);
  }

  // =========================================================
  // REPORT
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('TOKEN SAVINGS REPORT');
  console.log('='.repeat(70));

  const overallSavings = 1 - totalAWMTokens / totalBaselineTokens;
  const overallAccuracy = totalKeywordsExpected > 0 ? totalKeywordsFound / totalKeywordsExpected : 0;

  console.log(`\nFull conversation history: ${baselineTokens.toLocaleString()} tokens`);
  console.log(`Turns: ${CONVERSATION_HISTORY.length} across 5 tasks`);
  console.log(`Challenges: ${RECALL_CHALLENGES.length}`);

  console.log(`\nPer-challenge averages:`);
  console.log(`  Baseline context: ${Math.round(totalBaselineTokens / results.length).toLocaleString()} tokens`);
  console.log(`  AWM context:      ${Math.round(totalAWMTokens / results.length).toLocaleString()} tokens`);
  console.log(`  Token savings:    ${(overallSavings * 100).toFixed(1)}%`);

  console.log(`\nRecall quality:`);
  console.log(`  Keyword accuracy: ${(overallAccuracy * 100).toFixed(1)}% (${totalKeywordsFound}/${totalKeywordsExpected})`);
  console.log(`  Challenges passed (≥50% keywords): ${totalHits}/${results.length}`);

  // Quality per token comparison
  const baselineQPT = overallAccuracy / (totalBaselineTokens / 1000);
  const awmQPT = overallAccuracy / (totalAWMTokens / 1000);
  console.log(`\nEfficiency:`);
  console.log(`  Baseline quality/1K tokens: ${baselineQPT.toFixed(3)}`);
  console.log(`  AWM quality/1K tokens:      ${awmQPT.toFixed(3)}`);
  console.log(`  Efficiency multiplier:      ${(awmQPT / baselineQPT).toFixed(1)}x`);

  // Cost projection
  const costPer1MTokens = 3.00; // Approximate input token cost for Claude/GPT
  const queriesPerDay = 50;
  const baselineDailyCost = (totalBaselineTokens / results.length) * queriesPerDay / 1_000_000 * costPer1MTokens;
  const awmDailyCost = (totalAWMTokens / results.length) * queriesPerDay / 1_000_000 * costPer1MTokens;
  console.log(`\nCost projection (${queriesPerDay} queries/day @ $${costPer1MTokens}/1M tokens):`);
  console.log(`  Baseline: $${baselineDailyCost.toFixed(2)}/day`);
  console.log(`  AWM:      $${awmDailyCost.toFixed(2)}/day`);
  console.log(`  Savings:  $${(baselineDailyCost - awmDailyCost).toFixed(2)}/day (${((1 - awmDailyCost/baselineDailyCost) * 100).toFixed(0)}%)`);

  // Grade
  let grade = 'NEEDS WORK';
  if (overallSavings >= 0.7 && overallAccuracy >= 0.7) grade = 'EXCELLENT';
  else if (overallSavings >= 0.5 && overallAccuracy >= 0.5) grade = 'GOOD';
  else if (overallSavings >= 0.3 && overallAccuracy >= 0.3) grade = 'FAIR';

  console.log(`\n${'-'.repeat(70)}`);
  console.log(`GRADE: ${grade}`);
  console.log(`Token savings: ${(overallSavings * 100).toFixed(1)}% | Recall accuracy: ${(overallAccuracy * 100).toFixed(1)}%`);
  console.log('='.repeat(70));

  process.exit(grade === 'EXCELLENT' || grade === 'GOOD' ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
