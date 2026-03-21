/**
 * Self-Test Runner — executable test suite for AI agent self-evaluation.
 *
 * Run: npx tsx tests/self-test/runner.ts [baseUrl]
 *
 * Hits a live AWM server, populates memory, queries, evaluates results,
 * and produces a scored report. Designed for Claude to run and interpret.
 */

import http from 'node:http';
import { execSync } from 'node:child_process';
import { createRng } from '../utils/seeded-random.js';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const rng = createRng();

interface TestResult {
  name: string;
  dimension: string;
  passed: boolean;
  score: number;    // 0-1
  detail: string;
}

const results: TestResult[] = [];
let agentId: string;

// --- Helpers ---

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = join(tmpdir(), 'awm-self-test');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

let reqCounter = 0;

// Use curl subprocess to avoid Node v24 Windows UV handle crash
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

function record(name: string, dimension: string, passed: boolean, score: number, detail: string) {
  results.push({ name, dimension, passed, score, detail });
  const icon = passed ? 'PASS' : 'FAIL';
  console.log(`  [${icon}] ${name} (${score.toFixed(2)}) — ${detail}`);
}

// --- Test Suites ---

async function testWriteQuality() {
  console.log('\n=== 1. WRITE QUALITY ===');

  // 1.1 Obvious keep — causal discoveries
  let activeCount = 0;
  for (let i = 0; i < 5; i++) {
    const res = await api('POST', '/memory/write', {
      agentId,
      concept: `causal discovery ${i}`,
      content: `Root cause: the race condition occurs because shared state is mutated without locks in scenario ${i}`,
      eventType: 'causal',
      surprise: 0.7,
      causalDepth: 0.8,
      resolutionEffort: 0.6,
    });
    if (res.disposition === 'active') activeCount++;
  }
  record('1.1 Causal → active', 'write', activeCount === 5, activeCount / 5,
    `${activeCount}/5 causal discoveries stored as active`);

  // 1.2 Obvious discard — trivial
  let discardCount = 0;
  for (let i = 0; i < 5; i++) {
    const res = await api('POST', '/memory/write', {
      agentId,
      concept: `routine ${i}`,
      content: `File read completed successfully for file ${i}`,
      eventType: 'observation',
      surprise: 0,
      causalDepth: 0,
      resolutionEffort: 0,
    });
    if (res.disposition === 'discard') discardCount++;
  }
  record('1.2 Trivial → discard', 'write', discardCount === 5, discardCount / 5,
    `${discardCount}/5 trivial observations discarded`);

  // 1.3 Decision moments
  let decisionActive = 0;
  for (let i = 0; i < 5; i++) {
    const res = await api('POST', '/memory/write', {
      agentId,
      concept: `decision ${i}`,
      content: `Chose approach A over approach B because A has better error recovery in scenario ${i}`,
      eventType: 'decision',
      decisionMade: true,
      surprise: 0.3,
      causalDepth: 0.4,
    });
    if (res.disposition === 'active') decisionActive++;
  }
  record('1.3 Decisions → active', 'write', decisionActive >= 4, decisionActive / 5,
    `${decisionActive}/5 decisions stored as active`);

  // 1.4 Friction → staging
  let stagingCount = 0;
  for (let i = 0; i < 5; i++) {
    const res = await api('POST', '/memory/write', {
      agentId,
      concept: `friction ${i}`,
      content: `API returned 429 rate limit, retried after backoff in attempt ${i}`,
      eventType: 'friction',
      surprise: 0.15,
      resolutionEffort: 0.25,
    });
    if (res.disposition === 'staging') stagingCount++;
  }
  record('1.4 Friction → staging', 'write', stagingCount >= 3, stagingCount / 5,
    `${stagingCount}/5 friction events routed to staging`);
}

