/**
 * Mini Multi-Hop Test — fast proof-of-concept for entity bridging.
 *
 * Seeds 20 conversation turns with known entities, then tests 5 multi-hop
 * questions that require connecting facts across turns via shared entities.
 *
 * Run: npx tsx tests/mini-multihop/runner.ts
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const TMP_DIR = join(tmpdir(), 'awm-mini-mh');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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

// --- Test Data: 20 conversation turns with clear entity relationships ---

interface Turn {
  speaker: string;
  text: string;
  entities: string[]; // for scoring
  id: string;
}

const TURNS: Turn[] = [
  // Session 1: Sarah and Mike discuss their lives
  { id: 'T1', speaker: 'Sarah', text: 'I just started my new job at Memorial Hospital as a nurse last month.', entities: ['Sarah', 'Memorial Hospital'] },
  { id: 'T2', speaker: 'Mike', text: 'That\'s great Sarah! I\'ve been working at Google as a software engineer for three years now.', entities: ['Mike', 'Google'] },
  { id: 'T3', speaker: 'Sarah', text: 'On weekends I love painting watercolors. It helps me relax after long shifts.', entities: ['Sarah'] },
  { id: 'T4', speaker: 'Mike', text: 'I spend my free time rock climbing at the local gym. Just got into bouldering.', entities: ['Mike'] },
  { id: 'T5', speaker: 'Sarah', text: 'My cat Whiskers is the best company when I\'m painting at home.', entities: ['Sarah', 'Whiskers'] },
  { id: 'T6', speaker: 'Mike', text: 'I adopted a golden retriever named Buddy from the shelter last spring.', entities: ['Mike', 'Buddy'] },

  // Session 2: Emma and David
  { id: 'T7', speaker: 'Emma', text: 'I\'m teaching biology at Lincoln High School this year. The students are wonderful.', entities: ['Emma', 'Lincoln High'] },
  { id: 'T8', speaker: 'David', text: 'I run my own bakery called Sweet Dreams on Oak Street. Business has been good.', entities: ['David', 'Sweet Dreams'] },
  { id: 'T9', speaker: 'Emma', text: 'I play violin in the community orchestra every Thursday evening.', entities: ['Emma'] },
  { id: 'T10', speaker: 'David', text: 'My hobby is marathon running. I completed the Boston Marathon in 3 hours 45 minutes.', entities: ['David', 'Boston Marathon'] },
  { id: 'T11', speaker: 'Emma', text: 'I live in the Riverside apartment complex on Elm Street with my two cats.', entities: ['Emma', 'Riverside'] },
  { id: 'T12', speaker: 'David', text: 'My wife Lisa and I bought a house in the Oakwood neighborhood last year.', entities: ['David', 'Lisa', 'Oakwood'] },

  // Session 3: More context
  { id: 'T13', speaker: 'Sarah', text: 'I graduated from Stanford with a nursing degree in 2022.', entities: ['Sarah', 'Stanford'] },
  { id: 'T14', speaker: 'Mike', text: 'I went to MIT for computer science. The workload was intense but worth it.', entities: ['Mike', 'MIT'] },
  { id: 'T15', speaker: 'Emma', text: 'My sister Rachel is a doctor at City General Hospital.', entities: ['Emma', 'Rachel', 'City General'] },
  { id: 'T16', speaker: 'David', text: 'I learned baking from my grandmother Rosa who had a bakery in Italy.', entities: ['David', 'Rosa'] },

  // Session 4: Connecting details
  { id: 'T17', speaker: 'Sarah', text: 'I drive a red Toyota Camry to work every day. The commute is 30 minutes.', entities: ['Sarah'] },
  { id: 'T18', speaker: 'Mike', text: 'I take the BART train from Berkeley to Mountain View for work.', entities: ['Mike', 'Berkeley'] },
  { id: 'T19', speaker: 'Emma', text: 'I\'m planning a trip to Japan next summer with my boyfriend Tom.', entities: ['Emma', 'Tom', 'Japan'] },
  { id: 'T20', speaker: 'David', text: 'I\'m training for the New York Marathon in November. Aiming for under 3:30.', entities: ['David', 'New York Marathon'] },
];

// Multi-hop questions that require connecting info from 2+ turns
interface MultiHopQuery {
  name: string;
  question: string;
  requiredTurns: string[]; // Turn IDs that must BOTH appear in top 10
  bridgeEntity: string; // The entity that connects the turns
}

const QUERIES: MultiHopQuery[] = [
  {
    name: 'MH1',
    question: 'What hobby does the person who works at Memorial Hospital enjoy?',
    requiredTurns: ['T1', 'T3'], // Sarah works at hospital + Sarah paints
    bridgeEntity: 'Sarah',
  },
  {
    name: 'MH2',
    question: 'What pet does the software engineer at Google have?',
    requiredTurns: ['T2', 'T6'], // Mike at Google + Mike has Buddy
    bridgeEntity: 'Mike',
  },
  {
    name: 'MH3',
    question: 'Where does the biology teacher live?',
    requiredTurns: ['T7', 'T11'], // Emma teaches biology + Emma lives at Riverside
    bridgeEntity: 'Emma',
  },
  {
    name: 'MH4',
    question: 'What school did the nurse at Memorial Hospital attend?',
    requiredTurns: ['T1', 'T13'], // Sarah at hospital + Sarah went to Stanford
    bridgeEntity: 'Sarah',
  },
  {
    name: 'MH5',
    question: 'What marathon time did the bakery owner achieve?',
    requiredTurns: ['T8', 'T10'], // David owns bakery + David ran Boston in 3:45
    bridgeEntity: 'David',
  },
];

// --- Main ---

async function main() {
  console.log('Mini Multi-Hop Test');
  console.log(`Target: ${BASE_URL}\n`);

  const health = await api('GET', '/health');
  if (health.error) { console.error('Server not running'); process.exit(1); }
  console.log(`Server: OK (${health.version})`);

  const agentId = crypto.randomUUID();

  // Seed turns
  console.log('\nSeeding 20 turns...');
  const turnToEngram = new Map<string, string>();

  for (const turn of TURNS) {
    const res = await api('POST', '/memory/write', {
      agentId,
      concept: `${turn.speaker} conversation`,
      content: turn.text,
      tags: [turn.id, turn.speaker.toLowerCase(), ...turn.entities.map(e => e.toLowerCase())],
      eventType: 'causal',
      surprise: 0.6,
      causalDepth: 0.6,
      resolutionEffort: 0.5,
      decisionMade: false,
    });
    if (res.engram?.id) turnToEngram.set(turn.id, res.engram.id);
  }

  console.log(`  Seeded: ${turnToEngram.size} turns`);
  console.log('  Waiting for embeddings...');
  await sleep(3000);

  // Build associations
  console.log('  Building associations...');
  for (const name of ['Sarah', 'Mike', 'Emma', 'David']) {
    await api('POST', '/memory/activate', { agentId, context: `${name} life hobbies work` });
    await api('POST', '/memory/activate', { agentId, context: `${name} personal details` });
  }

  // Run multi-hop queries
  console.log('\n=== MULTI-HOP QUERIES ===\n');

  let passed = 0;

  for (const q of QUERIES) {
    const res = await api('POST', '/memory/activate', {
      agentId,
      context: q.question,
      limit: 10,
      includeStaging: true,
    });

    const results = res.results ?? [];
    const retrievedTags = results.flatMap((r: any) => r.engram?.tags ?? []);

    // Check if BOTH required turns are in the results
    const found: string[] = [];
    const missing: string[] = [];
    for (const reqId of q.requiredTurns) {
      if (retrievedTags.includes(reqId)) {
        found.push(reqId);
      } else {
        missing.push(reqId);
      }
    }

    const allFound = missing.length === 0;
    if (allFound) passed++;

    const status = allFound ? 'PASS' : 'FAIL';
    const topConcepts = results.slice(0, 3).map((r: any) => {
      const tags = r.engram?.tags?.filter((t: string) => /^T\d+$/.test(t)) ?? [];
      return `${tags[0] ?? '?'}(${r.score.toFixed(2)})`;
    }).join(', ');

    console.log(`  [${status}] ${q.name}: ${q.question}`);
    console.log(`         Bridge: ${q.bridgeEntity} | Found: ${found.join(',')} | Missing: ${missing.join(',')}`);
    console.log(`         Top 3: ${topConcepts}`);
    // Debug: show all 10 results
    if (!allFound) {
      console.log(`         All 10:`);
      for (const r of results) {
        const tags = r.engram?.tags?.filter((t: string) => /^T\d+$/.test(t)) ?? [];
        const entity = r.engram?.tags?.filter((t: string) => !/^T\d+$/.test(t)) ?? [];
        console.log(`           ${tags[0] ?? '?'}(${r.score.toFixed(3)}) [${entity.join(',')}] graph=${r.phaseScores?.graphBoost?.toFixed(3) ?? '?'} rerank=${r.phaseScores?.rerankerScore?.toFixed(3) ?? '?'}`);
      }
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Multi-hop: ${passed}/${QUERIES.length} (${(passed/QUERIES.length*100).toFixed(0)}%)`);
  console.log('='.repeat(50));

  process.exit(passed >= 3 ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
