/**
 * Baselines for the real-store benchmark — what would a naive retriever score on the SAME task?
 *
 * Every retrieval figure AWM publishes should sit next to the number a trivial method gets on
 * the same probes; otherwise a high score may describe the benchmark rather than the product.
 * (Prompted by checking MemPalace's "96.6% R@5 raw" on LongMemEval, where 30 lines of BM25
 * scored 95.2% on the identical task: tests and notes in AWM memory f462ccfe.)
 *
 * Identical to runner.ts in everything that defines the task:
 *   - same snapshot (read-only here: no arm mutates anything), same fixture, same seeded
 *     shuffle (LCG seed 1337) and the same sample size `npm run bench` uses
 *     (identifier 300, category all 450)
 *   - same agent scoping (each probe queries as its gold's agent)
 *   - same retrievable population: active, not retracted, not superseded
 *   - same k = 3 (the shipped memory_recall default), so s@5 == s@3 here, as in the runner
 *
 * Arms:
 *   random   three random retrievable memories
 *   bm25     SQLite FTS5 bm25 over concept+content+tags, query tokens OR'ed — nothing else
 *   dense    cosine similarity of the query embedding (AWM's own model) to stored vectors
 *   rrf      textbook hybrid: reciprocal-rank fusion of bm25 and dense (k=60)
 *
 * Adversarial (absent-fact) probes: none of these arms can abstain — they always return k
 * results — so their correct-silence rate is 0/10 by construction. Reported, not computed.
 *
 *   npx tsx tests/realstore-eval/baselines.ts [fixture.json|fixture-category.json]
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embed } from '../../src/core/embeddings.js';

const FIXTURE = process.argv[2] ?? 'fixture.json';
const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const fx = JSON.parse(readFileSync(join(import.meta.dirname, FIXTURE), 'utf8'));
const LIMIT = FIXTURE === 'fixture.json' ? 300 : fx.items.length;
const K = 3;

type Item = { query: string; goldId: string; agent?: string };
const seeded = (arr: Item[], seed = 1337): Item[] => {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const items: Item[] = seeded(fx.items).slice(0, LIMIT);

const db = new Database(SNAP, { readonly: true, fileMustExist: true });
// BASELINE_RAW=1: give the baselines the WHOLE store (superseded, retracted, archived
// included) — what a plain retriever over a raw memory table sees, without AWM's lifecycle.
const RAW = process.env.BASELINE_RAW === '1';
const RETRIEVABLE = RAW ? `1 = 1` : `stage = 'active' AND retracted = 0 AND (superseded_by IS NULL OR superseded_by = '')`;
const staleIds = new Set((new Database(SNAP, { readonly: true }).prepare(
  `SELECT id FROM engrams WHERE retracted = 1 OR (superseded_by IS NOT NULL AND superseded_by != '') OR stage != 'active'`).all() as Array<{ id: string }>).map((r) => r.id));

// Per-agent pools with vectors, loaded once.
interface PoolRow { rowid: number; id: string; vec: Float32Array | null }
const pools = new Map<string, PoolRow[]>();
function pool(agent: string): PoolRow[] {
  let p = pools.get(agent);
  if (p) return p;
  p = (db.prepare(`SELECT rowid, id, embedding FROM engrams WHERE agent_id = ? AND ${RETRIEVABLE}`).all(agent) as any[])
    .map((r) => ({ rowid: r.rowid, id: r.id, vec: r.embedding ? new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)) : null }));
  pools.set(agent, p);
  return p;
}

function bm25(agent: string, query: string, n: number): string[] {
  const toks = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((t) => t.length > 1);
  if (!toks.length) return [];
  const match = toks.map((t) => `"${t}"`).join(' OR ');
  const rows = db.prepare(`
    SELECT e.id FROM engrams_fts f JOIN engrams e ON e.rowid = f.rowid
    WHERE engrams_fts MATCH ? AND e.agent_id = ? AND ${RETRIEVABLE.replace(/\b(stage|retracted|superseded_by)\b/g, 'e.$1')}
    ORDER BY bm25(engrams_fts) LIMIT ?`).all(match, agent, n) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
function dense(agent: string, qv: number[], n: number): string[] {
  return pool(agent).filter((r) => r.vec)
    .map((r) => ({ id: r.id, s: cosine(r.vec!, qv) }))
    .sort((a, b) => b.s - a.s).slice(0, n).map((r) => r.id);
}
function rrf(lists: string[][], n: number): string[] {
  const s = new Map<string, number>();
  for (const l of lists) l.forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (60 + i + 1)));
  return [...s].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}

let rngState = 42;
const rand = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 2 ** 32; };
function random(agent: string, n: number): string[] {
  const p = pool(agent); const out = new Set<string>();
  while (out.size < Math.min(n, p.length)) out.add(p[Math.floor(rand() * p.length)]!.id);
  return [...out];
}

const arms = ['random', 'bm25', 'dense', 'rrf'] as const;
const staleTop = { random: 0, bm25: 0, dense: 0, rrf: 0 } as Record<string, number>;
const tally = Object.fromEntries(arms.map((a) => [a, { s1: 0, s3: 0, rr: 0 }])) as Record<(typeof arms)[number], { s1: number; s3: number; rr: number }>;
let poolSizes: number[] = [];

for (const it of items) {
  const agent = it.agent ?? 'work';
  poolSizes.push(pool(agent).length);
  const qv = await embed(it.query);
  const b = bm25(agent, it.query, 50);
  const d = dense(agent, qv, 50);
  const results = { random: random(agent, K), bm25: b.slice(0, K), dense: d.slice(0, K), rrf: rrf([b, d], K) };
  for (const a of arms) {
    if (results[a][0] && staleIds.has(results[a][0])) staleTop[a]++;
    const idx = results[a].indexOf(it.goldId);
    if (idx === 0) tally[a].s1++;
    if (idx >= 0) { tally[a].s3++; tally[a].rr += 1 / (idx + 1); }
  }
}

const n = items.length;
const pct = (x: number) => `${(100 * x / n).toFixed(1)}%`;
console.log(`\nBASELINES · ${FIXTURE} · ${n} probes · k=${K} · retrievable pool per probe: ${Math.min(...poolSizes)}–${Math.max(...poolSizes)} memories`);
console.log('arm      s@1     s@3(=s@5 at k=3)   MRR');
for (const a of arms) console.log(`${a.padEnd(8)} ${pct(tally[a].s1).padStart(6)}   ${pct(tally[a].s3).padStart(6)}            ${pct(tally[a].rr).padStart(6)}`);
console.log('adversarial correct silence: 0/10 for every arm (none can abstain)');
if (RAW) console.log(`top answer was a superseded / retracted / non-active memory: ${arms.map((x) => `${x} ${pct(staleTop[x]!)}`).join(' · ')}`);
db.close();
process.exit(0);