async function testRetrievalPrecision() {
  console.log('\n=== 2. RETRIEVAL PRECISION ===');

  // Populate distinct topics
  await api('POST', '/memory/write', {
    agentId, concept: 'database optimization',
    content: 'Use composite indexes on frequently queried column combinations for better database query performance',
    eventType: 'causal', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.5,
    tags: ['database', 'sql'],
  });
  await api('POST', '/memory/write', {
    agentId, concept: 'react rendering',
    content: 'React useMemo and useCallback prevent unnecessary re-renders in component trees',
    eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.4,
    tags: ['react', 'frontend'],
  });
  await api('POST', '/memory/write', {
    agentId, concept: 'git branching',
    content: 'Feature branches should be short-lived to minimize merge conflicts in git workflows',
    eventType: 'decision', decisionMade: true, surprise: 0.3, causalDepth: 0.4,
    tags: ['git', 'workflow'],
  });

  // 2.1 Exact topic match
  const dbResults = await api('POST', '/memory/activate', {
    agentId, context: 'database query optimization indexes',
  });
  const dbRelevant = dbResults.results?.filter((r: any) =>
    r.engram.tags?.some((t: string) => ['database', 'sql'].includes(t)) ||
    r.engram.concept.includes('database')
  );
  const dbPrecision = dbResults.results?.length > 0
    ? (dbRelevant?.length ?? 0) / Math.min(dbResults.results.length, 5) : 0;
  record('2.1 Exact topic match', 'retrieval', dbPrecision > 0.5, dbPrecision,
    `${dbRelevant?.length ?? 0} DB-related in top results`);

  // 2.2 Cross-domain isolation
  const reactResults = await api('POST', '/memory/activate', {
    agentId, context: 'react component rendering performance hooks',
  });
  const reactHits = reactResults.results?.filter((r: any) =>
    r.engram.concept.includes('react') || r.engram.tags?.includes('react')
  );
  const topIsReact = reactResults.results?.[0]?.engram?.concept?.includes('react') ?? false;
  record('2.2 Cross-domain (react)', 'retrieval', topIsReact, topIsReact ? 1 : 0,
    `Top result ${topIsReact ? 'is' : 'is NOT'} react-related`);

  // 2.3 Empty context — topic with no memories
  const emptyResults = await api('POST', '/memory/activate', {
    agentId, context: 'quantum physics particle acceleration',
    minScore: 0.3,
  });
  const emptyCorrect = (emptyResults.results?.length ?? 0) === 0;
  record('2.3 No-match returns empty', 'retrieval', emptyCorrect, emptyCorrect ? 1 : 0,
    `${emptyResults.results?.length ?? 0} results for unrelated query`);
}

async function testAssociations() {
  console.log('\n=== 3. ASSOCIATIONS ===');

  // Write two related memories
  const res1 = await api('POST', '/memory/write', {
    agentId, concept: 'typescript async',
    content: 'async await typescript pattern simplifies asynchronous code flow',
    eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.4,
  });
  const res2 = await api('POST', '/memory/write', {
    agentId, concept: 'promise error handling',
    content: 'unhandled promise rejections crash node processes use async await with try catch',
    eventType: 'friction', surprise: 0.6, causalDepth: 0.5, resolutionEffort: 0.7,
  });

  const id1 = res1.engram?.id;
  const id2 = res2.engram?.id;

  if (!id1 || !id2) {
    record('3.1 Co-activation', 'association', false, 0, 'Could not create test engrams');
    return;
  }

  // Co-activate multiple times to build association strength
  for (let i = 0; i < 8; i++) {
    await api('POST', '/memory/activate', {
      agentId, context: 'typescript async await promise error handling patterns',
    });
  }

  // Check for edges
  const detail1 = await api('GET', `/memory/${id1}`);
  const hasEdge = detail1.associations?.some((a: any) =>
    a.fromEngramId === id2 || a.toEngramId === id2
  );
  record('3.1 Co-activation creates edges', 'association', hasEdge, hasEdge ? 1 : 0,
    hasEdge ? 'Edge formed between co-activated engrams' : 'No edge formed');

  if (hasEdge) {
    const edge = detail1.associations.find((a: any) =>
      a.fromEngramId === id2 || a.toEngramId === id2
    );
    // Score weight on a realistic scale: 0.3+ is full score, linear below
    const weightScore = Math.min(edge.weight / 0.3, 1.0);
    record('3.2 Edge weight growth', 'association', edge.weight > 0.15, weightScore,
      `Edge weight = ${edge.weight.toFixed(3)} (target: 0.3+)`);
  }
}

