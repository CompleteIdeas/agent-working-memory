/**
 * Single-shot helper for sweep-pglite-m.ts.
 * Seeds the test:tokens corpus into PGlite and prints COUNT=<n> MEANLEN=<n>.
 * AWM_PGLITE_BM25_M is read from env at PGlite module load.
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGliteEngramStore } from '../src/storage/pglite.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { ConnectionEngine } from '../src/engine/connections.js';
import { performWrite } from '../src/core/write-pipeline.js';

const AGENT = 'sweep';

const runnerSrc = readFileSync(join(import.meta.dirname, '..', 'tests', 'token-savings', 'runner.ts'), 'utf-8');
const hMatch = runnerSrc.match(/const CONVERSATION_HISTORY: ConversationTurn\[\] = \[([\s\S]+?)\n\];/);
if (!hMatch) throw new Error('CONVERSATION_HISTORY not found');
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const TURNS: Array<{ role: string; content: string; task: string }> = new Function(`return [${hMatch[1]}\n];`)();

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'awm-sw-'));
  const store = new PGliteEngramStore(join(tmp, 'pg'));
  await store.ready();
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
  await new Promise(r => setTimeout(r, 500));

  const count = await store.getActiveCount(AGENT);
  // Sum content lengths via BM25 walk (since no listAll method exists)
  const hits = await store.searchBM25WithRank(AGENT, 'a e i o u t s n r', 100);
  const lens = hits.map((h: any) => h.engram.content.length);
  const sum = lens.reduce((a: number, b: number) => a + b, 0);
  const mean = lens.length > 0 ? Math.round(sum / lens.length) : 0;
  console.log(`COUNT=${count} MEANLEN=${mean} HITS=${lens.length}`);

  await store.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

main().catch(err => { console.error(err); process.exit(1); });
