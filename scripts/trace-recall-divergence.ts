/**
 * Side-by-side activation trace — find where PGlite diverges from SQLite
 * on the Auth-JWT query that test:tokens fails.
 *
 * Seeds the FULL 44-turn test:tokens corpus into both backends via the
 * actual write-pipeline (so dispositions match production). Runs the
 * Auth-JWT recall through ActivationEngine on each. Dumps per-channel
 * phaseScores for the top-10 results so we can see which signal produces
 * the divergence.
 *
 * Run: npx tsx scripts/trace-recall-divergence.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { PGliteEngramStore } from '../src/storage/pglite.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { ConnectionEngine } from '../src/engine/connections.js';
import { performWrite } from '../src/core/write-pipeline.js';

const AGENT = 'recall-trace';

// Import the REAL test:tokens corpus instead of fabricating one
import { readFileSync } from 'node:fs';
const runnerSrc = readFileSync(join(import.meta.dirname, '..', 'tests', 'token-savings', 'runner.ts'), 'utf-8');
// Extract the CONVERSATION_HISTORY array literal
const match = runnerSrc.match(/const CONVERSATION_HISTORY: ConversationTurn\[\] = \[([\s\S]+?)\n\];/);
if (!match) throw new Error('Could not find CONVERSATION_HISTORY in runner.ts');
// eval is fine here — it's our own controlled source
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const TURNS: Array<{ role: string; content: string; task: string }> = new Function(`return [${match[1]}\n];`)();
console.log('Loaded ' + TURNS.length + ' turns from test:tokens corpus');

const QUERY = 'What JWT algorithm and token strategy did we decide on for authentication?';
const EXPECTED_KEYWORDS = ['HS256', 'refresh', 'access', '15 min', '7 day'];
// Match any turn containing >=2 of the expected keywords
const isTargetTurn = (content: string) => {
  const lc = content.toLowerCase();
  return EXPECTED_KEYWORDS.filter(k => lc.includes(k.toLowerCase())).length >= 2;
};

async function seedAndQuery(label: string, factory: () => Promise<{ store: any; close: () => Promise<void> | void }>) {
  console.log('\n======================================================================');
  console.log('Backend: ' + label);
  console.log('======================================================================');

  const { store, close } = await factory();
  const activation = new ActivationEngine(store);
  const connection = new ConnectionEngine(store, activation);

  // Seed full corpus through write pipeline
  const dispositions = { active: 0, staging: 0, discard: 0, reinforce: 0 };
  const targetEngrams: Array<{ id: string; concept: string; content: string; disposition: string }> = [];
  for (const t of TURNS) {
    // Match test:tokens runner shape EXACTLY (tests/token-savings/runner.ts:227-242):
    //   concept = "${task} ${role} conversation"  ← task+role+'conversation'
    //   tags = [task, role]                       ← bare task and role
    //   eventType, surprise, causalDepth driven by content heuristics
    const hasFact = t.content.length > 80;
    const hasDecision = /decided|chose|use|implement|create|add|set up|switch|replace/i.test(t.content);
    const hasNumber = /\d+/.test(t.content);

    const concept = `${t.task} ${t.role} conversation`;
    const res = await performWrite(
      { store, connectionEngine: connection },
      {
        agentId: AGENT,
        concept,
        content: t.content,
        tags: [t.task, t.role],
        eventType: hasDecision ? 'decision' : hasFact ? 'causal' : 'observation',
        surprise: hasDecision ? 0.6 : hasNumber ? 0.5 : 0.3,
        causalDepth: hasDecision ? 0.7 : hasFact ? 0.6 : 0.3,
        resolutionEffort: hasFact ? 0.5 : 0.3,
        decisionMade: hasDecision,
      },
    );
    const disp = res.salience?.disposition ?? 'reinforce';
    dispositions[disp as keyof typeof dispositions] = (dispositions[disp as keyof typeof dispositions] ?? 0) + 1;
    if (isTargetTurn(t.content)) {
      targetEngrams.push({ id: res.engram.id, concept, content: t.content, disposition: disp });
    }
  }
  console.log('Seeding: ' + JSON.stringify(dispositions));
  console.log('Target engrams (containing 2+ expected keywords):');
  for (const t of targetEngrams) {
    console.log('  id=' + t.id.slice(0,8) + ' dispo=' + t.disposition + ' :: ' + t.content.slice(0, 80));
  }

  // Settle any async work
  await new Promise(r => setTimeout(r, 1500));

  // Run the recall — matches test:tokens HTTP shape (internal default = false,
  // limit 5 not 10). With internal:false, side effects fire (access count++,
  // Hebbian co-activation). For the FIRST query on a clean agent this
  // shouldn't matter, but we want apples-to-apples with test:tokens.
  console.log('\nQuery: ' + QUERY);
  const results = await activation.activate({
    agentId: AGENT,
    context: QUERY,
    limit: 5,
    includeStaging: true,
    useReranker: true,
    useExpansion: true,
  });

  console.log('Returned ' + results.length + ' results, confidence=' + (results[0]?.confidence?.toFixed(3) ?? 'n/a'));
  console.log('\nrank | score   | stage    | txt    | vec    | decay  | hebb   | graph  | rerank | kw  | concept');
  console.log('-----+---------+----------+--------+--------+--------+--------+--------+--------+-----+------------------------');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ps = r.phaseScores;
    const stage = r.engram.stage.padEnd(8);
    const kw = EXPECTED_KEYWORDS.filter(k => r.engram.content.toLowerCase().includes(k.toLowerCase())).length;
    const isTarget = targetEngrams.some(t => t.id === r.engram.id) ? ' ★' : '  ';
    console.log(
      String(i + 1).padStart(3) + isTarget + ' | ' +
      r.score.toFixed(3) + '   | ' + stage + ' | ' +
      ps.textMatch.toFixed(2) + '   | ' +
      ps.vectorMatch.toFixed(2) + '   | ' +
      ps.decayScore.toFixed(2) + '   | ' +
      ps.hebbianBoost.toFixed(2) + '   | ' +
      ps.graphBoost.toFixed(2) + '   | ' +
      ps.rerankerScore.toFixed(2) + '   | ' +
      kw + '/5 | ' +
      r.engram.concept.slice(0, 50),
    );
  }

  // Which target engrams made the top-5 + top-10?
  const targetIds = new Set(targetEngrams.map(t => t.id));
  const topRanksOfTargets = results
    .map((r, i) => targetIds.has(r.engram.id) ? i + 1 : -1)
    .filter(x => x > 0);
  console.log('\nTarget engrams in top-10 ranks: [' + topRanksOfTargets.join(', ') + ']');

  // Joined top-5 keyword coverage (mirrors test:tokens accuracy calc)
  const top5Text = results.slice(0, 5).map(r => r.engram.content).join('\n').toLowerCase();
  const kwFound = EXPECTED_KEYWORDS.filter(k => top5Text.includes(k.toLowerCase())).length;
  console.log('TOP-5 KEYWORD COVERAGE: ' + kwFound + '/' + EXPECTED_KEYWORDS.length + ' (matches test:tokens "accuracy" calc)');

  await close();
}

async function main() {
  await seedAndQuery('SQLite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-recall-sq-'));
    const store = new EngramStore(join(tmp, 'test.db'));
    return {
      store, close: () => {
        store.close();
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      },
    };
  });

  await seedAndQuery('PGlite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-recall-pg-'));
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