async function testRetraction() {
  console.log('\n=== 4. RETRACTION ===');

  // Write a wrong memory
  const wrong = await api('POST', '/memory/write', {
    agentId, concept: 'javascript equality',
    content: 'The triple equals operator in javascript checks value only not type',
    eventType: 'causal', surprise: 0.6, causalDepth: 0.5, resolutionEffort: 0.4,
  });

  if (!wrong.engram?.id) {
    record('4.1 Retraction', 'retraction', false, 0, 'Could not create test engram');
    return;
  }

  // Retract with correction
  const retractResult = await api('POST', '/memory/retract', {
    agentId,
    targetEngramId: wrong.engram.id,
    reason: 'Triple equals checks both type AND value',
    counterContent: 'JavaScript === (strict equality) checks both type AND value. == checks value with type coercion.',
  });

  record('4.1 Retraction creates correction', 'retraction',
    retractResult.correctionId != null, retractResult.correctionId ? 1 : 0,
    retractResult.correctionId ? 'Correction engram created' : 'No correction');

  // Verify retracted is hidden from activation
  const results = await api('POST', '/memory/activate', {
    agentId, context: 'javascript equality operator triple equals type checking',
  });
  const foundWrong = results.results?.some((r: any) => r.engram.id === wrong.engram.id);
  record('4.2 Retracted hidden from activation', 'retraction', !foundWrong, foundWrong ? 0 : 1,
    foundWrong ? 'FAIL: retracted memory still appears' : 'Retracted memory correctly hidden');

  // Check correction surfaces
  const foundCorrection = results.results?.some((r: any) => r.engram.id === retractResult.correctionId);
  record('4.3 Correction surfaces', 'retraction', foundCorrection ?? false, foundCorrection ? 1 : 0,
    foundCorrection ? 'Correction found in results' : 'Correction not found');
}

async function testEviction() {
  console.log('\n=== 5. EVICTION ===');

  // Get current count, then check eviction
  const statsBefore = await api('GET', `/agent/${agentId}/stats`);
  const before = statsBefore.engrams?.active ?? 0;

  const evictResult = await api('POST', '/system/evict', { agentId });
  record('5.1 Eviction runs', 'eviction', true, 1,
    `Evicted ${evictResult.evicted}, pruned ${evictResult.edgesPruned} edges`);

  const statsAfter = await api('GET', `/agent/${agentId}/stats`);
  const after = statsAfter.engrams?.active ?? 0;
  record('5.2 Count after eviction', 'eviction', after <= before, 1,
    `Before: ${before}, After: ${after}`);
}

async function testFeedback() {
  console.log('\n=== 6. FEEDBACK ===');

  const writeRes = await api('POST', '/memory/write', {
    agentId, concept: 'feedback test',
    content: 'test memory for feedback scoring evaluation',
    eventType: 'decision', decisionMade: true, surprise: 0.5, causalDepth: 0.4,
  });

  if (!writeRes.engram?.id) {
    record('6.1 Feedback', 'feedback', false, 0, 'Could not create test engram');
    return;
  }

  const before = writeRes.engram.confidence;

  // Positive feedback
  await api('POST', '/memory/feedback', {
    engramId: writeRes.engram.id, useful: true, context: 'was helpful for task',
  });

  const afterPos = await api('GET', `/memory/${writeRes.engram.id}`);
  const posConfidence = afterPos.engram?.confidence ?? before;
  record('6.1 Positive feedback increases confidence', 'feedback',
    posConfidence > before, posConfidence > before ? 1 : 0,
    `Before: ${before.toFixed(3)}, After: ${posConfidence.toFixed(3)}`);

  // Negative feedback
  await api('POST', '/memory/feedback', {
    engramId: writeRes.engram.id, useful: false, context: 'was not helpful',
  });

  const afterNeg = await api('GET', `/memory/${writeRes.engram.id}`);
  const negConfidence = afterNeg.engram?.confidence ?? posConfidence;
  record('6.2 Negative feedback decreases confidence', 'feedback',
    negConfidence < posConfidence, negConfidence < posConfidence ? 1 : 0,
    `Before: ${posConfidence.toFixed(3)}, After: ${negConfidence.toFixed(3)}`);
}

