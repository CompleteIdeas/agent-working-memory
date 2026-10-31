/**
 * Records every rerank-pool candidate's signals, per question, for:
 *   - the calibration probes calibrateGate() fits on (generated from the store alone), and
 *   - every labelled population gate-eval.ts scores: answerable (keyword fixtures and the
 *     natural-language fixture), absent-new, and absent-familiar (gold deleted from a copy).
 * signal-fit.ts then fits and compares gates and per-candidate probability rankers offline.
 *
 *   npx tsx tests/realstore-eval/signal-dump.ts      -> %TEMP%/awm-signals.json
 */
import Database from 'better-sqlite3';
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { buildCalibrationProbes } from '../../src/engine/abstention-calibration.js';

const dir = import.meta.dirname;
const SNAP = join(dir, 'snapshot', 'store.db');
const seeded = <T,>(arr: T[], seed = 1337): T[] => {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const ident = load('fixture.json'), cat = load('fixture-category.json'), absent = load('fixture-absent.json'), nl = load('fixture-nl.json');
const now = Date.parse('2026-08-24T09:27:21.841Z');

type P = { set: string; pop: string; query: string; goldId: string | null; agent: string };
const catItems = seeded(cat.items as any[]), nlItems = seeded(nl.items as any[]);
const intact: P[] = [
  ...seeded(ident.items as any[]).slice(0, 300).map((i) => ({ set: 'kw', pop: 'answerable', query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
  ...catItems.map((i) => ({ set: 'kw', pop: 'answerable', query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
  ...nlItems.map((i) => ({ set: 'nl', pop: 'answerable', query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
  ...[...absent.items, ...ident.adversarialItems].map((i: any) => ({ set: 'both', pop: 'absent-new', query: i.query, goldId: null, agent: 'work' })),
];
const famKw = catItems.slice(-200), famNl = nlItems.slice(-Math.min(100, Math.floor(nlItems.length / 2)));
const familiar: P[] = [
  ...famKw.map((i) => ({ set: 'kw', pop: 'absent-familiar', query: i.query, goldId: null, agent: i.agent ?? 'work' })),
  ...famNl.map((i) => ({ set: 'nl', pop: 'absent-familiar', query: i.query, goldId: null, agent: i.agent ?? 'work' })),
];

function open(deleteIds: string[] = []) {
  const work = join(tmpdir(), `awm-sig-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  copyFileSync(SNAP, work);
  if (deleteIds.length) {
    const d = new Database(work); const del = d.prepare('DELETE FROM engrams WHERE id = ?');
    d.transaction(() => { for (const id of deleteIds) del.run(id); })(); d.close();
  }
  const store = new EngramStore(work);
  return { store, eng: new ActivationEngine(store as any) };
}

async function record(eng: ActivationEngine, p: { query: string; agent: string }, limit: number) {
  let st: Record<string, string[]> = {}; let pool: any[] = [];
  const res: any[] = await eng.activate({ agentId: p.agent, context: p.query, limit, minScore: 0.05, requireConfidence: 0,
    internal: true, now, asOf: now, skipCalibratedGate: true,
    onStages: (s: any) => { st = s; }, onRerankScores: (x: any) => { pool = x; } } as any);
  const bRank = new Map((st.bm25 ?? []).map((id, i) => [id, i]));
  const vRank = new Map((st.vector ?? []).map((id, i) => [id, i]));
  return {
    top: res.map((r) => r.engram.id).slice(0, 3),
    nBm25: st.bm25?.length ?? 0, nVec: st.vector?.length ?? 0,
    // per candidate: cross-encoder score, composite, BM25-normalised text match, raw cosine,
    // rank in the BM25 list and in the vector list (-1 = not in it)
    pool: pool.map((c) => ({ id: c.id, rr: +c.rr.toFixed(5), comp: +c.composite.toFixed(5), text: +c.text.toFixed(5), cos: +c.vec.toFixed(5),
      b: bRank.get(c.id) ?? -1, v: vRank.get(c.id) ?? -1 })),
  };
}

const out: any = { calib: {}, probes: [] };
{
  const { store, eng } = open();
  for (const agent of ['work', 'personal']) {
    const probes = await buildCalibrationProbes(store as any, agent, { seed: 20261029 });
    if (!probes) continue;
    const rows: any[] = [];
    for (const p of [...probes.pos, ...probes.nulls]) rows.push({ goldId: p.goldId, ...(await record(eng, { query: p.query, agent }, 10)) });
    out.calib[agent] = rows;
    process.stderr.write(`calibration ${agent}: ${rows.length}\n`);
  }
  for (const [i, p] of intact.entries()) {
    out.probes.push({ ...p, ...(await record(eng, p, 3)) });
    if (i % 200 === 0) process.stderr.write(`intact ${i}/${intact.length}\n`);
  }
  store.close();
}
{
  const { store, eng } = open([...famKw, ...famNl].map((i: any) => i.goldId));
  for (const p of familiar) out.probes.push({ ...p, ...(await record(eng, p, 3)) });
  store.close();
}
writeFileSync(join(tmpdir(), 'awm-signals.json'), JSON.stringify(out));
console.log(`wrote ${out.probes.length} probes + calibration ${Object.values(out.calib).map((r: any) => r.length).join('/')}`);
process.exit(0);
