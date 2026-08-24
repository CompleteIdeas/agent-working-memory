/**
 * Second-stage rerank diagnostic — "rerank the rerank".
 *
 * QUESTION
 * --------
 * 37.8% of answerable LoCoMo queries put gold at rank 1, but 62.2% have gold
 * somewhere in the top 10. That 24.4pp gap is the largest addressable win in the
 * pipeline. Half of it (12.8pp) sits in ranks 2-3 alone.
 *
 * Before building a second stage, establish WHY gold is at rank 2 instead of 1.
 * There are two very different causes with very different fixes:
 *
 *   (a) THE BLEND. Final order is
 *         score = compositeWeight * composite + rerankWeight * rerankerScore
 *       with rerankWeight capped at 0.7 (activation.ts:881). So composite always
 *       keeps >=30% of the vote. If the reranker already ranks gold first and the
 *       blend demotes it, the fix is free — no model, no extra compute.
 *
 *   (b) THE MODEL. If the cross-encoder itself scores a distractor above gold,
 *       no reweighting helps and a second stage needs a stronger model or a
 *       comparative (pairwise/listwise) signal.
 *
 * METHOD
 * ------
 * Run the pipeline faithfully at limit=10 (so rerankPoolSize is the production
 * 40, not a widened one). Every returned result carries phaseScores.composite and
 * phaseScores.rerankerScore, so one pass captures everything needed to SIMULATE
 * many reordering policies offline — no engine changes, no re-running the model
 * per policy.
 *
 * Run: npx tsx tests/rerank2-eval/diagnose.ts
 *      LOCOMO_CONVS=3 npx tsx tests/rerank2-eval/diagnose.ts
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';

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

const DATA_FILE = join(import.meta.dirname, '..', 'locomo-eval', 'data', 'locomo10.json');
const OUT_DIR = import.meta.dirname;
const LOG = join(OUT_DIR, 'candidates.jsonl');
const DB = join(import.meta.dirname, '..', '..', 'data', '_rerank2.db');
const LIMIT = 10;

async function main() {
  for (const e of ['', '-wal', '-shm']) { try { if (existsSync(DB + e)) unlinkSync(DB + e); } catch { /* */ } }
  mkdirSync(OUT_DIR, { recursive: true });

  const data = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as any[];
  const maxConvs = Number(process.env.LOCOMO_CONVS ?? data.length);

  const store = new EngramStore(DB);
  const activation = new ActivationEngine(store);
  const connections = new ConnectionEngine(store, activation);

  const lines: string[] = [];

  for (let ci = 0; ci < Math.min(maxConvs, data.length); ci++) {
    const rec = data[ci];
    const agentId = `r2-conv${ci}`;
    const turns = parseConversation(rec.conversation);
    const diaToId = new Map<string, string>();

    // Seeding replicated VERBATIM from locomo-eval/trace.ts:85-98 — the salience
    // cues feed composite scoring, so any divergence would make these ranks
    // incomparable to the baseline arm this diagnostic is explaining.
    for (const t of turns) {
      const hasDecision = /decided|chose|going to|plan to|will be|want to/i.test(t.text);
      const hasFact = /is a|works at|lives in|born in|moved to|started|graduated|married/i.test(t.text);
      const hasEmotion = /love|hate|excited|worried|afraid|amazing|terrible|great|wonderful|annoying/i.test(t.text);
      const isLong = t.text.length > 100;
      const res: any = await performWrite({ store, connectionEngine: connections } as any, {
        agentId, concept: `${t.speaker} ${t.text.split(/\s+/).slice(0, 6).join(' ')}`, content: t.text,
        tags: [`session-${t.sessionNum}`, t.speaker.toLowerCase(), t.diaId],
        eventType: hasDecision ? 'decision' : hasFact ? 'causal' : hasEmotion ? 'friction' : 'observation',
        surprise: hasFact ? 0.6 : hasEmotion ? 0.5 : 0.3,
        decisionMade: hasDecision, causalDepth: hasDecision ? 0.7 : hasFact ? 0.6 : isLong ? 0.5 : 0.3,
        resolutionEffort: isLong ? 0.5 : 0.3,
      } as any);
      if (res?.engram?.id) diaToId.set(t.diaId, res.engram.id);
    }

    for (const qa of (rec.qa ?? [])) {
      const category = qa.category as number;
      if (category === 5) continue;                       // adversarial: no gold to rank
      const goldIds = (qa.evidence ?? []).map((d: string) => diaToId.get(d)).filter(Boolean) as string[];
      if (goldIds.length === 0) continue;
      const goldSet = new Set(goldIds);

      const results = await activation.activate({
        agentId, context: qa.question, limit: LIMIT, internal: true,
      } as any);
      if (!results.length) continue;

      // Capture the returned top-K with every score the pipeline computed, so
      // reordering policies can be simulated offline.
      const cands = results.map((r: any, i: number) => ({
        rank: i + 1,
        gold: goldSet.has(r.engram.id),
        composite: r.phaseScores?.composite ?? 0,
        reranker: r.phaseScores?.rerankerScore ?? 0,
        blended: r.score ?? 0,
        textMatch: r.phaseScores?.textMatch ?? 0,
        len: (r.engram.content ?? '').length,
      }));
      lines.push(JSON.stringify({ conv: ci, category, q: qa.question, cands }));
    }
    process.stderr.write(`  conv ${ci + 1}/${Math.min(maxConvs, data.length)} (${lines.length} queries)\r`);
  }

  store.close?.();
  writeFileSync(LOG, lines.join('\n') + '\n');
  console.log(`\nlogged ${lines.length} queries -> ${LOG}`);
  process.exit(0);
}
main().catch(e => { console.error('\nDIAGNOSE ERROR:', e); process.exit(1); });
