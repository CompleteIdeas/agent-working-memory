/**
 * Answer check (plan §4.6b), offline: does a small SQuAD 2.0 reader's no-answer score tell a
 * correct answer from a question whose answer is not stored — the deleted-fact case every
 * retrieval signal plateaus on (~0.82 AUC on natural language)?
 *
 * For every probe in signal-dump.ts output (labelled questions and calibration probes), the
 * reader reads the TOP result's passage — the query-centred window the cross-encoder sees, widened
 * to 1,200 characters — and scores best answer span minus no-answer. Writes %TEMP%/awm-qa.json
 * aligned with awm-signals.json; prints the AUCs alone and added to the shipped gate's signals.
 *
 * Model: deepset/minilm-uncased-squad2 exported to ONNX locally (data/models/local/, gitignored).
 *   npx tsx tests/realstore-eval/qa-signal.ts
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AutoTokenizer, AutoModelForQuestionAnswering, env } from '@huggingface/transformers';
import { buildRerankPassage } from '../../src/core/rerank-window.js';
import { fitLogistic } from '../../src/engine/abstention-gate.js';

env.allowLocalModels = true; env.allowRemoteModels = false;
env.localModelPath = resolve('data/models/local') + '/';
const DTYPE = (process.env.QA_DTYPE ?? 'q8') as 'q8' | 'fp32';
const QA_MODEL = process.env.QA_MODEL ?? 'minilm-uncased-squad2';
const tok = await AutoTokenizer.from_pretrained(QA_MODEL);
const model = await AutoModelForQuestionAnswering.from_pretrained(QA_MODEL, { dtype: DTYPE });

const dir = import.meta.dirname;
const S = JSON.parse(readFileSync(join(tmpdir(), 'awm-signals.json'), 'utf8'));
const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });
const get = db.prepare('SELECT concept, content, tags FROM engrams WHERE id = ?');

async function margin(query: string, id: string | null | undefined): Promise<number | null> {
  if (!id || !query) return null;
  const e: any = get.get(id);
  if (!e) return null;
  const passage = buildRerankPassage(e.concept, e.content, query, 1200, 'query');
  const inputs = tok(query, { text_pair: passage, truncation: true, max_length: 384, return_tensor: true });
  const out: any = await model(inputs);
  const s = out.start_logits.data as Float32Array, en = out.end_logits.data as Float32Array;
  const ids = Array.from(inputs.input_ids.data as BigInt64Array).map(Number);
  // A pair ends with the separator token, whatever its id ([SEP]=102 for BERT, 2 for DeBERTa):
  // the context starts after its first occurrence.
  const ctx = ids.indexOf(ids[ids.length - 1]!) + 1;
  let best = -Infinity;
  for (let i = ctx; i < s.length - 1; i++) for (let j = i; j < Math.min(s.length - 1, i + 30); j++) best = Math.max(best, s[i]! + en[j]!);
  const m = best - (s[0]! + en[0]!);
  // No room for a span (passage truncated away) means no answer found: a floor, not -Infinity,
  // which would poison the fit below (and is written to JSON as null).
  return Number.isFinite(m) ? m : -30;
}

const t0 = Date.now();
let out: { probes: Array<number | null>; calib: Record<string, Array<number | null>> } = { probes: [], calib: {} };
if (process.env.QA_REUSE === '1') {
  // Reuse a saved run. A probe whose top result exists but scored null was -Infinity (JSON writes
  // it as null): no span found, so the floor.
  out = JSON.parse(readFileSync(join(tmpdir(), `awm-qa-${QA_MODEL}.json`), 'utf8'));
  out.probes = out.probes.map((v, i) => (v === null && (S.probes as any[])[i]?.top?.[0] ? -30 : v));
} else for (const [i, p] of (S.probes as any[]).entries()) {
  out.probes.push(await margin(p.query, p.top?.[0]));
  if (i % 300 === 0) process.stderr.write(`probes ${i}/${S.probes.length}\n`);
}
// calibration probes carry no query text in the dump; they are regenerated in signal-fit later
writeFileSync(join(tmpdir(), `awm-qa-${QA_MODEL}.json`), JSON.stringify(out));
const per = (Date.now() - t0) / S.probes.length;
console.log(`${QA_MODEL}: reader margins for ${out.probes.length} probes, ${per.toFixed(1)} ms each (${DTYPE})`);

// ── separation: correct answer vs never-stored / deleted, per question shape ──
const auc = (pos: number[], neg: number[]) => { let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0; return s / (pos.length * neg.length); };
const lg = (p: number) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
const rows = (S.probes as any[]).map((p, i) => ({ p, qa: out.probes[i] })).filter((r) => r.qa !== null) as Array<{ p: any; qa: number }>;
const featA = (p: any) => { const t = p.pool.find((c: any) => c.id === p.top[0]); const sorted = [...p.pool].sort((a: any, b: any) => b.rr - a.rr); const s2 = sorted.find((c: any) => c.id !== t?.id); return t ? [lg(t.rr), t.cos, lg(t.rr) - lg(s2?.rr ?? 1e-6)] : null; };
function cv(xs: Array<{ x: number[]; y: number }>): number {
  const sc: Array<{ s: number; y: number }> = [];
  for (let k = 0; k < 5; k++) {
    const tr = xs.filter((_, i) => i % 5 !== k), te = xs.filter((_, i) => i % 5 === k);
    const m = fitLogistic(tr.map((r) => r.x), tr.map((r) => r.y));
    for (const r of te) sc.push({ s: r.x.reduce((a, v, j) => a + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b), y: r.y });
  }
  return auc(sc.filter((r) => r.y).map((r) => r.s), sc.filter((r) => !r.y).map((r) => r.s));
}
for (const set of ['kw', 'nl']) {
  const inSet = rows.filter(({ p }) => p.set === set || p.set === 'both');
  const corr = inSet.filter(({ p }) => p.pop === 'answerable' && p.top[0] === p.goldId);
  const nw = inSet.filter(({ p }) => p.pop === 'absent-new'), del = inSet.filter(({ p }) => p.pop === 'absent-familiar');
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
  console.log(`\n${set === 'kw' ? 'KEYWORD' : 'NATURAL-LANGUAGE'}: reader margin alone — AUC vs never-stored ${auc(corr.map((r) => r.qa), nw.map((r) => r.qa)).toFixed(3)}, vs deleted ${auc(corr.map((r) => r.qa), del.map((r) => r.qa)).toFixed(3)}`
    + `   (median: correct ${med(corr.map((r) => r.qa)).toFixed(2)}, never-stored ${med(nw.map((r) => r.qa)).toFixed(2)}, deleted ${med(del.map((r) => r.qa)).toFixed(2)})`);
  const lab = [...corr, ...del];
  const mk = (withQa: boolean) => lab.map(({ p, qa }) => { const a = featA(p); return a ? { x: withQa ? [...a, qa] : a, y: corr.some((c) => c.p === p) ? 1 : 0 } : null; }).filter(Boolean) as Array<{ x: number[]; y: number }>;
  console.log(`  ceiling (5-fold CV), correct vs deleted: shipped 3 signals ${cv(mk(false)).toFixed(3)} · + reader ${cv(mk(true)).toFixed(3)}`);
}
process.exit(0);
