/**
 * Abstention signals, one at a time and as a whole (Robert, 2026-10-30: "gestalt — each signal
 * could impact each item"). Reads signal-dump.ts and density-dump.ts output.
 *
 * Signal families, all measured on the top result the shipped ranking returns:
 *   R  reranker      top score, margin, top score relative to the pool (z-score)
 *   V  vector        top cosine relative to the pool
 *   D  density       how much of the store matches: counts of memories above cosine 0.5..0.8,
 *                    top / mean-of-10 cosine, raw BM25 of the best and 10th match, how many
 *                    memories match any / all query terms
 *   T  answer type   question asks when / how many / who / where, and whether the top memory
 *                    contains a date / number / capitalised name / place-like token
 *   M  memory kind   the top memory's class, synthesis tag, confidence, access count, age,
 *                    memory type
 * Reported: each signal's AUC alone (correct answer vs never-stored, vs deleted), then
 * combinations as a 5-fold CV ceiling on the labelled questions (a diagnostic, not a gate),
 * with and without pairwise interactions with the reranker score.
 *
 *   npx tsx tests/realstore-eval/signal-gestalt.ts
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fitLogistic } from '../../src/engine/abstention-gate.js';

const dir = import.meta.dirname;
const S = JSON.parse(readFileSync(join(tmpdir(), 'awm-signals.json'), 'utf8'));
const DN = JSON.parse(readFileSync(join(tmpdir(), 'awm-density.json'), 'utf8'));
const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });
const meta = db.prepare('SELECT content, concept, memory_class, tags, confidence, access_count, created_at, memory_type FROM engrams WHERE id = ?');
const now = Date.parse('2026-08-24T09:27:21.841Z');

type Cand = { id: string; rr: number; comp: number; text: number; cos: number; b: number; v: number };
const lg = (p: number) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
const inv = (r: number) => (r < 0 ? 0 : 1 / (1 + r));

function features(p: any, d: any): Record<string, number> | null {
  const pool: Cand[] = p.pool;
  const t = pool.find((c) => c.id === p.top[0]) ?? [...pool].sort((a, b) => b.rr - a.rr)[0];
  if (!t) return null;
  const rrs = pool.map((c) => c.rr), m = rrs.reduce((a, b) => a + b, 0) / rrs.length;
  const sd = Math.sqrt(rrs.reduce((a, b) => a + (b - m) ** 2, 0) / rrs.length) || 1e-3;
  const coss = pool.map((c) => c.cos), mc = coss.reduce((a, b) => a + b, 0) / coss.length;
  const second = [...pool].sort((a, b) => b.rr - a.rr).find((c) => c.id !== t.id);
  const e: any = meta.get(t.id) ?? {};
  const text = `${e.concept ?? ''} ${e.content ?? ''}`;
  const q = String(p.query ?? '').toLowerCase();
  const asksWhen = /\bwhen\b|\bwhat (date|day|time|year)\b/.test(q) ? 1 : 0;
  const asksCount = /\bhow (many|much|long|often)\b|\bwhat (number|percent|size)\b/.test(q) ? 1 : 0;
  const asksWho = /\bwho\b|\bwhose\b/.test(q) ? 1 : 0;
  const hasDate = /\b(20\d\d|19\d\d)[-/]\d\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text) ? 1 : 0;
  const hasNum = /\b\d+(\.\d+)?\s?(%|ms|s|gb|mb|kb|min|hours?|days?|x)?\b/i.test(text) ? 1 : 0;
  const hasName = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(e.content ?? '') ? 1 : 0;
  const tags = String(e.tags ?? '');
  return {
    // R
    rrTop: lg(t.rr), rrMargin: lg(t.rr) - lg(second?.rr ?? 1e-6), rrZ: (t.rr - m) / sd,
    // V
    cosTop: t.cos, cosRel: t.cos - mc, vRank: inv(t.v), bRank: inv(t.b),
    // D
    c50: Math.log1p(d.c50), c60: Math.log1p(d.c60), c70: Math.log1p(d.c70), c80: Math.log1p(d.c80),
    dTop: d.cTop, dMean10: d.cMean10, dGap: d.cGap, bm25Top: d.bTop, bm25_10: d.b10,
    nAny: Math.log1p(d.nAny), nAll: Math.log1p(d.nAll), nAllFrac: d.nAny ? d.nAll / d.nAny : 0,
    // T
    typeMismatch: (asksWhen && !hasDate) || (asksCount && !hasNum) || (asksWho && !hasName) ? 1 : 0,
    asksSpecific: asksWhen || asksCount || asksWho ? 1 : 0,
    // M
    canonical: e.memory_class === 'canonical' ? 1 : 0, synth: tags.includes('synth=true') ? 1 : 0,
    conf: Number(e.confidence ?? 0.5), access: Math.log1p(Number(e.access_count ?? 0)),
    ageDays: Math.log1p(Math.max(0, (now - Date.parse(e.created_at ?? new Date(now).toISOString())) / 864e5)),
    episodic: e.memory_type === 'episodic' ? 1 : 0, len: Math.log1p(String(e.content ?? '').length),
  };
}

const rows: Array<{ f: Record<string, number>; pop: string; set: string; correct: boolean }> = [];
(S.probes as any[]).forEach((p, i) => {
  const f = features(p, DN.probes[i]);
  if (f) rows.push({ f, pop: p.pop, set: p.set, correct: p.pop === 'answerable' && p.top[0] === p.goldId });
});

const auc = (pos: number[], neg: number[]) => {
  let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
};
// AUC oriented to the better direction, with the sign shown: '+' higher = answer exists.
const oriented = (pos: number[], neg: number[]) => { const a = auc(pos, neg); return a >= 0.5 ? `+${a.toFixed(3)}` : `-${(1 - a).toFixed(3)}`; };

const FAMILIES: Record<string, string[]> = {
  R: ['rrTop', 'rrMargin', 'rrZ'],
  V: ['cosTop', 'cosRel', 'vRank', 'bRank'],
  D: ['c50', 'c60', 'c70', 'c80', 'dTop', 'dMean10', 'dGap', 'bm25Top', 'bm25_10', 'nAny', 'nAll', 'nAllFrac'],
  T: ['typeMismatch', 'asksSpecific'],
  M: ['canonical', 'synth', 'conf', 'access', 'ageDays', 'episodic', 'len'],
};

for (const set of ['kw', 'nl']) {
  const corr = rows.filter((r) => r.set === set && r.correct);
  const nNew = rows.filter((r) => r.set === 'both' && r.pop === 'absent-new');
  const nFam = rows.filter((r) => r.set === set && r.pop === 'absent-familiar');
  console.log(`\n══ ${set === 'kw' ? 'KEYWORD' : 'NATURAL-LANGUAGE'}: ${corr.length} correct, ${nNew.length} never-stored, ${nFam.length} deleted`);
  console.log('  signal          vs never-stored   vs deleted     (+ = higher means the answer exists)');
  for (const [fam, keys] of Object.entries(FAMILIES)) for (const k of keys) {
    const v = (xs: typeof rows) => xs.map((r) => r.f[k]!);
    console.log(`  ${fam} ${k.padEnd(13)} ${oriented(v(corr), v(nNew)).padStart(8)}         ${oriented(v(corr), v(nFam)).padStart(8)}`);
  }
}

// Combinations: 5-fold CV ceiling, correct vs deleted (the hard case), per set.
function cv(xs: Array<{ x: number[]; y: number }>): number {
  const sc: Array<{ s: number; y: number }> = [];
  for (let k = 0; k < 5; k++) {
    const tr = xs.filter((_, i) => i % 5 !== k), te = xs.filter((_, i) => i % 5 === k);
    const m = fitLogistic(tr.map((r) => r.x), tr.map((r) => r.y));
    for (const r of te) sc.push({ s: r.x.reduce((a, v, j) => a + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b), y: r.y });
  }
  return auc(sc.filter((r) => r.y).map((r) => r.s), sc.filter((r) => !r.y).map((r) => r.s));
}
const combos: Array<[string, string[], boolean]> = [
  ['shipped gate (rrTop, cosTop, rrMargin)', ['rrTop', 'cosTop', 'rrMargin'], false],
  ['R', FAMILIES.R!, false], ['R+V', [...FAMILIES.R!, ...FAMILIES.V!], false],
  ['R+V+D (density)', [...FAMILIES.R!, ...FAMILIES.V!, ...FAMILIES.D!], false],
  ['R+V+D+T (answer type)', [...FAMILIES.R!, ...FAMILIES.V!, ...FAMILIES.D!, ...FAMILIES.T!], false],
  ['all: R+V+D+T+M (memory kind)', Object.values(FAMILIES).flat(), false],
  ['all + interactions with reranker', Object.values(FAMILIES).flat(), true],
];
for (const [label, set] of [['correct vs deleted', 'fam'], ['correct vs never-stored + deleted', 'both']] as const) {
  console.log(`\n══ COMBINED, 5-fold CV ceiling AUC — ${label}`);
  for (const s of ['kw', 'nl']) {
    const pick = rows.filter((r) => (r.set === s && (r.correct || r.pop === 'absent-familiar')) || (set === 'both' && r.set === 'both' && r.pop === 'absent-new'));
    const line = combos.map(([name, keys, inter]) => {
      const xs = pick.map((r) => {
        const base = keys.map((k) => r.f[k]!);
        return { x: inter ? [...base, ...base.map((v) => v * r.f.rrTop!)] : base, y: r.correct ? 1 : 0 };
      });
      return `${name} ${cv(xs).toFixed(3)}`;
    });
    console.log(`  ${s}:\n    ` + line.join('\n    '));
  }
}
