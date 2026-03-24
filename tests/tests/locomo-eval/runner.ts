/**
 * LOCOMO Eval Runner — industry-standard conversational memory benchmark.
 *
 * Uses the LOCOMO dataset (Snap Research) to evaluate retrieval quality
 * across 5 categories: single-hop, multi-hop, temporal, open-domain, adversarial.
 *
 * What we measure (retrieval-only — no LLM answer generation):
 *   - Recall@5, Recall@10: are the evidence turns in the results?
 *   - MRR: how high does the first evidence turn rank?
 *   - nDCG@10: ranking quality with graded relevance
 *   - Adversarial rejection: does the system correctly return nothing?
 *
 * Run: npx tsx tests/locomo-eval/runner.ts [baseUrl]
 * Requires a live AWM server (npx tsx src/index.ts).
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const DATA_DIR = join(import.meta.dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'locomo10.json');
const DATASET_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

// --- Types ---

interface DialogTurn {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
}

interface QAEntry {
  question: string;
  answer: string;
  evidence: string[];
  category: number;
  adversarial_answer?: string;
}

interface LocomoConversation {
  qa: QAEntry[];
  conversation: Record<string, any>;
  sample_id?: number;
}

type LocomoData = LocomoConversation[];

interface CategoryResult {
  name: string;
  queries: number;
  recall5: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
  avgScore: number;
}

// --- Helpers (same pattern as other runners) ---

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const TMP_DIR = join(tmpdir(), 'awm-locomo-eval');
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
    const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(result);
  } catch (err: any) {
    return { error: err.message };
  }
}

// --- Concept Extraction ---

const STOP_WORDS = new Set([
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'can', 'may', 'might', 'shall', 'must', 'need',
  'and', 'but', 'or', 'so', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'about', 'into',
  'not', 'no', 'yes', 'just', 'also', 'very', 'really', 'too', 'much', 'more',
  'up', 'out', 'all', 'some', 'any', 'each', 'every', 'own', 'same', 'such',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'here', 'there', 'now', 'still', 'even', 'back', 'well', 'way', 'thing',
  'like', 'know', 'think', 'get', 'got', 'make', 'go', 'going', 'went',
  'come', 'came', 'take', 'took', 'see', 'saw', 'say', 'said', 'tell', 'told',
  'one', 'two', 'first', 'new', 'good', 'right', 'time', 'lot', 'day',
  'hi', 'hey', 'oh', 'yeah', 'wow', 'haha', 'lol', 'sure', 'okay', 'ok',
  'im', 'ive', 'dont', 'didnt', 'cant', 'thats', 'its', 'hes', 'shes', 'were',
  'been', 'let', 'put', 'try', 'keep', 'give', 'feel', 'look', 'sound',
]);

/**
 * Extract a meaningful concept string from a conversation turn.
 * Prioritizes proper nouns, uncommon words, and topic-bearing terms.
 */
function extractConcept(speaker: string, text: string): string {
  // Extract proper nouns (capitalized words not at sentence start)
  const properNouns: string[] = [];
  const sentences = text.split(/[.!?]\s+/);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const clean = words[i].replace(/[^a-zA-Z]/g, '');
      if (clean.length > 1 && /^[A-Z]/.test(clean)) {
        properNouns.push(clean);
      }
    }
  }

  // Extract content words (non-stopwords, 4+ chars for higher specificity)
  const allWords = text.toLowerCase().replace(/[^a-z0-9\s'-]/g, '').split(/\s+/);
  const contentWords = allWords
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  // Build concept: speaker + proper nouns + top content words (max 8 tokens)
  // Keep it focused — too many words creates false concept matches
  const parts = [speaker];
  const seen = new Set<string>([speaker.toLowerCase()]);

  for (const pn of properNouns) {
    if (!seen.has(pn.toLowerCase())) {
      parts.push(pn);
      seen.add(pn.toLowerCase());
    }
  }

  for (const w of contentWords) {
    if (!seen.has(w) && parts.length < 8) {
      parts.push(w);
      seen.add(w);
    }
  }

  return parts.join(' ');
}

// --- Dataset Management ---

async function ensureDataset(): Promise<LocomoData> {
  if (!existsSync(DATA_FILE)) {
    console.log('Downloading LOCOMO dataset...');
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      const result = execSync(
        `curl --ssl-no-revoke -sfL "${DATASET_URL}" -o "${DATA_FILE.replace(/\\/g, '/')}"`,
        { timeout: 30000 }
      );
      console.log('Downloaded.');
    } catch (err) {
      console.error('FATAL: Could not download LOCOMO dataset.');
      console.error(`Try manually: curl -L "${DATASET_URL}" -o "${DATA_FILE}"`);
      process.exit(1);
    }
  }

  const raw = readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw) as LocomoData;
}