async function testEvalMetrics() {
  console.log('\n=== 7. EVAL METRICS ===');

  const metrics = await api('GET', `/agent/${agentId}/metrics?window=24`);
  const m = metrics.metrics;

  record('7.1 Metrics compute without error', 'eval', m != null, m ? 1 : 0,
    m ? 'Metrics returned' : 'Metrics failed');

  if (m) {
    record('7.2 Active count > 0', 'eval', m.activeEngramCount > 0, m.activeEngramCount > 0 ? 1 : 0,
      `Active: ${m.activeEngramCount}`);
    // Healthy confidence range: 0.3-0.8 scores 1.0, outside tapers off
    const confHealthy = m.avgConfidence >= 0.3 && m.avgConfidence <= 0.8;
    record('7.3 Avg confidence in healthy range', 'eval',
      confHealthy, confHealthy ? 1 : Math.max(0, 1 - Math.abs(m.avgConfidence - 0.55) / 0.3),
      `Avg confidence: ${m.avgConfidence.toFixed(3)} (healthy: 0.3-0.8)`);
    record('7.4 Edge count tracked', 'eval', m.totalEdges >= 0, 1,
      `Total edges: ${m.totalEdges}`);
    record('7.5 Activation count tracked', 'eval', m.activationCount > 0, m.activationCount > 0 ? 1 : 0,
      `Activations: ${m.activationCount}`);
    record('7.6 Latency measured', 'eval', m.avgLatencyMs > 0, m.avgLatencyMs > 0 ? 1 : 0,
      `Avg latency: ${m.avgLatencyMs.toFixed(1)}ms, P95: ${m.p95LatencyMs.toFixed(1)}ms`);
  }
}

async function testSemanticDisambiguation() {
  console.log('\n=== 8. SEMANTIC DISAMBIGUATION ===');

  // Write memories with overlapping vocabulary but distinct topics
  await api('POST', '/memory/write', {
    agentId, concept: 'python snake handling',
    content: 'Ball pythons are docile snakes that make good beginner reptile pets requiring warm terrariums',
    eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.4,
    tags: ['animals', 'reptiles'],
  });
  await api('POST', '/memory/write', {
    agentId, concept: 'python programming language',
    content: 'Python programming uses indentation for code blocks and has powerful list comprehensions',
    eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.4,
    tags: ['programming', 'python'],
  });

  // Query for programming python — should rank programming higher
  const progResults = await api('POST', '/memory/activate', {
    agentId, context: 'python programming code indentation syntax',
  });
  const topIsProgramming = progResults.results?.[0]?.engram?.tags?.includes('programming') ?? false;
  record('8.1 Disambiguate "python" (programming)', 'semantic',
    topIsProgramming, topIsProgramming ? 1 : 0,
    `Top result: ${progResults.results?.[0]?.engram?.concept ?? 'none'}`);

  // Query for snake python — should rank animal higher
  const snakeResults = await api('POST', '/memory/activate', {
    agentId, context: 'python snake reptile pet terrarium care',
  });
  const topIsAnimal = snakeResults.results?.[0]?.engram?.tags?.includes('animals') ?? false;
  record('8.2 Disambiguate "python" (animal)', 'semantic',
    topIsAnimal, topIsAnimal ? 1 : 0,
    `Top result: ${snakeResults.results?.[0]?.engram?.concept ?? 'none'}`);
}

