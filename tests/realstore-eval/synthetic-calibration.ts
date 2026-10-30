/**
 * Experiment 2: can the abstention gate be calibrated from queries AWM generates from its own
 * store — no human labels — and still work on the real labelled probes?
 *
 * Synthetic populations, built from the snapshot alone:
 *   pos         query = the most distinctive words of a random memory's concept and content;
 *               the memory it came from is the known answer
 *   null-mixed  distinctive words of two UNRELATED memories, mixed: every word is familiar,
 *               the combination is not a fact (the hard, "familiar" kind of absence)
 *   null-random random words from the store's vocabulary
 * Records the same signals as abstention-features.ts; abstention-synthetic-eval.py then fits
 * the gate on these and scores it on the real probes.
 *
 *   npx tsx tests/realstore-eval/synthetic-calibration.ts
 */
import Database from 'better-sqlite3';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const AGENT = 'work';
const now = Date.parse('2026-08-24T09:27:21.841Z');
let seed = 20261029;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

const STOP = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that not but all any can will would should could into than then there their they them its also only just more most some such very via per use used using new now one two'.split(' '));
const ro = new Database(SNAP, { readonly: true });
const rows = ro.prepare(`SELECT id, concept, content FROM engrams WHERE agent_id = ? AND stage = 'active' AND retracted = 0
  AND (superseded_by IS NULL OR superseded_by = '')`).all(AGENT) as Array<{ id: string; concept: string; content: string }>;
const tok = (s: string) => (s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((t) => !STOP.has(t));
const df = new Map<string, number>();
for (const r of rows) for (const t of new Set(tok(`${r.concept} ${r.content}`))) df.set(t, (df.get(t) ?? 0) + 1);
const vocab = [...df.entries()].filter(([, n]) => n >= 2 && n <= 200).map(([t]) => t);
ro.close();

/** The k rarest words of a memory that still occur elsewhere (df >= 2), like the fixtures' subjects. */
const distinctive = (r: { concept: string; content: string }, k: number) =>
  [...new Set(tok(`${r.concept} ${r.content}`))].filter((t) => (df.get(t) ?? 0) >= 2)
    .sort((a, b) => (df.get(a)! - df.get(b)!)).slice(0, k);

type S = { pop: 'syn-pos' | 'syn-null-mixed' | 'syn-null-random'; query: string; goldId: string | null };
const probes: S[] = [];
// Built the way the real fixtures are: a memory's title words plus one term unique to it.
const conceptWords = (r: { concept: string }, k: number) => tok(r.concept).slice(0, k);
const uniqueTerm = (r: { concept: string; content: string }) =>
  [...new Set(tok(`${r.concept} ${r.content}`))].find((t) => df.get(t) === 1 && /\d|_/.test(t) === false && t.length >= 6);
while (probes.filter((p) => p.pop === 'syn-pos').length < 300) {
  const r = pick(rows); const cw = conceptWords(r, 3); const u = uniqueTerm(r);
  if (cw.length >= 2 && u) probes.push({ pop: 'syn-pos', query: [...cw, u].join(' '), goldId: r.id });
}
// Familiar null: title words of two unrelated memories, mixed — every word real, no such fact.
while (probes.filter((p) => p.pop === 'syn-null-mixed').length < 200) {
  const a = pick(rows), b = pick(rows);
  const wa = conceptWords(a, 2), wb = conceptWords(b, 2);
  if (wa.length === 2 && wb.length === 2 && !wa.some((t) => wb.includes(t))) {
    probes.push({ pop: 'syn-null-mixed', query: [wa[0], wb[0], wa[1], wb[1]].join(' '), goldId: null });
  }
}
for (let i = 0; i < 100; i++) probes.push({ pop: 'syn-null-random', query: [pick(vocab), pick(vocab), pick(vocab)].join(' '), goldId: null });

const work = join(tmpdir(), `awm-syn-${process.pid}.db`);
copyFileSync(SNAP, work);
const store = new EngramStore(work);
const eng = new ActivationEngine(store as any);
const out: any[] = [];
for (const p of probes) {
  const res: any[] = await eng.activate({ internal: true, now, asOf: now, agentId: AGENT, context: p.query, limit: 10, minScore: 0.05, requireConfidence: 0 } as any);
  const ps = (k: number) => res[k]?.phaseScores ?? {};
  out.push({ ...p, n: res.length, top1Correct: !!p.goldId && res[0]?.engram.id === p.goldId,
    rr1: ps(0).rerankerScore ?? 0, rr2: ps(1).rerankerScore ?? 0, vec1: ps(0).vectorMatch ?? 0 });
}
store.close();
writeFileSync(join(tmpdir(), 'awm-synthetic-calibration.json'), JSON.stringify(out));
const c = (k: string) => out.filter((r) => r.pop === k);
console.log(`synthetic: pos ${c('syn-pos').length} (gold #1 for ${c('syn-pos').filter((r) => r.top1Correct).length}) · null-mixed ${c('syn-null-mixed').length} · null-random ${c('syn-null-random').length}`);
process.exit(0);
