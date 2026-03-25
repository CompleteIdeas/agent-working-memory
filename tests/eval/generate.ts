/**
 * Synthetic fact stream generator for AWM eval benchmarks.
 *
 * Produces fixture JSON files:
 *   - facts.json       — 200 facts with unique IDs, timestamps, concepts, content
 *   - queries.json     — 50 queries with ground-truth memory IDs
 *   - multihop.json    — 20 causal chains of length 3 (A->B->C)
 *   - redundancy.json  — 50 base facts, each paraphrased 3 ways (150 total)
 *   - temporal.json    — 30 facts with controlled access counts and ages
 *
 * Run standalone: npx tsx tests/eval/generate.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

// ─── Helpers ──────────────────────────────────────────────────────

function uuid(): string { return randomUUID(); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// ─── Domain vocabularies ──────────────────────────────────────────

const DOMAINS = [
  'authentication', 'database', 'caching', 'deployment', 'logging',
  'monitoring', 'testing', 'security', 'networking', 'api-design',
  'state-management', 'error-handling', 'performance', 'serialization', 'concurrency',
  'migrations', 'configuration', 'messaging', 'search', 'storage',
];

const ACTIONS = [
  'implemented', 'discovered', 'fixed', 'refactored', 'optimized',
  'deprecated', 'migrated', 'configured', 'tested', 'documented',
];

const PATTERNS = [
  'retry with exponential backoff', 'circuit breaker pattern', 'event sourcing',
  'CQRS separation', 'saga orchestration', 'bulkhead isolation',
  'rate limiting with token bucket', 'write-ahead logging', 'optimistic locking',
  'connection pooling with health checks', 'blue-green deployment', 'feature flags',
  'structured logging with correlation IDs', 'dead letter queue', 'idempotency keys',
  'cache-aside with TTL', 'sharding by tenant ID', 'schema versioning',
  'graceful degradation', 'canary releases',
];

const COMPONENTS = [
  'UserService', 'OrderPipeline', 'PaymentGateway', 'NotificationHub',
  'SearchIndex', 'AnalyticsCollector', 'AuthMiddleware', 'CacheLayer',
  'MessageBroker', 'ConfigServer', 'HealthChecker', 'RateLimiter',
  'SessionManager', 'FileStorage', 'AuditLogger', 'TaskScheduler',
  'DataExporter', 'WebhookDispatcher', 'MetricsAggregator', 'FeatureFlagService',
];

const LANGUAGES = ['TypeScript', 'Python', 'Go', 'Rust', 'Java'];

// ─── Fact types ───────────────────────────────────────────────────

export interface Fact {
  id: string;
  concept: string;
  content: string;
  tags: string[];
  timestamp: string; // ISO
}

export interface Query {
  id: string;
  text: string;
  groundTruth: string[]; // fact IDs that should be retrieved
  description: string;
}

export interface MultihopChain {
  id: string;
  facts: [Fact, Fact, Fact]; // A -> B -> C
  query: string;             // Query about A that should retrieve C
  groundTruth: string[];     // [C.id] or [B.id, C.id]
}

export interface RedundancyCluster {
  canonicalId: string;
  canonical: Fact;
  paraphrases: Fact[];
}

export interface TemporalFact {
  fact: Fact;
  targetAccessCount: number;
  targetAgeMs: number;
  expectedRank: number; // 1 = highest activation, 30 = lowest
}

// ─── Generators ───────────────────────────────────────────────────

function generateFact(index: number): Fact {
  const domain = DOMAINS[index % DOMAINS.length];
  const action = ACTIONS[index % ACTIONS.length];
  const pattern = PATTERNS[index % PATTERNS.length];
  const component = COMPONENTS[index % COMPONENTS.length];
  const lang = LANGUAGES[index % LANGUAGES.length];

  return {
    id: uuid(),
    concept: `${domain}/${component}`,
    content: `${action} ${pattern} in ${component} using ${lang}. `
      + `This addresses the ${domain} concern for the ${component.toLowerCase()} module. `
      + `Key insight: ${pattern} reduces failure rate by ${10 + (index % 40)}% under load.`,
    tags: [domain, component.toLowerCase(), lang.toLowerCase(), action],
    timestamp: new Date(Date.now() - (index * 3600_000)).toISOString(),
  };
}

function generateFacts(count: number): Fact[] {
  return Array.from({ length: count }, (_, i) => generateFact(i));
}

function generateQueries(facts: Fact[]): Query[] {
  const queries: Query[] = [];

  for (let i = 0; i < 50; i++) {
    // Each query targets 1-3 facts
    const targetCount = 1 + (i % 3);
    const startIdx = (i * 4) % facts.length;
    const targets = facts.slice(startIdx, startIdx + targetCount);

    // Build query from the first target's domain context
    const primary = targets[0];
    const domain = primary.tags[0];
    const component = primary.tags[1];

    queries.push({
      id: uuid(),
      text: `How did we handle ${domain} in the ${component} module? What patterns were applied?`,
      groundTruth: targets.map(f => f.id),
      description: `Targets ${targetCount} facts about ${domain}/${component}`,
    });
  }

  return queries;
}

function generateMultihopChains(): MultihopChain[] {
  const chains: MultihopChain[] = [];

  const causalTemplates = [
    {
      a: { concept: 'outage/root-cause', cause: 'connection pool exhaustion' },
      b: { concept: 'investigation/finding', finding: 'missing connection timeout' },
      c: { concept: 'fix/resolution', fix: 'added 30s connection timeout and pool recycling' },
      query: 'What was the resolution for the connection pool exhaustion outage?',
    },
    {
      a: { concept: 'bug/memory-leak', cause: 'event listeners not cleaned up in React components' },
      b: { concept: 'debugging/profiling', finding: 'heap snapshot showed 5000 detached DOM nodes' },
      c: { concept: 'fix/cleanup', fix: 'added useEffect cleanup functions to all subscription hooks' },
      query: 'How did we fix the memory leak from event listeners in React?',
    },
    {
      a: { concept: 'requirement/compliance', cause: 'GDPR requires data deletion within 30 days' },
      b: { concept: 'design/architecture', finding: 'soft-delete pattern with scheduled hard-delete job' },
      c: { concept: 'implementation/service', fix: 'DataRetentionService runs nightly, purges expired soft-deletes' },
      query: 'What service handles GDPR data deletion requirements?',
    },
    {
      a: { concept: 'perf/degradation', cause: 'API latency spiked to 2s p99 after deploying v3.2' },
      b: { concept: 'analysis/bottleneck', finding: 'N+1 query in order list endpoint loading 500 items' },
      c: { concept: 'fix/optimization', fix: 'batched order loading with DataLoader, p99 back to 200ms' },
      query: 'How was the API latency regression after v3.2 deploy fixed?',
    },
    {
      a: { concept: 'incident/security', cause: 'JWT tokens not invalidated on password change' },
      b: { concept: 'design/token-strategy', finding: 'need token version field tied to password hash' },
      c: { concept: 'implementation/auth', fix: 'added tokenVersion to user model, incremented on password change, validated on every request' },
      query: 'How do we invalidate JWTs when a user changes their password?',
    },
  ];

  for (let i = 0; i < 20; i++) {
    const template = causalTemplates[i % causalTemplates.length];
    const variant = i >= 5 ? ` (variant ${Math.floor(i / 5)})` : '';
    const baseTime = Date.now() - (i * 86400_000);

    const factA: Fact = {
      id: uuid(),
      concept: template.a.concept,
      content: `${template.a.cause}${variant}`,
      tags: [template.a.concept.split('/')[0], 'chain-' + i],
      timestamp: new Date(baseTime - 7200_000).toISOString(),
    };

    const factB: Fact = {
      id: uuid(),
      concept: template.b.concept,
      content: `${template.b.finding}${variant}. Caused by: ${template.a.cause}${variant}`,
      tags: [template.b.concept.split('/')[0], 'chain-' + i],
      timestamp: new Date(baseTime - 3600_000).toISOString(),
    };

    const factC: Fact = {
      id: uuid(),
      concept: template.c.concept,
      content: `${template.c.fix}${variant}. Root cause was: ${template.a.cause}${variant}`,
      tags: [template.c.concept.split('/')[0], 'chain-' + i],
      timestamp: new Date(baseTime).toISOString(),
    };

    chains.push({
      id: uuid(),
      facts: [factA, factB, factC],
      query: template.query + variant,
      groundTruth: [factC.id, factB.id], // C is primary, B is secondary
    });
  }

  return chains;
}

function generateRedundancyClusters(): RedundancyCluster[] {
  const clusters: RedundancyCluster[] = [];

  const baseKnowledge = [
    { concept: 'pattern/retry', base: 'Use exponential backoff when retrying failed HTTP requests to avoid thundering herd' },
    { concept: 'decision/database', base: 'Chose PostgreSQL over MongoDB for the order service because we need ACID transactions' },
    { concept: 'convention/naming', base: 'All API endpoints use kebab-case paths and camelCase JSON fields' },
    { concept: 'architecture/caching', base: 'Redis cache sits in front of the product catalog with a 5-minute TTL' },
    { concept: 'security/auth', base: 'JWT access tokens expire after 15 minutes, refresh tokens after 7 days' },
    { concept: 'testing/strategy', base: 'Integration tests run against a real database, not mocks, to catch migration issues' },
    { concept: 'deployment/pipeline', base: 'CI runs lint, unit tests, then deploys to staging automatically on merge to main' },
    { concept: 'monitoring/alerts', base: 'PagerDuty alerts fire when error rate exceeds 1% over a 5-minute window' },
    { concept: 'pattern/circuit-breaker', base: 'Circuit breaker opens after 5 consecutive failures and resets after 30 seconds' },
    { concept: 'decision/queue', base: 'Switched from RabbitMQ to Redis BullMQ for job processing because simpler ops' },
  ];

  const paraphraseTemplates = [
    (base: string) => `We decided to ${base.toLowerCase().replace(/^use |^chose |^all |^redis |^jwt |^ci |^pagerduty |^circuit |^switched /i, '')}`,
    (base: string) => `Key learning: ${base}. This has been validated in production.`,
    (base: string) => `${base} — this is now standard practice across all services.`,
  ];

  for (let i = 0; i < 50; i++) {
    const template = baseKnowledge[i % baseKnowledge.length];
    const variant = i >= 10 ? ` (context ${Math.floor(i / 10)})` : '';
    const canonicalId = uuid();

    const canonical: Fact = {
      id: canonicalId,
      concept: template.concept,
      content: template.base + variant,
      tags: [template.concept.split('/')[0], template.concept.split('/')[1]],
      timestamp: new Date(Date.now() - (i * 7200_000)).toISOString(),
    };

    const paraphrases = paraphraseTemplates.map((fn, j) => ({
      id: uuid(),
      concept: template.concept,
      content: fn(template.base + variant),
      tags: [template.concept.split('/')[0], template.concept.split('/')[1]],
      timestamp: new Date(Date.now() - (i * 7200_000) + ((j + 1) * 600_000)).toISOString(),
    }));

    clusters.push({ canonicalId, canonical, paraphrases });
  }

  return clusters;
}

function generateTemporalFacts(): TemporalFact[] {
  const facts: TemporalFact[] = [];

  // Access counts: [0, 1, 5, 10, 20]
  const accessCounts = [0, 1, 5, 10, 20];
  // Ages: [1h, 1d, 7d, 30d, 90d] in ms
  const ages = [
    3600_000,          // 1h
    86400_000,         // 1d
    604800_000,        // 7d
    2592000_000,       // 30d
    7776000_000,       // 90d
  ];

  // 5 access levels x 6 age buckets = 30 facts
  // ACT-R activation: B(n,t) = ln(n * t^(-d)) where d ≈ 0.5
  // Higher access count + more recent = higher activation
  let idx = 0;
  for (const accessCount of accessCounts) {
    for (const ageMs of ages) {
      if (idx >= 30) break;
      const domain = DOMAINS[idx % DOMAINS.length];
      const component = COMPONENTS[idx % COMPONENTS.length];

      // Expected ACT-R activation (higher = better ranking)
      const n = Math.max(accessCount, 1); // avoid ln(0)
      const tDays = ageMs / 86400_000;
      const activation = Math.log(n * Math.pow(Math.max(tDays, 0.01), -0.35));

      facts.push({
        fact: {
          id: uuid(),
          concept: `temporal/${domain}`,
          content: `Temporal test fact #${idx}: ${domain} pattern in ${component}. `
            + `Access count target: ${accessCount}, age target: ${Math.round(ageMs / 3600_000)}h. `
            + `This fact tests ACT-R decay modeling.`,
          tags: ['temporal', domain, `access-${accessCount}`, `age-${Math.round(ageMs / 3600_000)}h`],
          timestamp: new Date(Date.now() - ageMs).toISOString(),
        },
        targetAccessCount: accessCount,
        targetAgeMs: ageMs,
        expectedRank: 0, // Will be computed after sorting by activation
      });
      idx++;
    }
  }

  // Sort by expected activation (descending) and assign ranks
  const activations = facts.map(f => {
    const n = Math.max(f.targetAccessCount, 1);
    const tDays = f.targetAgeMs / 86400_000;
    return Math.log(n * Math.pow(Math.max(tDays, 0.01), -0.35));
  });
  const sorted = activations.map((a, i) => ({ a, i })).sort((x, y) => y.a - x.a);
  sorted.forEach((entry, rank) => {
    facts[entry.i].expectedRank = rank + 1;
  });

  return facts;
}

// ─── Main ─────────────────────────────────────────────────────────

export function generateAll() {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  const facts = generateFacts(200);
  const queries = generateQueries(facts);
  const multihop = generateMultihopChains();
  const redundancy = generateRedundancyClusters();
  const temporal = generateTemporalFacts();

  writeFileSync(join(FIXTURES_DIR, 'facts.json'), JSON.stringify(facts, null, 2));
  writeFileSync(join(FIXTURES_DIR, 'queries.json'), JSON.stringify(queries, null, 2));
  writeFileSync(join(FIXTURES_DIR, 'multihop.json'), JSON.stringify(multihop, null, 2));
  writeFileSync(join(FIXTURES_DIR, 'redundancy.json'), JSON.stringify(redundancy, null, 2));
  writeFileSync(join(FIXTURES_DIR, 'temporal.json'), JSON.stringify(temporal, null, 2));

  console.log(`Generated fixtures in ${FIXTURES_DIR}:`);
  console.log(`  facts.json       — ${facts.length} facts`);
  console.log(`  queries.json     — ${queries.length} queries`);
  console.log(`  multihop.json    — ${multihop.length} causal chains`);
  console.log(`  redundancy.json  — ${redundancy.length} clusters (${redundancy.length * 4} total facts)`);
  console.log(`  temporal.json    — ${temporal.length} temporal facts`);

  return { facts, queries, multihop, redundancy, temporal };
}

// Run standalone
if (process.argv[1]?.includes('generate')) {
  generateAll();
}