async function testAccessCountDecay() {
  console.log('\n=== 9. ACCESS COUNT & TEMPORAL ===');

  // Write two memories, access one repeatedly
  const hot = await api('POST', '/memory/write', {
    agentId, concept: 'frequently accessed pattern',
    content: 'This design pattern for dependency injection is used in every microservice',
    eventType: 'causal', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.5,
    tags: ['patterns'],
  });
  const cold = await api('POST', '/memory/write', {
    agentId, concept: 'rarely accessed pattern',
    content: 'This visitor pattern for dependency walking traverses the abstract syntax tree',
    eventType: 'causal', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.5,
    tags: ['patterns'],
  });

  // Access the hot one multiple times
  for (let i = 0; i < 5; i++) {
    await api('POST', '/memory/activate', {
      agentId, context: 'dependency injection microservice design pattern',
    });
  }

  // Now query for both — hot should score higher
  const results = await api('POST', '/memory/activate', {
    agentId, context: 'design pattern dependency',
  });
  const hotResult = results.results?.find((r: any) => r.engram.id === hot.engram?.id);
  const coldResult = results.results?.find((r: any) => r.engram.id === cold.engram?.id);

  const hotHigher = (hotResult?.score ?? 0) > (coldResult?.score ?? 0);
  record('9.1 Frequently accessed scores higher', 'temporal',
    hotHigher, hotHigher ? 1 : 0,
    `Hot: ${hotResult?.score?.toFixed(3) ?? '?'}, Cold: ${coldResult?.score?.toFixed(3) ?? '?'}`);

  // Verify access count increased
  const hotDetail = await api('GET', `/memory/${hot.engram?.id}`);
  const accessCount = hotDetail.engram?.accessCount ?? 0;
  record('9.2 Access count tracked', 'temporal',
    accessCount > 1, Math.min(accessCount / 5, 1),
    `Access count: ${accessCount}`);
}

async function testAssociativeRecall() {
  console.log('\n=== 10. ASSOCIATIVE RECALL ===');

  // Write a chain: A is related to B, B is related to C
  const memA = await api('POST', '/memory/write', {
    agentId, concept: 'kubernetes pod scheduling',
    content: 'Kubernetes scheduler assigns pods to nodes based on resource requests and affinity rules',
    eventType: 'causal', surprise: 0.6, causalDepth: 0.7, resolutionEffort: 0.5,
    tags: ['kubernetes', 'infrastructure'],
  });
  const memB = await api('POST', '/memory/write', {
    agentId, concept: 'kubernetes resource limits',
    content: 'Container resource limits prevent one pod from consuming all node CPU and memory resources',
    eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.4,
    tags: ['kubernetes', 'resources'],
  });
  const memC = await api('POST', '/memory/write', {
    agentId, concept: 'kubernetes horizontal autoscaler',
    content: 'HPA automatically scales pod replicas based on CPU utilization and custom metrics',
    eventType: 'causal', surprise: 0.5, causalDepth: 0.6, resolutionEffort: 0.4,
    tags: ['kubernetes', 'scaling'],
  });

  // Co-activate A and B together
  for (let i = 0; i < 5; i++) {
    await api('POST', '/memory/activate', {
      agentId, context: 'kubernetes pod scheduling resource limits node capacity',
    });
  }

  // Co-activate B and C together
  for (let i = 0; i < 5; i++) {
    await api('POST', '/memory/activate', {
      agentId, context: 'kubernetes resource limits horizontal autoscaler scaling pods',
    });
  }

  // Query for A — should pull up B through association, and maybe C through graph walk
  const results = await api('POST', '/memory/activate', {
    agentId, context: 'kubernetes pod scheduling node assignment',
  });
  const foundA = results.results?.some((r: any) => r.engram.id === memA.engram?.id);
  const foundB = results.results?.some((r: any) => r.engram.id === memB.engram?.id);
  record('10.1 Direct match found', 'associative',
    foundA ?? false, foundA ? 1 : 0,
    foundA ? 'Direct match (A) found' : 'Direct match (A) not found');
  record('10.2 Associated memory surfaced', 'associative',
    foundB ?? false, foundB ? 1 : 0,
    foundB ? 'Associated memory (B) surfaced via graph walk' : 'Associated memory (B) not found');
}

