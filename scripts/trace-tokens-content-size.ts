/**
 * Per-challenge content-size diagnostic for test:tokens.
 *
 * Seeds the full test:tokens corpus through write-pipeline (matching the
 * actual runner shape) on each backend, then runs every challenge's recall
 * query and reports for each result: rank, score, engram-content length,
 * stage. Total content length per query is the AWM token-volume.
 *
 * Goal: characterize where PGlite's extra tokens come from — more results
 * passing the floor, larger per-engram content, or both.
 *
 * Run: npx tsx scripts/trace-tokens-content-size.ts
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { PGliteEngramStore } from '../src/storage/pglite.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { ConnectionEngine } from '../src/engine/connections.js';
import { performWrite } from '../src/core/write-pipeline.js';

const AGENT = 'tokens-size-trace';

// Mirror test:tokens runner exactly
const runnerSrc = readFileSync(join(import.meta.dirname, '..', 'tests', 'token-savings', 'runner.ts'), 'utf-8');
const hMatch = runnerSrc.match(/const CONVERSATION_HISTORY: ConversationTurn\[\] = \[([\s\S]+?)\n\];/);
if (!hMatch) throw new Error('CONVERSATION_HISTORY not found');
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const TURNS: Array<{ role: string; content: string; task: string }> = new Function(`return [${hMatch[1]}\n];`)();

// Extract the RECALL_CHALLENGES array (queries + expected keywords)
const cMatch = runnerSrc.match(/const RECALL_CHALLENGES[^=]*=\s*\[([\s\S]+?)\n\];/);
if (!cMatch) throw new Error('RECALL_CHALLENGES not found');
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const CHALLENGES: Array<{ name: string; query: string; expectedKeywords: string[] }> = new Function(`return [${cMatch[1]}\n];`)();

async function seed(label: string, factory: () => Promise<{ store: any; close: () => Promise<void> | void }>) {
  console.log('\n======================================================================');
  console.log('Backend: ' + label);
  console.log('======================================================================');

  const { store, close } = await factory();
  const activation = new ActivationEngine(store);
  const connection = new ConnectionEngine(store, activation);

  for (const t of TURNS) {
    const hasFact = t.content.length > 80;
    const hasDecision = /decided|chose|use|implement|create|add|set up|switch|replace/i.test(t.content);
    const hasNumber = /\d+/.test(t.content);
    await performWrite(
      { store, connectionEngine: connection },
      {
        agentId: AGENT,
        concept: `${t.task} ${t.role} conversation`,
        content: t.content,
        tags: [t.task, t.role],
        eventType: hasDecision ? 'decision' : hasFact ? 'causal' : 'observation',
        surprise: hasDecision ? 0.6 : hasNumber ? 0.5 : 0.3,
        causalDepth: hasDecision ? 0.7 : hasFact ? 0.6 : 0.3,
        resolutionEffort: hasFact ? 0.5 : 0.3,
        decisionMade: hasDecision,
      },
    );
  }
  await new Promise(r => setTimeout(r, 1500));

  // Diagnostic: how many distinct engrams exist after 44 writes?
  // Pull a generous slice via BM25 with an empty/wildcard query
  const allCount = await store.getActiveCount(AGENT);
  console.log(`Engrams (active stage) after 44 writes: ${allCount}`);

  let totalAwmChars = 0;
  console.log('\nchallenge        | n | totC | s1   s2   s3   s4   s5  | l1   l2   l3   l4   l5');
  console.log('-----------------+---+------+--------------------------+-----------------------');
  for (const ch of CHALLENGES) {
    const results = await activation.activate({
      agentId: AGENT,
      context: ch.query,
      limit: 5,
      includeStaging: true,
    });
    const lengths = results.map(r => r.engram.content.length);
    const scores = results.map(r => r.score);
    const totalChars = lengths.reduce((a, b) => a + b, 0);
    totalAwmChars += totalChars;

    const padScores = (arr: number[]) => Array.from({ length: 5 }, (_, i) => (arr[i] !== undefined ? arr[i].toFixed(2) : '----').padStart(4)).join(' ');
    const padLens = (arr: number[]) => Array.from({ length: 5 }, (_, i) => (arr[i] !== undefined ? String(arr[i]) : '---').padStart(4)).join(' ');
    console.log(
      ch.name.padEnd(16) + ' | ' +
      String(results.length).padStart(1) + ' | ' +
      String(totalChars).padStart(4) + ' | ' +
      padScores(scores) + ' | ' +
      padLens(lengths)
    );
  }
  console.log('\nTotal AWM content chars across 10 challenges: ' + totalAwmChars);
  console.log('Avg AWM content chars per challenge: ' + Math.round(totalAwmChars / CHALLENGES.length));
  console.log('Avg tokens (chars/4): ' + Math.round(totalAwmChars / CHALLENGES.length / 4));

  await close();
}

async function main() {
  await seed('SQLite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-sz-sq-'));
    const store = new EngramStore(join(tmp, 'test.db'));
    return { store, close: () => { store.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} } };
  });

  await seed('PGlite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-sz-pg-'));
    const store = new PGliteEngramStore(join(tmp, 'pg'));
    await store.ready();
    return { store, close: async () => { await store.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} } };
  });
}

main().catch(err => { console.error(err); process.exit(1); });
