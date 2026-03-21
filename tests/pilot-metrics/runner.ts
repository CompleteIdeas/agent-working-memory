/**
 * Pilot Trend Metrics — tracks AWM quality over time.
 *
 * Runs a fixed set of seed memories + queries, measures:
 *   1. Pre-sleep hit rate (top-1 and top-5 relevance)
 *   2. Post-sleep hit rate (same queries after consolidation)
 *   3. Noise in top-5 (irrelevant results)
 *   4. Latency (p50, p95)
 *   5. DB growth (engrams, associations, DB file size)
 *
 * Appends results to pilot-metrics/trend.jsonl for plotting.
 * Uses a fixed seed for deterministic seeding (AWM_TEST_SEED=42).
 *
 * Run: npx tsx tests/pilot-metrics/runner.ts [baseUrl]
 * Add to npm scripts: "test:pilot": "tsx tests/pilot-metrics/runner.ts"
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRng } from '../utils/seeded-random.js';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const RESULTS_DIR = import.meta.dirname;
const TREND_FILE = join(RESULTS_DIR, 'trend.jsonl');
const REPORT_FILE = join(RESULTS_DIR, 'latest.md');

const rng = createRng(42); // Always deterministic for comparability

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TMP_DIR = join(tmpdir(), 'awm-pilot-metrics');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

let reqCounter = 0;

async function api(method: string, path: string, body?: any): Promise<any> {
  await sleep(10);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${BASE_URL}${path}`;
      let cmd = `curl -sf -X ${method}`;
      if (body) {
        const tmpFile = join(TMP_DIR, `req_${reqCounter++}.json`);
        writeFileSync(tmpFile, JSON.stringify(body));
        cmd += ` -H "Content-Type: application/json" -d @"${tmpFile.replace(/\\/g, '/')}"`;
      }
      cmd += ` "${url}"`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
      return JSON.parse(result);
    } catch (err: any) {
      if (attempt < 2) { await sleep(1000); continue; }
      return { error: err.message };
    }
  }
  return { error: 'max retries' };
}

// ─── Fixed Seed Data ──────────────────────────────────────

interface SeedMemory {
  concept: string;
  content: string;
  tags: string[];
  eventType: string;
  surprise: number;
  causalDepth: number;
}

interface FixedQuery {
  context: string;
  expectedTags: string[];  // At least one should appear in results
  noise: boolean;          // True = should return nothing
  label: string;
}

// 30 memories across 3 topic clusters — deterministic content
const SEED_MEMORIES: SeedMemory[] = [
  // Cluster: Authentication (10)
  { concept: 'JWT token validation', content: 'JWT tokens are validated by checking the signature with the public key. Expired tokens return 401.', tags: ['auth', 'jwt'], eventType: 'causal', surprise: 0.5, causalDepth: 0.7 },
  { concept: 'OAuth2 refresh flow', content: 'Refresh tokens are stored in httpOnly cookies. Access tokens expire after 15 minutes.', tags: ['auth', 'oauth'], eventType: 'decision', surprise: 0.4, causalDepth: 0.6 },
  { concept: 'Session management', content: 'Sessions are stored in Redis with 24h TTL. Session ID is a signed cookie.', tags: ['auth', 'session'], eventType: 'causal', surprise: 0.3, causalDepth: 0.5 },
  { concept: 'Password hashing', content: 'Passwords are hashed with bcrypt cost factor 12. Migration from MD5 completed last quarter.', tags: ['auth', 'security'], eventType: 'decision', surprise: 0.6, causalDepth: 0.7 },
  { concept: 'Rate limiting auth', content: 'Login attempts limited to 5 per minute per IP. Lockout after 10 failed attempts.', tags: ['auth', 'security'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'RBAC permissions', content: 'Role-based access control with admin, editor, viewer roles. Permissions checked in middleware.', tags: ['auth', 'rbac'], eventType: 'causal', surprise: 0.3, causalDepth: 0.6 },
  { concept: 'MFA implementation', content: 'Two-factor auth uses TOTP with 30-second window. Backup codes generated at enrollment.', tags: ['auth', 'mfa'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'API key auth', content: 'API keys are SHA-256 hashed in the database. Plain key shown once at creation.', tags: ['auth', 'api'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'SSO integration', content: 'SAML SSO configured for enterprise customers. IdP metadata refreshed daily.', tags: ['auth', 'sso'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Auth audit logging', content: 'All auth events logged to immutable audit trail. Retained for 90 days.', tags: ['auth', 'audit'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },

  // Cluster: Database (10)
  { concept: 'Connection pooling', content: 'PostgreSQL connection pool set to 20 connections. Idle timeout 10 seconds.', tags: ['database', 'postgres'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Index optimization', content: 'Composite index on (user_id, created_at) reduced query time from 2s to 15ms.', tags: ['database', 'performance'], eventType: 'causal', surprise: 0.7, causalDepth: 0.8 },
  { concept: 'Migration strategy', content: 'Database migrations run in transactions. Rollback tested before each deploy.', tags: ['database', 'migration'], eventType: 'decision', surprise: 0.3, causalDepth: 0.5 },
  { concept: 'Backup schedule', content: 'Full backup daily at 3AM UTC. Point-in-time recovery enabled with WAL archiving.', tags: ['database', 'backup'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Query deadlocks', content: 'Deadlock detected in payment processing. Fixed by consistent lock ordering on accounts table.', tags: ['database', 'deadlock'], eventType: 'friction', surprise: 0.8, causalDepth: 0.9 },
  { concept: 'Partitioning events', content: 'Events table partitioned by month. Queries on recent data 10x faster.', tags: ['database', 'partition'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Read replicas', content: 'Two read replicas for reporting queries. Replication lag under 100ms.', tags: ['database', 'replica'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Schema versioning', content: 'Using numbered migration files. Schema version stored in metadata table.', tags: ['database', 'schema'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Full-text search', content: 'PostgreSQL tsvector for search. GIN index on documents table, trigram similarity for fuzzy match.', tags: ['database', 'search'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Database monitoring', content: 'pg_stat_statements enabled. Slow query log threshold set to 500ms.', tags: ['database', 'monitoring'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },

  // Cluster: Payments (10)
  { concept: 'Stripe integration', content: 'Stripe checkout sessions for one-time payments. Webhook handles payment_intent.succeeded.', tags: ['payments', 'stripe'], eventType: 'causal', surprise: 0.4, causalDepth: 0.6 },
  { concept: 'Subscription billing', content: 'Monthly subscriptions with Stripe Billing. Proration on plan changes.', tags: ['payments', 'subscription'], eventType: 'decision', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Refund policy', content: 'Full refund within 14 days. Partial refund prorated after that. No refund after 30 days.', tags: ['payments', 'refund'], eventType: 'decision', surprise: 0.3, causalDepth: 0.5 },
  { concept: 'Invoice generation', content: 'Invoices generated on subscription renewal. PDF sent via email and stored in S3.', tags: ['payments', 'invoice'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Payment retry logic', content: 'Failed payments retried 3 times over 7 days. Dunning emails sent on each attempt.', tags: ['payments', 'retry'], eventType: 'decision', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Tax calculation', content: 'Tax calculated via Stripe Tax. VAT for EU, sales tax for US states.', tags: ['payments', 'tax'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'PCI compliance', content: 'No card data touches our servers. Stripe Elements handles all card input client-side.', tags: ['payments', 'security'], eventType: 'causal', surprise: 0.4, causalDepth: 0.5 },
  { concept: 'Currency handling', content: 'Prices stored in cents. Multi-currency support via Stripe. Conversion at checkout time.', tags: ['payments', 'currency'], eventType: 'decision', surprise: 0.3, causalDepth: 0.4 },
  { concept: 'Webhook verification', content: 'Stripe webhooks verified with endpoint secret. Events are idempotent via event ID dedup.', tags: ['payments', 'webhook'], eventType: 'causal', surprise: 0.5, causalDepth: 0.6 },
  { concept: 'Payment analytics', content: 'MRR and churn tracked in Metabase dashboard. Revenue recognized on invoice finalization.', tags: ['payments', 'analytics'], eventType: 'observation', surprise: 0.3, causalDepth: 0.4 },
];

// 15 fixed queries — mix of single-topic, cross-topic, and noise
const FIXED_QUERIES: FixedQuery[] = [
  // Single-topic (should match clearly)
  { context: 'How are JWT tokens validated?', expectedTags: ['auth', 'jwt'], noise: false, label: 'JWT validation' },
  { context: 'What is the database backup schedule?', expectedTags: ['database', 'backup'], noise: false, label: 'DB backup' },
  { context: 'How do refunds work?', expectedTags: ['payments', 'refund'], noise: false, label: 'Refund policy' },
  { context: 'How is rate limiting configured for login?', expectedTags: ['auth', 'security'], noise: false, label: 'Rate limiting' },
  { context: 'What indexes exist on the database?', expectedTags: ['database', 'performance'], noise: false, label: 'DB indexes' },

  // Cross-topic (should benefit from consolidation)
  { context: 'How do database deadlocks affect payment processing?', expectedTags: ['database', 'payments'], noise: false, label: 'Deadlock + payments' },
  { context: 'What security measures protect payment authentication?', expectedTags: ['auth', 'payments', 'security'], noise: false, label: 'Auth + payment security' },
  { context: 'How is the database connection pool configured for the auth service?', expectedTags: ['database', 'auth'], noise: false, label: 'DB pool + auth' },
  { context: 'How does webhook verification relate to payment retry?', expectedTags: ['payments', 'webhook', 'retry'], noise: false, label: 'Webhook + retry' },
  { context: 'What audit logging exists for payment and auth events?', expectedTags: ['auth', 'payments', 'audit'], noise: false, label: 'Audit + payments' },

  // Noise queries (should return nothing or low relevance)
  { context: 'What is the best recipe for chocolate cake?', expectedTags: [], noise: true, label: 'Noise: cooking' },
  { context: 'How does photosynthesis work in plants?', expectedTags: [], noise: true, label: 'Noise: biology' },
  { context: 'What are the rules of basketball?', expectedTags: [], noise: true, label: 'Noise: sports' },
  { context: 'How to train a puppy to sit?', expectedTags: [], noise: true, label: 'Noise: pets' },
  { context: 'What is the capital of Mongolia?', expectedTags: [], noise: true, label: 'Noise: geography' },
];

// ─── Scoring ──────────────────────────────────────

interface QuizResult {
  label: string;
  top1Hit: boolean;    // First result matches expected tags
  top5Hits: number;    // Count of results matching expected tags in top 5
  top5Noise: number;   // Count of results NOT matching any expected tag in top 5
  top1Score: number;   // Score of the first result
  latencyMs: number;
  isNoise: boolean;
  noiseRejected: boolean; // For noise queries: true if 0 results returned
}

async function runQuiz(agentId: string, label: string): Promise<QuizResult[]> {
  const results: QuizResult[] = [];

  for (const q of FIXED_QUERIES) {
    const start = performance.now();
    const res = await api('POST', '/memory/activate', {
      agentId,
      context: q.context,
      limit: 5,
      useReranker: true,
      useExpansion: true,
    });
    const latencyMs = performance.now() - start;

    const activated = res.results ?? [];

    if (q.noise) {
      results.push({
        label: q.label,
        top1Hit: false,
        top5Hits: 0,
        top5Noise: activated.length,
        top1Score: activated[0]?.score ?? 0,
        latencyMs,
        isNoise: true,
        noiseRejected: activated.length === 0,
      });
    } else {
      const expectedSet = new Set(q.expectedTags);
      let top1Hit = false;
      let top5Hits = 0;
      let top5Noise = 0;

      for (let i = 0; i < Math.min(activated.length, 5); i++) {
        const tags: string[] = activated[i].engram?.tags ?? [];
        const matches = tags.some((t: string) => expectedSet.has(t));
        if (matches) {
          top5Hits++;
          if (i === 0) top1Hit = true;
        } else {
          top5Noise++;
        }
      }

      results.push({
        label: q.label,
        top1Hit,
        top5Hits,
        top5Noise,
        top1Score: activated[0]?.score ?? 0,
        latencyMs,
        isNoise: false,
        noiseRejected: false,
      });
    }
  }

  return results;
}

// ─── Main ──────────────────────────────────────

interface TrendEntry {
  timestamp: string;
  version: string;
  preSleep: {
    top1HitRate: number;
    top5HitRate: number;
    noiseInTop5: number;
    noiseRejectionRate: number;
    avgTop1Score: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  };
  postSleep: {
    top1HitRate: number;
    top5HitRate: number;
    noiseInTop5: number;
    noiseRejectionRate: number;
    avgTop1Score: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  };
  delta: {
    top1HitRate: number;
    top5HitRate: number;
    noiseInTop5: number;
    avgTop1Score: number;
  };
  db: {
    activeEngrams: number;
    associations: number;
    dbSizeBytes: number;
  };
}

function summarize(results: QuizResult[]) {
  const nonNoise = results.filter(r => !r.isNoise);
  const noiseQ = results.filter(r => r.isNoise);

  const top1Hits = nonNoise.filter(r => r.top1Hit).length;
  const top5TotalHits = nonNoise.reduce((s, r) => s + r.top5Hits, 0);
  const top5TotalPossible = nonNoise.length * 5;
  const noiseInTop5 = nonNoise.reduce((s, r) => s + r.top5Noise, 0);
  const noiseRejected = noiseQ.filter(r => r.noiseRejected).length;

  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  const avgTop1 = nonNoise.length > 0
    ? nonNoise.reduce((s, r) => s + r.top1Score, 0) / nonNoise.length
    : 0;

  return {
    top1HitRate: nonNoise.length > 0 ? top1Hits / nonNoise.length : 0,
    top5HitRate: top5TotalPossible > 0 ? top5TotalHits / top5TotalPossible : 0,
    noiseInTop5,
    noiseRejectionRate: noiseQ.length > 0 ? noiseRejected / noiseQ.length : 0,
    avgTop1Score: avgTop1,
    p50LatencyMs: Math.round(p50),
    p95LatencyMs: Math.round(p95),
  };
}

async function main() {
  console.log('AgentWorkingMemory — Pilot Trend Metrics');
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

  // Register fresh agent
  const agent = await api('POST', '/agent/register', { name: 'pilot-metrics-agent' });
  const agentId = agent.id;
  console.log(`Agent: ${agentId}`);

  // ── PHASE 1: Seed memories ──
  console.log('\n=== PHASE 1: SEEDING 30 FIXED MEMORIES ===');
  let seeded = 0;
  for (const mem of SEED_MEMORIES) {
    await api('POST', '/memory/write', {
      agentId,
      concept: mem.concept,
      content: mem.content,
      tags: mem.tags,
      eventType: mem.eventType,
      surprise: mem.surprise,
      causalDepth: mem.causalDepth,
      resolutionEffort: 0.3,
      decisionMade: mem.eventType === 'decision',
    });
    seeded++;
  }
  console.log(`  Seeded ${seeded} memories`);
  console.log('  Waiting for embeddings...');
  await sleep(5000);

  // ── PHASE 2: Pre-sleep quiz ──
  console.log('\n=== PHASE 2: PRE-SLEEP QUIZ ===');
  const preResults = await runQuiz(agentId, 'pre-sleep');
  const preSummary = summarize(preResults);

  console.log(`  Top-1 hit rate: ${(preSummary.top1HitRate * 100).toFixed(0)}%`);
  console.log(`  Top-5 hit rate: ${(preSummary.top5HitRate * 100).toFixed(0)}%`);
  console.log(`  Noise in top-5: ${preSummary.noiseInTop5}`);
  console.log(`  Noise rejection: ${(preSummary.noiseRejectionRate * 100).toFixed(0)}%`);
  console.log(`  Avg top-1 score: ${preSummary.avgTop1Score.toFixed(3)}`);
  console.log(`  Latency p50/p95: ${preSummary.p50LatencyMs}ms / ${preSummary.p95LatencyMs}ms`);

  // ── PHASE 3: Sleep cycle ──
  console.log('\n=== PHASE 3: CONSOLIDATION (SLEEP CYCLE) ===');
  const consolidateRes = await api('POST', '/system/consolidate', { agentId });
  console.log(`  Clusters: ${consolidateRes.clustersFound ?? 0}`);
  console.log(`  Edges strengthened: ${consolidateRes.edgesStrengthened ?? 0}`);
  console.log(`  Bridges: ${consolidateRes.bridgesCreated ?? 0}`);

  // ── PHASE 4: Post-sleep quiz ──
  console.log('\n=== PHASE 4: POST-SLEEP QUIZ ===');
  const postResults = await runQuiz(agentId, 'post-sleep');
  const postSummary = summarize(postResults);

  console.log(`  Top-1 hit rate: ${(postSummary.top1HitRate * 100).toFixed(0)}%`);
  console.log(`  Top-5 hit rate: ${(postSummary.top5HitRate * 100).toFixed(0)}%`);
  console.log(`  Noise in top-5: ${postSummary.noiseInTop5}`);
  console.log(`  Noise rejection: ${(postSummary.noiseRejectionRate * 100).toFixed(0)}%`);
  console.log(`  Avg top-1 score: ${postSummary.avgTop1Score.toFixed(3)}`);
  console.log(`  Latency p50/p95: ${postSummary.p50LatencyMs}ms / ${postSummary.p95LatencyMs}ms`);

  // ── PHASE 5: DB stats ──
  console.log('\n=== PHASE 5: DB STATS ===');
  const stats = await api('GET', `/agent/${agentId}/stats`);

  // Try to get DB file size
  let dbSizeBytes = 0;
  const dbPath = process.env.AWM_DB_PATH ?? 'memory.db';
  try { dbSizeBytes = statSync(dbPath).size; } catch {
    try { dbSizeBytes = statSync('data/memory.db').size; } catch {}
  }

  console.log(`  Active engrams: ${stats.engrams?.active ?? '?'}`);
  console.log(`  Associations: ${stats.associations ?? '?'}`);
  console.log(`  DB size: ${(dbSizeBytes / 1024).toFixed(0)} KB`);

  // ── PHASE 6: Report ──
  const delta = {
    top1HitRate: postSummary.top1HitRate - preSummary.top1HitRate,
    top5HitRate: postSummary.top5HitRate - preSummary.top5HitRate,
    noiseInTop5: postSummary.noiseInTop5 - preSummary.noiseInTop5,
    avgTop1Score: postSummary.avgTop1Score - preSummary.avgTop1Score,
  };

  console.log('\n' + '='.repeat(60));
  console.log('DELTA (post-sleep - pre-sleep)');
  console.log('='.repeat(60));
  console.log(`  Top-1 hit rate: ${delta.top1HitRate >= 0 ? '+' : ''}${(delta.top1HitRate * 100).toFixed(0)}pp`);
  console.log(`  Top-5 hit rate: ${delta.top5HitRate >= 0 ? '+' : ''}${(delta.top5HitRate * 100).toFixed(0)}pp`);
  console.log(`  Noise in top-5: ${delta.noiseInTop5 >= 0 ? '+' : ''}${delta.noiseInTop5}`);
  console.log(`  Avg top-1 score: ${delta.avgTop1Score >= 0 ? '+' : ''}${delta.avgTop1Score.toFixed(3)}`);

  if (delta.top1HitRate > 0) console.log('\n  ✓ Consolidation IMPROVED top-1 recall');
  else if (delta.top1HitRate === 0) console.log('\n  — Consolidation had NO EFFECT on top-1 recall');
  else console.log('\n  ✗ Consolidation DEGRADED top-1 recall');

  // ── Save trend data ──
  const entry: TrendEntry = {
    timestamp: new Date().toISOString(),
    version: health.version ?? 'unknown',
    preSleep: preSummary,
    postSleep: postSummary,
    delta,
    db: {
      activeEngrams: stats.engrams?.active ?? 0,
      associations: stats.associations ?? 0,
      dbSizeBytes,
    },
  };

  appendFileSync(TREND_FILE, JSON.stringify(entry) + '\n');
  console.log(`\nTrend data appended to ${TREND_FILE}`);

  // ── Write latest markdown report ──
  const lines = [
    `# Pilot Metrics — ${entry.timestamp}`,
    ``,
    `Version: ${entry.version}`,
    ``,
    `## Pre-Sleep`,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Top-1 hit rate | ${(preSummary.top1HitRate * 100).toFixed(0)}% |`,
    `| Top-5 hit rate | ${(preSummary.top5HitRate * 100).toFixed(0)}% |`,
    `| Noise in top-5 | ${preSummary.noiseInTop5} |`,
    `| Noise rejection | ${(preSummary.noiseRejectionRate * 100).toFixed(0)}% |`,
    `| Avg top-1 score | ${preSummary.avgTop1Score.toFixed(3)} |`,
    `| Latency p50 | ${preSummary.p50LatencyMs}ms |`,
    `| Latency p95 | ${preSummary.p95LatencyMs}ms |`,
    ``,
    `## Post-Sleep`,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Top-1 hit rate | ${(postSummary.top1HitRate * 100).toFixed(0)}% |`,
    `| Top-5 hit rate | ${(postSummary.top5HitRate * 100).toFixed(0)}% |`,
    `| Noise in top-5 | ${postSummary.noiseInTop5} |`,
    `| Noise rejection | ${(postSummary.noiseRejectionRate * 100).toFixed(0)}% |`,
    `| Avg top-1 score | ${postSummary.avgTop1Score.toFixed(3)} |`,
    `| Latency p50 | ${postSummary.p50LatencyMs}ms |`,
    `| Latency p95 | ${postSummary.p95LatencyMs}ms |`,
    ``,
    `## Delta (post - pre)`,
    `| Metric | Change |`,
    `|--------|--------|`,
    `| Top-1 hit rate | ${delta.top1HitRate >= 0 ? '+' : ''}${(delta.top1HitRate * 100).toFixed(0)}pp |`,
    `| Top-5 hit rate | ${delta.top5HitRate >= 0 ? '+' : ''}${(delta.top5HitRate * 100).toFixed(0)}pp |`,
    `| Noise in top-5 | ${delta.noiseInTop5 >= 0 ? '+' : ''}${delta.noiseInTop5} |`,
    `| Avg top-1 score | ${delta.avgTop1Score >= 0 ? '+' : ''}${delta.avgTop1Score.toFixed(3)} |`,
    ``,
    `## DB`,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Active engrams | ${entry.db.activeEngrams} |`,
    `| Associations | ${entry.db.associations} |`,
    `| DB size | ${(entry.db.dbSizeBytes / 1024).toFixed(0)} KB |`,
    ``,
  ];
  writeFileSync(REPORT_FILE, lines.join('\n'));
  console.log(`Report written to ${REPORT_FILE}`);

  // ── Per-query detail ──
  console.log('\n' + '-'.repeat(60));
  console.log('PER-QUERY DETAIL (post-sleep)');
  console.log('-'.repeat(60));
  for (const r of postResults) {
    const status = r.isNoise
      ? (r.noiseRejected ? '✓ rejected' : `✗ leaked ${r.top5Noise}`)
      : (r.top1Hit ? '✓' : '✗');
    console.log(`  ${status} ${r.label} (score: ${r.top1Score.toFixed(3)}, ${Math.round(r.latencyMs)}ms)`);
  }

  // Show trend if we have history
  if (existsSync(TREND_FILE)) {
    const trendLines = readFileSync(TREND_FILE, 'utf8').trim().split('\n');
    if (trendLines.length > 1) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`TREND (${trendLines.length} runs)`);
      console.log(`${'─'.repeat(60)}`);
      for (const line of trendLines) {
        try {
          const e = JSON.parse(line) as TrendEntry;
          const ts = e.timestamp.slice(0, 16).replace('T', ' ');
          console.log(`  ${ts}  pre=${(e.preSleep.top1HitRate * 100).toFixed(0)}% post=${(e.postSleep.top1HitRate * 100).toFixed(0)}% delta=${e.delta.top1HitRate >= 0 ? '+' : ''}${(e.delta.top1HitRate * 100).toFixed(0)}pp  noise=${e.postSleep.noiseInTop5}  db=${e.db.activeEngrams}eng/${e.db.associations}assoc`);
        } catch {}
      }
    }
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(err => {
  console.error('Pilot metrics failed:', err);
  process.exit(1);
});