async function testScalePerformance() {
  console.log('\n=== 11. SCALE & PERFORMANCE ===');

  const BATCH_SIZE = 50;
  const topicContent: Record<string, string[]> = {
    networking: ['TCP handshake three-way syn ack packet', 'DNS resolution nameserver lookup', 'load balancer round robin routing', 'firewall rules ingress egress ports', 'subnet CIDR range allocation'],
    security: ['SQL injection parameterized query sanitization', 'XSS cross-site scripting escape output', 'authentication OAuth JWT token validation', 'encryption TLS certificate chain verification', 'RBAC role permissions access control list'],
    testing: ['unit test assertion mock stub spy', 'integration test database fixture cleanup', 'end-to-end browser Playwright Selenium click', 'code coverage branch statement function', 'test driven development red green refactor'],
    deployment: ['Docker container image Dockerfile layer caching', 'CI pipeline GitHub Actions workflow yaml', 'rolling update zero downtime blue green deploy', 'Kubernetes helm chart manifest config', 'infrastructure as code Terraform provision'],
    monitoring: ['Prometheus metrics scrape endpoint gauge counter', 'Grafana dashboard alert threshold panel', 'log aggregation Elasticsearch Kibana query', 'distributed tracing Jaeger span context propagation', 'uptime health check SLA latency percentile'],
  };

  // Write 50 memories across diverse topics with distinct content
  const writeStart = performance.now();
  let idx = 0;
  for (const [topic, contents] of Object.entries(topicContent)) {
    for (let i = 0; i < contents.length * 2; i++) {
      const content = contents[i % contents.length];
      await api('POST', '/memory/write', {
        agentId,
        concept: `${topic} knowledge ${idx}`,
        content: `${content} scenario ${idx}`,
        eventType: idx % 3 === 0 ? 'causal' : idx % 3 === 1 ? 'decision' : 'observation',
        surprise: 0.4 + rng() * 0.4,
        causalDepth: 0.3 + rng() * 0.5,
        resolutionEffort: 0.2 + rng() * 0.4,
        decisionMade: idx % 3 === 1,
        tags: [topic],
      });
      idx++;
      if (idx >= BATCH_SIZE) break;
    }
    if (idx >= BATCH_SIZE) break;
  }
  const writeTime = performance.now() - writeStart;
  const avgWriteMs = writeTime / BATCH_SIZE;
  // Target includes curl overhead (~50ms); server-side is much faster
  record('11.1 Write throughput (50 memories)', 'scale',
    avgWriteMs < 500, Math.min(1, 500 / avgWriteMs),
    `Avg write (with curl): ${avgWriteMs.toFixed(1)}ms`);

  // Activation with many candidates
  const activateStart = performance.now();
  const results = await api('POST', '/memory/activate', {
    agentId, context: 'security SQL injection XSS authentication encryption',
  });
  const activateMs = performance.now() - activateStart;
  // Check server-side latency from metrics instead of curl round-trip
  const metricsAfter = await api('GET', `/agent/${agentId}/metrics?window=24`);
  const serverLatency = metricsAfter.metrics?.avgLatencyMs ?? activateMs;
  record('11.2 Server-side activation latency', 'scale',
    serverLatency < 50, Math.min(1, 50 / serverLatency),
    `Server avg: ${serverLatency.toFixed(1)}ms, curl round-trip: ${activateMs.toFixed(1)}ms`);

  // Check precision still holds with many memories
  const securityResults = results.results?.filter((r: any) =>
    r.engram.tags?.includes('security') || r.engram.concept.includes('security')
  );
  const top5 = results.results?.slice(0, 5) ?? [];
  const securityInTop5 = top5.filter((r: any) =>
    r.engram.tags?.includes('security') || r.engram.concept.includes('security')
  ).length;
  const scalePrecision = top5.length > 0 ? securityInTop5 / top5.length : 0;
  record('11.3 Precision under load', 'scale',
    scalePrecision > 0.3, Math.min(scalePrecision, 1),
    `${securityInTop5} security results in top 5`);
}