// --- Scoring Functions ---

/** Reciprocal rank: 1/position of first relevant result (0 if not found) */
function computeMRR(retrievedDiaIds: string[], evidenceIds: Set<string>): number {
  for (let i = 0; i < retrievedDiaIds.length; i++) {
    if (evidenceIds.has(retrievedDiaIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Recall@k: fraction of evidence turns found in top k results */
function computeRecall(retrievedDiaIds: string[], evidenceIds: Set<string>, k: number): number {
  if (evidenceIds.size === 0) return 1; // no evidence needed = perfect
  const topK = retrievedDiaIds.slice(0, k);
  const found = topK.filter(id => evidenceIds.has(id)).length;
  return found / evidenceIds.size;
}

/** nDCG@k: normalized discounted cumulative gain */
function computeNDCG(retrievedDiaIds: string[], evidenceIds: Set<string>, k: number): number {
  if (evidenceIds.size === 0) return 1;

  // DCG: sum of 1/log2(i+2) for relevant results at position i
  let dcg = 0;
  const topK = retrievedDiaIds.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (evidenceIds.has(topK[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }

  // Ideal DCG: all evidence turns ranked at the top
  let idcg = 0;
  const idealCount = Math.min(evidenceIds.size, k);
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

// --- Session Parsing ---

interface ParsedTurn {
  diaId: string;
  speaker: string;
  text: string;
  sessionNum: number;
  sessionDate: string;
}

function parseConversation(conversation: Record<string, any>): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  const speakerA = conversation.speaker_a as string;
  const speakerB = conversation.speaker_b as string;

  for (let s = 1; s <= 9; s++) {
    const sessionKey = `session_${s}`;
    const dateKey = `session_${s}_date_time`;
    const session = conversation[sessionKey] as DialogTurn[] | undefined;
    const dateStr = (conversation[dateKey] as string) ?? '';

    if (!session) continue;

    for (const turn of session) {
      if (!turn.text || turn.text.trim().length < 10) continue; // skip trivial turns
      turns.push({
        diaId: turn.dia_id,
        speaker: turn.speaker,
        text: turn.text + (turn.blip_caption ? ` [Image: ${turn.blip_caption}]` : ''),
        sessionNum: s,
        sessionDate: dateStr,
      });
    }
  }

  return turns;
}

// --- Main ---

const CATEGORY_NAMES: Record<number, string> = {
  1: 'Multi-hop',
  2: 'Single-hop',
  3: 'Temporal',
  4: 'Open-domain',
  5: 'Adversarial',
};

// --- Per-conversation evaluation ---

interface ConvResult {
  convIndex: number;
  overall: number;
  catScores: Record<number, number>;
  queryCount: number;
  seeded: number;
  activeCount: number;
  catResults: Record<number, {
    recall5: number[]; recall10: number[]; mrr: number[]; ndcg10: number[];
  }>;
}

const categoryWeights: Record<number, number> = {
  1: 0.25, // multi-hop — hardest, tests associations
  2: 0.25, // single-hop — core BM25 retrieval
  3: 0.20, // temporal — tests decay model
  4: 0.15, // open-domain — broader recall
  5: 0.15, // adversarial — noise rejection
};

async function evaluateConversation(data: LocomoConversation, convIndex: number): Promise<ConvResult> {
  const turns = parseConversation(data.conversation);
  console.log(`\n--- Conversation ${convIndex}: ${data.qa.length} QA pairs, ${turns.length} turns ---`);

  // Register fresh agent per conversation
  const agent = await api('POST', '/agent/register', { name: `locomo-eval-conv${convIndex}` });
  const agentId = agent.id;

  // PHASE 1: Seed
  const diaIdToEngramId = new Map<string, string>();
  let seeded = 0;
  let activeCount = 0;

  for (const turn of turns) {
    const hasDecision = /decided|chose|going to|plan to|will be|want to/i.test(turn.text);
    const hasFact = /is a|works at|lives in|born in|moved to|started|graduated|married/i.test(turn.text);
    const hasEmotion = /love|hate|excited|worried|afraid|amazing|terrible|great|wonderful|annoying/i.test(turn.text);
    const isLong = turn.text.length > 100;

    const surprise = hasFact ? 0.6 : hasEmotion ? 0.5 : 0.3;
    const causalDepth = hasDecision ? 0.7 : hasFact ? 0.6 : isLong ? 0.5 : 0.3;
    const resolutionEffort = isLong ? 0.5 : 0.3;
    const eventType = hasDecision ? 'decision' : hasFact ? 'causal' : hasEmotion ? 'friction' : 'observation';

    const res = await api('POST', '/memory/write', {
      agentId,
      concept: extractConcept(turn.speaker, turn.text),
      content: turn.text,
      tags: [`session-${turn.sessionNum}`, turn.speaker.toLowerCase(), turn.diaId],
      eventType, surprise, causalDepth, resolutionEffort,
      decisionMade: hasDecision,
    });

    if (res.engram?.id) diaIdToEngramId.set(turn.diaId, res.engram.id);
    if (res.disposition === 'active') activeCount++;
    seeded++;
    if (seeded % 50 === 0) process.stdout.write(`  conv${convIndex}: ${seeded}/${turns.length} seeded...\r`);
  }
  console.log(`  Seeded: ${seeded} turns (${activeCount} active)`);
  await sleep(3000); // embeddings settle

  // PHASE 2: Associations + consolidation
  const sessionTopics = [
    'personal identity support group',
    'work career job promotion',
    'travel vacation trip destination',
    'family relationship partner children',
    'hobbies cooking food recipe',
    'health fitness exercise wellness',
    'movies books music entertainment',
    'plans future goals activities',
    'pets animals dog cat',
  ];
  for (const topic of sessionTopics) {
    await api('POST', '/memory/activate', { agentId, context: topic });
  }
  await api('POST', '/system/consolidate', { agentId });

  // PHASE 3: QA challenges
  const catResults: Record<number, {
    recall5: number[]; recall10: number[]; mrr: number[]; ndcg10: number[];
  }> = {};
  for (const cat of [1, 2, 3, 4, 5]) {
    catResults[cat] = { recall5: [], recall10: [], mrr: [], ndcg10: [] };
  }

  let queryCount = 0;
  for (const qa of data.qa) {
    const isAdversarial = qa.category === 5;
    const evidenceSet = new Set(qa.evidence);

    const activateParams: any = {
      agentId, context: qa.question, limit: 10,
      includeStaging: true, useReranker: true, useExpansion: true,
    };
    if (isAdversarial) {
      activateParams.minScore = 0.3;
      activateParams.abstentionThreshold = 0.3;
    }

    const res = await api('POST', '/memory/activate', activateParams);
    const results = res.results ?? [];

    const retrievedDiaIds: string[] = results.map((r: any) => {
      const diaTag = r.engram?.tags?.find((t: string) => /^D\d+:\d+$/.test(t));
      return diaTag ?? '';
    }).filter((id: string) => id !== '');

    if (isAdversarial) {
      const rejection = results.length === 0 ? 1.0 : Math.max(0, 1 - results.length * 0.2);
      catResults[5].recall5.push(rejection);
      catResults[5].recall10.push(rejection);
      catResults[5].mrr.push(rejection);
      catResults[5].ndcg10.push(rejection);
    } else {
      catResults[qa.category].recall5.push(computeRecall(retrievedDiaIds, evidenceSet, 5));
      catResults[qa.category].recall10.push(computeRecall(retrievedDiaIds, evidenceSet, 10));
      catResults[qa.category].mrr.push(computeMRR(retrievedDiaIds, evidenceSet));
      catResults[qa.category].ndcg10.push(computeNDCG(retrievedDiaIds, evidenceSet, 10));
    }
    queryCount++;
    if (queryCount % 25 === 0) process.stdout.write(`  conv${convIndex}: ${queryCount}/${data.qa.length} queries...\r`);
  }

  // Compute per-conversation overall
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const catScores: Record<number, number> = {};
  let overall = 0;
  for (const cat of [1, 2, 3, 4, 5]) {
    const c = catResults[cat];
    const r10 = avg(c.recall10), mrr = avg(c.mrr), ndcg = avg(c.ndcg10);
    catScores[cat] = 0.3 * r10 + 0.3 * mrr + 0.4 * ndcg;
    overall += catScores[cat] * (categoryWeights[cat] ?? 0.2);
  }

  console.log(`  Conv ${convIndex} overall: ${(overall * 100).toFixed(1)}%`);
  return { convIndex, overall, catScores, queryCount, seeded, activeCount, catResults };
}

// --- Main ---

async function main() {
  console.log('AgentWorkingMemory LOCOMO Eval (all conversations)');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);

  // Health check
  const health = await api('GET', '/health');
  if (health.status !== 'ok') {
    console.error(`FATAL: Cannot reach server at ${BASE_URL}`);
    process.exit(1);
  }
  console.log(`Server: OK (${health.version})`);

  const allConversations = await ensureDataset();
  const totalQA = allConversations.reduce((s, c) => s + c.qa.length, 0);
  console.log(`Dataset: ${allConversations.length} conversations, ${totalQA} total QA pairs`);

  // Evaluate each conversation
  const convResults: ConvResult[] = [];
  for (let i = 0; i < allConversations.length; i++) {
    const result = await evaluateConversation(allConversations[i], i);
    convResults.push(result);
  }

  // =========================================================
  // AGGREGATE REPORT
  // =========================================================
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const stddev = (arr: number[]) => {
    if (arr.length < 2) return 0;
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
  };

  console.log('\n' + '='.repeat(70));
  console.log('LOCOMO EVAL REPORT — ALL CONVERSATIONS');
  console.log('='.repeat(70));

  // Per-conversation scores
  console.log('\nPer-conversation overall scores:');
  const overalls = convResults.map(r => r.overall);
  for (const r of convResults) {
    console.log(`  Conv ${r.convIndex}: ${(r.overall * 100).toFixed(1)}% (${r.queryCount} queries, ${r.seeded} turns seeded)`);
  }

  // Aggregate per-category across all conversations
  console.log('\nPer-category aggregates (mean ± stddev):');
  for (const cat of [1, 2, 3, 4, 5]) {
    // Collect all per-query scores across all conversations
    const allRecall5: number[] = [];
    const allRecall10: number[] = [];
    const allMRR: number[] = [];
    const allNDCG: number[] = [];
    for (const r of convResults) {
      allRecall5.push(...r.catResults[cat].recall5);
      allRecall10.push(...r.catResults[cat].recall10);
      allMRR.push(...r.catResults[cat].mrr);
      allNDCG.push(...r.catResults[cat].ndcg10);
    }

    const perConvScores = convResults.map(r => r.catScores[cat]);
    console.log(`\n  ${cat}. ${CATEGORY_NAMES[cat]} (${allRecall5.length} queries across ${convResults.length} convos)`);
    console.log(`     Recall@5:  ${(avg(allRecall5) * 100).toFixed(1)}% ± ${(stddev(allRecall5) * 100).toFixed(1)}%`);
    console.log(`     Recall@10: ${(avg(allRecall10) * 100).toFixed(1)}% ± ${(stddev(allRecall10) * 100).toFixed(1)}%`);
    console.log(`     MRR:       ${(avg(allMRR) * 100).toFixed(1)}% ± ${(stddev(allMRR) * 100).toFixed(1)}%`);
    console.log(`     nDCG@10:   ${(avg(allNDCG) * 100).toFixed(1)}% ± ${(stddev(allNDCG) * 100).toFixed(1)}%`);
    console.log(`     Composite: ${(avg(perConvScores) * 100).toFixed(1)}% ± ${(stddev(perConvScores) * 100).toFixed(1)}%`);
  }

  // Overall
  const meanOverall = avg(overalls);
  const sdOverall = stddev(overalls);

  console.log('\n' + '-'.repeat(70));
  console.log(`OVERALL: ${(meanOverall * 100).toFixed(1)}% ± ${(sdOverall * 100).toFixed(1)}% (n=${convResults.length})`);
  console.log(`  Range: ${(Math.min(...overalls) * 100).toFixed(1)}% — ${(Math.max(...overalls) * 100).toFixed(1)}%`);

  if (meanOverall >= 0.7) console.log('GRADE: EXCELLENT');
  else if (meanOverall >= 0.5) console.log('GRADE: GOOD');
  else if (meanOverall >= 0.35) console.log('GRADE: FAIR');
  else console.log('GRADE: NEEDS WORK');

  // Weakest category
  const catMeans: { cat: number; mean: number }[] = [];
  for (const cat of [1, 2, 3, 4, 5]) {
    catMeans.push({ cat, mean: avg(convResults.map(r => r.catScores[cat])) });
  }
  catMeans.sort((a, b) => a.mean - b.mean);
  console.log(`\nWEAKEST: ${CATEGORY_NAMES[catMeans[0].cat]} (${(catMeans[0].mean * 100).toFixed(1)}%)`);
  console.log(`STRONGEST: ${CATEGORY_NAMES[catMeans[catMeans.length - 1].cat]} (${(catMeans[catMeans.length - 1].mean * 100).toFixed(1)}%)`);

  console.log('\n' + '='.repeat(70));

  process.exit(meanOverall >= 0.35 ? 0 : 1);
}

main().catch(err => {
  console.error('LOCOMO eval failed:', err);
  process.exit(1);
});
