/**
 * LoCoMo pipeline-attribution trace — "contrast imaging" at full benchmark scale.
 *
 * Seeds every LoCoMo conversation in-process (same parse/concept/salience as the
 * benchmark runner), then for every QA query captures a STRUCTURED per-stage record of
 * where the GOLD evidence turn lands in the funnel:
 *   - gold's best vector cosine + whether it cleared the candidate FLOOR (0.40)
 *   - whether the KEYWORD (BM25) channel found it
 *   - gold rank PRE-rerank (scoring) and POST-rerank (final); abstention
 *   - LOST-AT: the first stage the gold dropped out
 * Adversarial (cat 5, no gold): success = correctly abstained / returned nothing relevant.
 *
 * Logs every record to trace-log.jsonl, then aggregates statistics overall + per
 * category + a stage-attribution histogram — so we can finally see, quantitatively,
 * WHERE the pipeline loses answers (e.g. how much multi-hop / cross-lingual dies at the
 * floor vs at rerank). Flip flags (AWM_QUERY_BRIDGE=1, AWM_AUTOTAG=1, AWM_SPREAD=1…) and
 * re-run to A/B the attribution.
 *
 * Run: npx tsx tests/locomo-eval/trace.ts
 *      LOCOMO_TRACE_CONVS=3 npx tsx tests/locomo-eval/trace.ts   (subset, faster)
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { ConsolidationEngine } from '../../src/engine/consolidation.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { embed } from '../../src/core/embeddings.js';

// Inlined from runner.ts (avoids importing the runner module, whose top-level main() runs on import).
interface ParsedTurn { diaId: string; speaker: string; text: string; sessionNum: number }
function parseConversation(conversation: Record<string, any>): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (let s = 1; s <= 9; s++) {
    const session = conversation[`session_${s}`] as any[] | undefined;
    if (!session) continue;
    for (const turn of session) {
      if (!turn.text || turn.text.trim().length < 10) continue;
      turns.push({
        diaId: turn.dia_id, speaker: turn.speaker,
        text: turn.text + (turn.blip_caption ? ` [Image: ${turn.blip_caption}]` : ''),
        sessionNum: s,
      });
    }
  }
  return turns;
}

const DATA_FILE = join(import.meta.dirname, 'data', 'locomo10.json');
const LOG_FILE = join(import.meta.dirname, 'trace-log.jsonl');
const DB = join(import.meta.dirname, '..', '..', 'data', '_locomo-trace.db');
const FLOOR = 0.40;          // SIM_CANDIDATE_FLOOR_TARGETED default
const LIMIT = 10;            // matches the LoCoMo runner's activate limit
const CAT = { 1: 'multi-hop', 2: 'single-hop', 3: 'temporal', 4: 'open-domain', 5: 'adversarial' } as Record<number, string>;

interface Rec {
  conv: number; category: number; cat: string;
  goldCount: number; goldCos: number; aboveFloor: boolean; inBM25: boolean;
  preRank: number; postRank: number; abstained: boolean; lostAt: string;
}

async function main() {
  const arm = ['AWM_QUERY_BRIDGE', 'AWM_AUTOTAG', 'AWM_SPREAD', 'AWM_SPREAD_INJECT', 'AWM_BROAD_EDGES']
    .filter(k => process.env[k] === '1').map(k => k.replace('AWM_', '').toLowerCase()).join('+') || 'baseline';
  for (const e of ['', '-wal', '-shm']) { try { if (existsSync(DB + e)) unlinkSync(DB + e); } catch { /* */ } }
  const data = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as any[];
  const maxConvs = Number(process.env.LOCOMO_TRACE_CONVS ?? data.length);

  const store = new EngramStore(DB);
  const activation = new ActivationEngine(store);
  const connections = new ConnectionEngine(store, activation);
  const consolidation = new ConsolidationEngine(store, connections);

  const recs: Rec[] = [];
  const logLines: string[] = [];

  for (let ci = 0; ci < Math.min(maxConvs, data.length); ci++) {
    const conv = data[ci];
    const agentId = `trace-conv${ci}`;
    const turns = parseConversation(conv.conversation);
    const diaToId = new Map<string, string>();

    // ── Seed (same salience cues as the benchmark runner) ──
    for (const t of turns) {
      const hasDecision = /decided|chose|going to|plan to|will be|want to/i.test(t.text);
      const hasFact = /is a|works at|lives in|born in|moved to|started|graduated|married/i.test(t.text);
      const hasEmotion = /love|hate|excited|worried|afraid|amazing|terrible|great|wonderful|annoying/i.test(t.text);
      const isLong = t.text.length > 100;
      const res = await performWrite({ store, connectionEngine: connections }, {
        agentId, concept: `${t.speaker} ${t.text.split(/\s+/).slice(0, 6).join(' ')}`, content: t.text,
        tags: [`session-${t.sessionNum}`, t.speaker.toLowerCase(), t.diaId],
        eventType: hasDecision ? 'decision' : hasFact ? 'causal' : hasEmotion ? 'friction' : 'observation',
        surprise: hasFact ? 0.6 : hasEmotion ? 0.5 : 0.3,
        decisionMade: hasDecision, causalDepth: hasDecision ? 0.7 : hasFact ? 0.6 : isLong ? 0.5 : 0.3,
        resolutionEffort: isLong ? 0.5 : 0.3,
      });
      if (res?.engram?.id) diaToId.set(t.diaId, res.engram.id);
    }
    await consolidation.consolidate(agentId);

    // ── Probe each QA ──
    for (const qa of (conv.qa ?? []) as any[]) {
      const category = qa.category as number;
      const adversarial = category === 5;
      const goldIds = (qa.evidence ?? []).map((d: string) => diaToId.get(d)).filter(Boolean) as string[];
      if (!adversarial && goldIds.length === 0) continue; // can't trace what isn't seeded

      const qvec = await embed(qa.question);
      const vh = store.searchByVector(agentId, qvec, 50) as Array<{ engram: any; distance: number }>;
      const goldSet = new Set(goldIds);
      const goldCos = adversarial ? 0 : Math.max(0, ...vh.filter(h => goldSet.has(h.engram.id)).map(h => 1 - h.distance));
      const aboveFloor = goldCos >= FLOOR;
      const bm = store.searchBM25WithRank(agentId, qa.question, 50) as Array<{ engram: any; bm25Score: number }>;
      const inBM25 = !adversarial && bm.some(h => goldSet.has(h.engram.id));

      // Adversarial queries get the same abstention params the benchmark runner uses,
      // so "correctly abstained" is measured under real conditions.
      const advParams = adversarial ? { minScore: 0.3, abstentionThreshold: 0.3 } : {};
      const pre = await activation.activate({ agentId, context: qa.question, limit: LIMIT, useReranker: false, internal: true, ...advParams });
      const post = await activation.activate({ agentId, context: qa.question, limit: LIMIT, internal: true, ...advParams });
      const bestRank = (rs: any[]) => { let r = 0; rs.forEach((x, i) => { if (goldSet.has(x.engram.id) && (r === 0 || i + 1 < r)) r = i + 1; }); return r; };
      const preRank = adversarial ? 0 : bestRank(pre);
      const postRank = adversarial ? 0 : bestRank(post);
      const abstained = post.length === 0;

      let lostAt: string;
      if (adversarial) {
        lostAt = abstained ? 'adversarial:abstained(correct)' : 'adversarial:returned(wrong)';
      } else if (postRank === 1) lostAt = 'success@1';
      else if (postRank >= 2 && postRank <= 5) lostAt = 'found@2-5';
      else if (postRank >= 6) lostAt = 'found@6-10';
      else if (abstained) lostAt = (aboveFloor || inBM25) ? 'abstain(had-signal)' : 'abstain(no-signal)';
      else if (!aboveFloor && !inBM25) lostAt = 'lost@candidate-floor';
      else if (preRank === 0) lostAt = 'lost@pool/scoring';
      else if (preRank > 0 && postRank === 0) lostAt = 'lost@rerank';
      else lostAt = 'lost@final-cut';

      const rec: Rec = { conv: ci, category, cat: CAT[category] ?? String(category), goldCount: goldIds.length, goldCos, aboveFloor, inBM25, preRank, postRank, abstained, lostAt };
      recs.push(rec);
      logLines.push(JSON.stringify({ ...rec, q: qa.question }));
    }
    process.stderr.write(`  seeded+probed conv ${ci + 1}/${Math.min(maxConvs, data.length)} (${recs.length} records)\r`);
  }
  store.close?.();
  writeFileSync(LOG_FILE, logLines.join('\n') + '\n');

  // ── Aggregate ──
  const n = recs.length;
  const nonAdv = recs.filter(r => r.category !== 5);
  const adv = recs.filter(r => r.category === 5);
  const pctOf = (k: number, d: number) => d ? `${(100 * k / d).toFixed(1)}%` : '—';

  console.log(`\n${'═'.repeat(78)}\n LoCoMo PIPELINE-ATTRIBUTION  ·  arm=${arm}  ·  ${n} probes (${nonAdv.length} answerable, ${adv.length} adversarial)\n${'═'.repeat(78)}`);
  const s1 = nonAdv.filter(r => r.postRank === 1).length;
  const s5 = nonAdv.filter(r => r.postRank >= 1 && r.postRank <= 5).length;
  const s10 = nonAdv.filter(r => r.postRank >= 1 && r.postRank <= 10).length;
  const flr = nonAdv.filter(r => r.aboveFloor).length;
  const inPool = nonAdv.filter(r => r.preRank > 0).length;
  const lifts = nonAdv.filter(r => r.preRank > 0 && r.postRank > 0).map(r => r.preRank - r.postRank);
  const meanLift = lifts.length ? lifts.reduce((a, b) => a + b, 0) / lifts.length : 0;
  console.log(` ANSWERABLE (cat 1-4):`);
  console.log(`   success@1 ${pctOf(s1, nonAdv.length)}   success@5 ${pctOf(s5, nonAdv.length)}   success@10 ${pctOf(s10, nonAdv.length)}`);
  console.log(`   gold cleared candidate floor: ${pctOf(flr, nonAdv.length)}   gold entered pool (pre-rerank): ${pctOf(inPool, nonAdv.length)}`);
  console.log(`   mean rerank rank-lift (gold): ${meanLift >= 0 ? '+' : ''}${meanLift.toFixed(2)}`);
  console.log(` ADVERSARIAL (cat 5):  correctly abstained/returned-nothing: ${pctOf(adv.filter(r => r.abstained).length, adv.length)}`);

  console.log(`\n WHERE THE PIPELINE LOSES ANSWERABLE QUERIES (stage attribution):`);
  const buckets = new Map<string, number>();
  for (const r of nonAdv) buckets.set(r.lostAt, (buckets.get(r.lostAt) ?? 0) + 1);
  for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
    const w = Math.round(40 * v / nonAdv.length);
    console.log(`   ${'█'.repeat(w).padEnd(40)} ${pctOf(v, nonAdv.length).padStart(6)}  ${k}`);
  }

  console.log(`\n BY CATEGORY (success@1 / floor-cleared / lost-at-floor):`);
  for (const c of [1, 2, 3, 4]) {
    const rc = recs.filter(r => r.category === c);
    if (!rc.length) continue;
    const cs1 = rc.filter(r => r.postRank === 1).length;
    const cfl = rc.filter(r => r.aboveFloor).length;
    const clf = rc.filter(r => r.lostAt === 'lost@candidate-floor').length;
    console.log(`   ${(CAT[c]).padEnd(12)} n=${String(rc.length).padStart(4)}   s@1 ${pctOf(cs1, rc.length).padStart(6)}   floor✓ ${pctOf(cfl, rc.length).padStart(6)}   lost@floor ${pctOf(clf, rc.length).padStart(6)}`);
  }
  console.log(`\n logged ${logLines.length} records → ${LOG_FILE}`);
  console.log(`${'═'.repeat(78)}\n`);
  process.exit(0);
}
main().catch((e) => { console.error('\nTRACE ERROR:', e); process.exit(1); });