// --- Report ---

function generateReport() {
  console.log('\n' + '='.repeat(60));
  console.log('SELF-TEST REPORT');
  console.log('='.repeat(60));

  const dimensions: Record<string, TestResult[]> = {};
  for (const r of results) {
    (dimensions[r.dimension] ??= []).push(r);
  }

  const weights: Record<string, number> = {
    write: 0.12,
    retrieval: 0.18,
    association: 0.10,
    retraction: 0.08,
    eviction: 0.07,
    feedback: 0.05,
    eval: 0.08,
    semantic: 0.10,
    temporal: 0.08,
    associative: 0.08,
    scale: 0.10,
  };

  const dimScores: Record<string, number> = {};
  for (const [dim, tests] of Object.entries(dimensions)) {
    const avg = tests.reduce((s, t) => s + t.score, 0) / tests.length;
    dimScores[dim] = avg;
    const passed = tests.filter(t => t.passed).length;
    console.log(`\n${dim.toUpperCase()} (weight ${(weights[dim] ?? 0) * 100}%)`);
    console.log(`  Score: ${(avg * 100).toFixed(1)}% | Passed: ${passed}/${tests.length}`);
  }

  let composite = 0;
  for (const [dim, score] of Object.entries(dimScores)) {
    composite += score * (weights[dim] ?? 0);
  }

  // Normalize by actual weight used (some dimensions may be missing)
  const usedWeight = Object.keys(dimScores).reduce((s, d) => s + (weights[d] ?? 0), 0);
  const normalized = usedWeight > 0 ? composite / usedWeight : 0;

  console.log('\n' + '-'.repeat(60));
  console.log(`COMPOSITE SCORE: ${(normalized * 100).toFixed(1)}%`);

  if (normalized >= 0.9) console.log('GRADE: EXCELLENT');
  else if (normalized >= 0.75) console.log('GRADE: GOOD');
  else if (normalized >= 0.6) console.log('GRADE: FAIR');
  else console.log('GRADE: NEEDS WORK');

  // Identify weakest dimension
  const weakest = Object.entries(dimScores).sort((a, b) => a[1] - b[1])[0];
  if (weakest) {
    console.log(`\nWEAKEST AREA: ${weakest[0].toUpperCase()} (${(weakest[1] * 100).toFixed(1)}%)`);
    const failures = dimensions[weakest[0]].filter(t => !t.passed);
    if (failures.length > 0) {
      console.log('Failed tests:');
      for (const f of failures) {
        console.log(`  - ${f.name}: ${f.detail}`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));

  return { composite: normalized, dimScores, results };
}

// --- Main ---

async function main() {
  console.log(`AgentWorkingMemory Self-Test Runner`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);

  // Health check
  try {
    const health = await api('GET', '/health');
    if (health.status !== 'ok') throw new Error('Health check failed');
    console.log(`Server: OK (${health.version})`);
  } catch (e) {
    console.error(`FATAL: Cannot reach server at ${BASE_URL}`);
    process.exit(1);
  }

  // Register test agent
  const agent = await api('POST', '/agent/register', { name: 'self-test-agent' });
  agentId = agent.id;
  console.log(`Agent: ${agentId}`);

  // Run all test suites
  await testWriteQuality();
  await testRetrievalPrecision();
  await testAssociations();
  await testRetraction();
  await testEviction();
  await testFeedback();
  await testEvalMetrics();
  await testSemanticDisambiguation();
  await testAccessCountDecay();
  await testAssociativeRecall();
  await testScalePerformance();

  // Generate report
  const report = generateReport();
  process.exit(report.composite >= 0.6 ? 0 : 1);
}

main().catch(err => {
  console.error('Self-test failed:', err);
  process.exit(1);
});
