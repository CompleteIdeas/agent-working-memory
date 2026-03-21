/**
 * A/B Test Runner — compares AWM-backed recall vs raw text search.
 *
 * Phase 1: Feed events to both systems (simulates an hour of project work)
 * Phase 2: Quiz both systems on specific facts from the events
 * Phase 3: Compare results with hard numbers
 *
 * The AWM path uses the full activation pipeline (BM25, vector, reranker, graph walk).
 * The baseline path uses simple keyword search over raw event text.
 *
 * Run: npx tsx tests/ab-test/runner.ts [baseUrl]
 * Requires a live AWM server (npx tsx src/index.ts).
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEvents, generateQuiz, type ProjectEvent, type QuizQuestion } from './events.js';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const RESULTS_FILE = join(import.meta.dirname, 'results.md');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TMP_DIR = join(tmpdir(), 'awm-ab-test');
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
      if (attempt < 2) { await sleep(2000); continue; }
      return { error: err.message };
    }
  }
  return { error: 'max retries' };
}

// --- Baseline: Simple keyword search ---

class BaselineMemory {
  private events: ProjectEvent[] = [];

  store(event: ProjectEvent) {
    this.events.push(event);
  }

  search(query: string, limit: number = 10): { event: ProjectEvent; score: number }[] {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const results: { event: ProjectEvent; score: number }[] = [];

    for (const event of this.events) {
      const text = event.content.toLowerCase();
      let matchCount = 0;
      for (const word of queryWords) {
        if (text.includes(word)) matchCount++;
      }
      const score = queryWords.length > 0 ? matchCount / queryWords.length : 0;
      if (score > 0) {
        results.push({ event, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// --- Scoring ---

function scoreAnswer(
  question: QuizQuestion,
  retrievedTexts: string[],
): { found: boolean; rank: number; isNoise: boolean } {
  if (question.answer === '__NOISE__') {
    // Noise questions: success = NOT finding specific details
    // If the system returns results for "what restaurant", that's bad
    const hasDetail = retrievedTexts.some(t =>
      t.toLowerCase().includes('thai') || t.toLowerCase().includes('podcast')
    );
    return { found: !hasDetail, rank: 0, isNoise: true };
  }

  // For real questions: check if any returned text contains answer keywords
  const answerWords = question.answer.toLowerCase()
    .split(/[\s,.()/]+/)
    .filter(w => w.length > 3 && !['with', 'from', 'that', 'this', 'uses', 'only', 'never'].includes(w));

  for (let i = 0; i < retrievedTexts.length; i++) {
    const text = retrievedTexts[i].toLowerCase();
    const matched = answerWords.filter(w => text.includes(w)).length;
    const matchRatio = answerWords.length > 0 ? matched / answerWords.length : 0;

    if (matchRatio >= 0.4) { // At least 40% of answer keywords found
      return { found: true, rank: i + 1, isNoise: false };
    }
  }

  return { found: false, rank: -1, isNoise: false };
}

// --- Live Display ---

function printHeader(text: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(text);
  console.log('='.repeat(60));
}

function printLiveResult(
  qNum: number,
  total: number,
  question: string,
  awmResult: { found: boolean; rank: number; isNoise: boolean },
  baseResult: { found: boolean; rank: number; isNoise: boolean },
  awmTimeMs: number,
  baseTimeMs: number,
) {
  const awmStatus = awmResult.found ? 'FOUND' : 'MISS';
  const baseStatus = baseResult.found ? 'FOUND' : 'MISS';
  const awmIcon = awmResult.found ? '+' : '-';
  const baseIcon = baseResult.found ? '+' : '-';

  console.log(`  [${qNum}/${total}] ${question.slice(0, 55)}...`);
  console.log(`    AWM:  [${awmIcon}] ${awmStatus}${awmResult.rank > 0 ? ` (rank ${awmResult.rank})` : ''} ${awmTimeMs}ms`);
  console.log(`    BASE: [${baseIcon}] ${baseStatus}${baseResult.rank > 0 ? ` (rank ${baseResult.rank})` : ''} ${baseTimeMs}ms`);
}

// --- Main ---

async function main() {
  console.log('AgentWorkingMemory A/B Test');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);

  // Health check
  const health = await api('GET', '/health');
  if (health.status !== 'ok') {
    console.error(`FATAL: Server not reachable at ${BASE_URL}`);
    process.exit(1);
  }
  console.log(`Server: OK (${health.version})\n`);

  // Generate events and quiz
  const events = generateEvents(100);
  const quiz = generateQuiz(events);
  const importantEvents = events.filter(e => e.importance !== 'low');
  const noiseEvents = events.filter(e => e.importance === 'low');

  console.log(`Events: ${events.length} total (${importantEvents.length} important, ${noiseEvents.length} noise)`);
  console.log(`Quiz: ${quiz.length} questions`);

  // Register AWM agent
  const agent = await api('POST', '/agent/register', { name: 'ab-test-awm' });
  const agentId = agent.id;
  console.log(`AWM Agent: ${agentId}`);

  // Initialize baseline
  const baseline = new BaselineMemory();

  // =========================================================
  // PHASE 1: Feed events to both systems
  // =========================================================
  printHeader('PHASE 1: FEEDING EVENTS');

  let awmActive = 0;
  let awmStaging = 0;
  let awmDiscard = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Feed to baseline (stores everything)
    baseline.store(event);

    // Feed to AWM (with salience signals)
    const isImportant = event.importance !== 'low';
    const surprise = event.importance === 'high' ? 0.8 : event.importance === 'medium' ? 0.5 : 0.2;
    const causalDepth = event.category === 'decision' ? 0.8 : event.category === 'bug' ? 0.7 : event.category === 'fact' ? 0.6 : 0.2;

    const res = await api('POST', '/memory/write', {
      agentId,
      concept: `${event.category}: ${event.topic}`,
      content: event.content,
      tags: [event.category, event.topic, event.importance],
      eventType: event.category === 'decision' ? 'decision' : event.category === 'bug' ? 'friction' : isImportant ? 'causal' : 'observation',
      surprise,
      causalDepth,
      resolutionEffort: 0.3,
      decisionMade: event.category === 'decision',
    });

    if (res.disposition === 'active') awmActive++;
    else if (res.disposition === 'staging') awmStaging++;
    else awmDiscard++;

    // Progress every 20 events
    if ((i + 1) % 20 === 0) {
      console.log(`  ${i + 1}/${events.length} fed | AWM: ${awmActive} active, ${awmStaging} staging, ${awmDiscard} discard | Baseline: ${i + 1} stored`);
    }
  }

  console.log(`\n  Final: AWM stored ${awmActive} active + ${awmStaging} staging (discarded ${awmDiscard}) | Baseline stored all ${events.length}`);

  // Wait for embeddings
  console.log('  Waiting for embeddings (10s)...');
  await sleep(10000);

  // Warmup reranker
  console.log('  Warming up reranker...');
  await api('POST', '/memory/activate', { agentId, context: 'test warmup', limit: 3, useReranker: true });

  // =========================================================
  // PHASE 2: QUIZ
  // =========================================================
  printHeader('PHASE 2: QUIZ — LIVE RESULTS');

  let awmCorrect = 0;
  let baseCorrect = 0;
  let awmTotalTime = 0;
  let baseTotalTime = 0;
  let awmNoiseCorrect = 0;
  let baseNoiseCorrect = 0;
  let noiseTotal = 0;
  let factTotal = 0;

  const detailedResults: {
    question: string;
    difficulty: string;
    topic: string;
    awm: { found: boolean; rank: number; timeMs: number };
    base: { found: boolean; rank: number; timeMs: number };
  }[] = [];

  for (let i = 0; i < quiz.length; i++) {
    const q = quiz[i];
    const isNoise = q.answer === '__NOISE__';
    if (isNoise) noiseTotal++;
    else factTotal++;

    // AWM query
    const awmStart = performance.now();
    const awmRes = await api('POST', '/memory/activate', {
      agentId,
      context: q.question,
      limit: 5,
      includeStaging: true,
      useReranker: true,
      useExpansion: true,
    });
    const awmTimeMs = Math.round(performance.now() - awmStart);
    const awmTexts = (awmRes.results ?? []).map((r: any) => r.engram?.content ?? '');
    const awmScore = scoreAnswer(q, awmTexts);

    // Baseline query
    const baseStart = performance.now();
    const baseResults = baseline.search(q.question, 5);
    const baseTimeMs = Math.round(performance.now() - baseStart);
    const baseTexts = baseResults.map(r => r.event.content);
    const baseScore = scoreAnswer(q, baseTexts);

    if (awmScore.found) {
      if (isNoise) awmNoiseCorrect++;
      else awmCorrect++;
    }
    if (baseScore.found) {
      if (isNoise) baseNoiseCorrect++;
      else baseCorrect++;
    }

    awmTotalTime += awmTimeMs;
    baseTotalTime += baseTimeMs;

    // Live display
    printLiveResult(i + 1, quiz.length, q.question, awmScore, baseScore, awmTimeMs, baseTimeMs);

    detailedResults.push({
      question: q.question,
      difficulty: q.difficulty,
      topic: q.topic,
      awm: { found: awmScore.found, rank: awmScore.rank, timeMs: awmTimeMs },
      base: { found: baseScore.found, rank: baseScore.rank, timeMs: baseTimeMs },
    });
  }

  // =========================================================
  // PHASE 3: REPORT
  // =========================================================
  printHeader('A/B TEST RESULTS');

  const awmFactAccuracy = factTotal > 0 ? (awmCorrect / factTotal * 100) : 0;
  const baseFactAccuracy = factTotal > 0 ? (baseCorrect / factTotal * 100) : 0;
  const awmNoiseAccuracy = noiseTotal > 0 ? (awmNoiseCorrect / noiseTotal * 100) : 0;
  const baseNoiseAccuracy = noiseTotal > 0 ? (baseNoiseCorrect / noiseTotal * 100) : 0;
  const awmAvgTime = quiz.length > 0 ? Math.round(awmTotalTime / quiz.length) : 0;
  const baseAvgTime = quiz.length > 0 ? Math.round(baseTotalTime / quiz.length) : 0;

  // Overall score: 70% fact accuracy + 15% noise rejection + 15% efficiency
  const awmEfficiency = awmAvgTime < 5000 ? 1.0 : awmAvgTime < 10000 ? 0.5 : 0.2;
  const baseEfficiency = baseAvgTime < 5000 ? 1.0 : baseAvgTime < 10000 ? 0.5 : 0.2;
  const awmOverall = 0.70 * awmFactAccuracy + 0.15 * awmNoiseAccuracy + 0.15 * awmEfficiency * 100;
  const baseOverall = 0.70 * baseFactAccuracy + 0.15 * baseNoiseAccuracy + 0.15 * baseEfficiency * 100;

  console.log(`
                     AWM Agent       Baseline
  ─────────────────────────────────────────────
  Fact Recall:       ${awmCorrect}/${factTotal} (${awmFactAccuracy.toFixed(1)}%)     ${baseCorrect}/${factTotal} (${baseFactAccuracy.toFixed(1)}%)
  Noise Rejection:   ${awmNoiseCorrect}/${noiseTotal} (${awmNoiseAccuracy.toFixed(1)}%)     ${baseNoiseCorrect}/${noiseTotal} (${baseNoiseAccuracy.toFixed(1)}%)
  Avg Query Time:    ${awmAvgTime}ms            ${baseAvgTime}ms
  Memories Stored:   ${awmActive} active        ${events.length} (all)
  Signal/Noise:      ${(awmActive / events.length * 100).toFixed(0)}% kept         100% kept
  ─────────────────────────────────────────────
  OVERALL SCORE:     ${awmOverall.toFixed(1)}%            ${baseOverall.toFixed(1)}%
`);

  const winner = awmOverall > baseOverall ? 'AWM' : awmOverall < baseOverall ? 'Baseline' : 'Tie';
  const margin = Math.abs(awmOverall - baseOverall);
  console.log(`  WINNER: ${winner} (by ${margin.toFixed(1)} points)`);
  console.log(`  AWM filtered out ${((1 - awmActive / events.length) * 100).toFixed(0)}% of noise at write time\n`);

  // Difficulty breakdown
  console.log('  BY DIFFICULTY:');
  for (const diff of ['easy', 'medium', 'hard']) {
    const diffResults = detailedResults.filter(r => r.difficulty === diff);
    if (diffResults.length === 0) continue;
    const awmHits = diffResults.filter(r => r.awm.found).length;
    const baseHits = diffResults.filter(r => r.base.found).length;
    console.log(`    ${diff}: AWM ${awmHits}/${diffResults.length} | Baseline ${baseHits}/${diffResults.length}`);
  }

  // Topic breakdown
  console.log('\n  BY TOPIC:');
  const topics = [...new Set(detailedResults.map(r => r.topic))].filter(t => t !== 'noise');
  for (const topic of topics) {
    const topicResults = detailedResults.filter(r => r.topic === topic);
    const awmHits = topicResults.filter(r => r.awm.found).length;
    const baseHits = topicResults.filter(r => r.base.found).length;
    console.log(`    ${topic}: AWM ${awmHits}/${topicResults.length} | Baseline ${baseHits}/${topicResults.length}`);
  }

  // Write detailed results to file
  const report = `# A/B Test Results — ${new Date().toISOString()}

## Summary
| Metric | AWM Agent | Baseline |
|--------|-----------|----------|
| Fact Recall | ${awmCorrect}/${factTotal} (${awmFactAccuracy.toFixed(1)}%) | ${baseCorrect}/${factTotal} (${baseFactAccuracy.toFixed(1)}%) |
| Noise Rejection | ${awmNoiseCorrect}/${noiseTotal} (${awmNoiseAccuracy.toFixed(1)}%) | ${baseNoiseCorrect}/${noiseTotal} (${baseNoiseAccuracy.toFixed(1)}%) |
| Avg Query Time | ${awmAvgTime}ms | ${baseAvgTime}ms |
| Memories Stored | ${awmActive} active | ${events.length} (all) |
| **Overall Score** | **${awmOverall.toFixed(1)}%** | **${baseOverall.toFixed(1)}%** |
| **Winner** | **${winner}** (by ${margin.toFixed(1)}pp) | |

## Event Feed
- Total events: ${events.length}
- Important: ${importantEvents.length} (${(importantEvents.length / events.length * 100).toFixed(0)}%)
- Noise: ${noiseEvents.length} (${(noiseEvents.length / events.length * 100).toFixed(0)}%)
- AWM kept: ${awmActive} active, ${awmStaging} staging, discarded ${awmDiscard}

## Detailed Results
| # | Question | Difficulty | AWM | Baseline |
|---|----------|-----------|-----|----------|
${detailedResults.map((r, i) =>
  `| ${i + 1} | ${r.question.slice(0, 50)}... | ${r.difficulty} | ${r.awm.found ? `rank ${r.awm.rank}` : 'MISS'} (${r.awm.timeMs}ms) | ${r.base.found ? `rank ${r.base.rank}` : 'MISS'} (${r.base.timeMs}ms) |`
).join('\n')}

## Difficulty Breakdown
${['easy', 'medium', 'hard'].map(diff => {
  const dr = detailedResults.filter(r => r.difficulty === diff);
  if (dr.length === 0) return '';
  return `- **${diff}**: AWM ${dr.filter(r => r.awm.found).length}/${dr.length} | Baseline ${dr.filter(r => r.base.found).length}/${dr.length}`;
}).filter(Boolean).join('\n')}
`;

  writeFileSync(RESULTS_FILE, report);
  console.log(`\n  Detailed results written to: ${RESULTS_FILE}`);

  process.exit(winner === 'AWM' ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
