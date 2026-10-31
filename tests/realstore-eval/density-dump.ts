/**
 * Match density (Robert, 2026-10-30): how much of the store matches a query, as a measure of how
 * much the system knows about it, without retrieving anything. Per question, in the same order as
 * signal-dump.ts (calibration probes regenerated with the same seed, then the labelled probes):
 *   vector:  cosine of the query against EVERY retrievable memory of the agent ->
 *            counts at >= 0.5 / 0.6 / 0.7 / 0.8, top cosine, mean of the top 10, top-1 minus 10th
 *   BM25:    raw FTS5 score of the best match and the 10th (unnormalised, comparable across
 *            queries), how many memories match ANY content term and how many match ALL of them
 * For absent-familiar questions the deleted gold is left out, as gate-eval's copy does.
 *
 *   npx tsx tests/realstore-eval/density-dump.ts     -> %TEMP%/awm-density.json
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { embed } from '../../src/core/embeddings.js';
import { EngramStore } from '../../src/storage/sqlite.js';
import { buildCalibrationProbes } from '../../src/engine/abstention-calibration.js';

const dir = import.meta.dirname;
const SIG = JSON.parse(readFileSync(join(tmpdir(), 'awm-signals.json'), 'utf8'));
const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });

// Retrievable memories per agent, with unit vectors.
type Mem = { id: string; rowid: number; v: Float32Array };
const mems: Record<string, Mem[]> = {};
for (const r of db.prepare(`SELECT id, rowid, agent_id, embedding FROM engrams
    WHERE retracted = 0 AND stage = 'active' AND superseded_by IS NULL AND embedding IS NOT NULL`).iterate() as any) {
  const b: Buffer = r.embedding;
  const v = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  (mems[r.agent_id] ??= []).push({ id: r.id, rowid: r.rowid, v: Float32Array.from(v) });
}
const rowidOf = new Map(Object.values(mems).flat().map((m) => [m.rowid, m]));
const agentOf = new Map<number, string>();
for (const [a, ms] of Object.entries(mems)) for (const m of ms) agentOf.set(m.rowid, a);

const STOP = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that not but all any can will would should could into than then there their they them its we our i my you why about'.split(' '));
const terms = (q: string) => [...new Set(q.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];
const fts = db.prepare(`SELECT rowid, rank FROM engrams_fts WHERE engrams_fts MATCH ? ORDER BY rank LIMIT 2000`);

async function density(query: string, agent: string, exclude: string | null) {
  const qv = Float32Array.from(await embed(query));
  const cos: number[] = [];
  for (const m of mems[agent] ?? []) {
    if (m.id === exclude) continue;
    let s = 0; for (let i = 0; i < qv.length; i++) s += qv[i]! * m.v[i]!;
    cos.push(s);
  }
  cos.sort((a, b) => b - a);
  const at = (t: number) => cos.filter((c) => c >= t).length;
  const ts = terms(query);
  const run = (expr: string) => {
    if (!expr) return [] as Array<{ rank: number }>;
    try {
      return (fts.all(expr) as Array<{ rowid: number; rank: number }>)
        .filter((r) => agentOf.get(r.rowid) === agent && rowidOf.get(r.rowid)?.id !== exclude);
    } catch { return []; }
  };
  const any = run(ts.map((t) => `"${t}"`).join(' OR '));
  const all = ts.length > 1 ? run(ts.map((t) => `"${t}"`).join(' AND ')) : any;
  return {
    c50: at(0.5), c60: at(0.6), c70: at(0.7), c80: at(0.8),
    cTop: cos[0] ?? 0, cMean10: cos.slice(0, 10).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(10, cos.length)),
    cGap: (cos[0] ?? 0) - (cos[9] ?? 0),
    bTop: any[0] ? -any[0].rank : 0, b10: any[9] ? -any[9].rank : 0,
    nAny: any.length, nAll: all.length, nTerms: ts.length,
  };
}

const out: any = { calib: {}, probes: [] };
const work = join(tmpdir(), `awm-dens-${process.pid}.db`);
copyFileSync(join(dir, 'snapshot', 'store.db'), work);
const store = new EngramStore(work);
for (const agent of Object.keys(SIG.calib)) {
  const probes = await buildCalibrationProbes(store as any, agent, { seed: 20261029 });
  const qs = [...probes!.pos, ...probes!.nulls];
  if (qs.length !== SIG.calib[agent].length || qs.some((q, i) => q.goldId !== SIG.calib[agent][i].goldId)) throw new Error(`calibration probes for ${agent} do not line up with signal-dump`);
  out.calib[agent] = [];
  for (const q of qs) out.calib[agent].push(await density(q.query, agent, null));
  process.stderr.write(`calibration ${agent}: ${qs.length}\n`);
}
store.close();
// absent-familiar: the deleted gold is the item's original gold, recovered from the fixtures
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const goldByQuery = new Map<string, string>();
for (const f of ['fixture-category.json', 'fixture-nl.json']) for (const i of load(f).items) goldByQuery.set(`${i.agent ?? 'work'}|${i.query}`, i.goldId);
for (const [i, p] of (SIG.probes as any[]).entries()) {
  const exclude = p.pop === 'absent-familiar' ? goldByQuery.get(`${p.agent}|${p.query}`) ?? null : null;
  out.probes.push(await density(p.query, p.agent ?? 'work', exclude));
  if (i % 300 === 0) process.stderr.write(`probes ${i}/${SIG.probes.length}\n`);
}
writeFileSync(join(tmpdir(), 'awm-density.json'), JSON.stringify(out));
console.log(`wrote density for ${out.probes.length} probes`);
process.exit(0);
