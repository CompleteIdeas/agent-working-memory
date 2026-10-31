/**
 * What should a memory's vector represent? (Robert, 2026-10-30: compare the question to the
 * answer side, not to an average of the whole note.) Vector-only A/B on the frozen snapshot,
 * same corpus, model and fixtures as embed-ab.ts (bge-small, mean pooling), one vector shape at a
 * time:
 *   whole       concept + content, one vector per memory, 512-token cut        (shipped)
 *   title       concept only
 *   sentences   content split into ~300-char pieces, title as its own piece; a memory scores
 *               its best piece (the 512-token cut disappears)
 *   whole+title / whole+sentences   max of the two
 * Reports s@1 / s@3 and, since the first stage's job is to feed the shortlist, how often the gold
 * lands in the top 32. Piece embeddings are cached in %TEMP%/awm-embed-ab/.
 *
 *   npx tsx tests/realstore-eval/vector-shape-ab.ts
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = true;
const dir = import.meta.dirname;
const cacheDir = join(tmpdir(), 'awm-embed-ab'); mkdirSync(cacheDir, { recursive: true });
const seeded = <T,>(arr: T[], seed = 1337): T[] => {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};
const fixtures = [
  { name: 'natural-language', items: JSON.parse(readFileSync(join(dir, 'fixture-nl.json'), 'utf8')).items },
  { name: 'identifier', items: seeded(JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')).items as any[]).slice(0, 300) },
  { name: 'topic', items: JSON.parse(readFileSync(join(dir, 'fixture-category.json'), 'utf8')).items },
].map((f) => ({ ...f, items: f.items.map((i: any) => ({ query: i.query as string, goldId: i.goldId as string, agent: (i.agent ?? 'work') as string })) }));

const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });
const docs = db.prepare(`SELECT id, agent_id, concept, content FROM engrams WHERE agent_id IN ('work','personal')
  AND stage = 'active' AND retracted = 0 AND (superseded_by IS NULL OR superseded_by = '')`).all() as Array<{ id: string; agent_id: string; concept: string; content: string }>;
db.close();

async function embedAll(extractor: any, texts: string[], batch = 32): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const t = await extractor(texts.slice(i, i + batch), { pooling: 'mean', normalize: true });
    const dim = t.dims[t.dims.length - 1];
    for (let r = 0; r < t.dims[0]; r++) out.push(Float32Array.from(t.data.slice(r * dim, (r + 1) * dim)));
    if (i % 2048 === 0) process.stderr.write(`    ${i}/${texts.length}\r`);
  }
  return out;
}
async function cached(name: string, texts: () => string[], extractor: any): Promise<Float32Array[]> {
  const f = join(cacheDir, `${name}.json`);
  if (existsSync(f)) return (JSON.parse(readFileSync(f, 'utf8')) as number[][]).map((a) => Float32Array.from(a));
  const t0 = Date.now(); const v = await embedAll(extractor, texts());
  process.stderr.write(`  embedded ${v.length} ${name} in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  writeFileSync(f, JSON.stringify(v.map((a) => Array.from(a, (x) => Math.round(x * 1e5) / 1e5))));
  return v;
}

// Pieces: the title, then the content split at sentence ends into ~300-char runs.
function pieces(d: { concept: string; content: string }): string[] {
  const out = [d.concept];
  const sents = d.content.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  let cur = '';
  for (const s of sents) {
    if (cur && cur.length + s.length > 300) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'fp32' });
const whole = await cached('Xenova_bge_small_en_v1_5-mean-nodp', () => docs.map((d) => `${d.concept}\n${d.content}`), extractor);
const title = await cached('shape-title', () => docs.map((d) => d.concept), extractor);
const pieceOwner: number[] = []; const pieceTexts: string[] = [];
docs.forEach((d, i) => { for (const p of pieces(d)) { pieceOwner.push(i); pieceTexts.push(p); } });
process.stderr.write(`${docs.length} memories -> ${pieceTexts.length} pieces\n`);
const piece = await cached('shape-pieces-300', () => pieceTexts, extractor);
// best piece per memory, per query, needs a per-doc max; precompute piece index ranges
const pieceRange: Array<[number, number]> = docs.map(() => [0, 0]);
pieceOwner.forEach((o, pi) => { if (pieceRange[o]![1] === 0 && pieceRange[o]![0] === 0 && pi > 0) pieceRange[o]![0] = pi; pieceRange[o]![1] = pi + 1; });
pieceRange[0]![0] = 0;

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k]! * b[k]!; return s; };
type Scorer = (q: Float32Array, di: number) => number;
const SHAPES: Record<string, Scorer> = {
  'whole (shipped)': (q, di) => dot(q, whole[di]!),
  'title only': (q, di) => dot(q, title[di]!),
  'best sentence piece': (q, di) => { let m = -1; for (let pi = pieceRange[di]![0]; pi < pieceRange[di]![1]; pi++) m = Math.max(m, dot(q, piece[pi]!)); return m; },
  'max(whole, title)': (q, di) => Math.max(dot(q, whole[di]!), dot(q, title[di]!)),
  'max(whole, best piece)': (q, di) => { let m = dot(q, whole[di]!); for (let pi = pieceRange[di]![0]; pi < pieceRange[di]![1]; pi++) m = Math.max(m, dot(q, piece[pi]!)); return m; },
};

console.log('shape                     ' + fixtures.map((f) => `${f.name} s@1 / s@3 / in-32`.padStart(34)).join(''));
const qvecs = new Map<string, Float32Array[]>();
for (const f of fixtures) qvecs.set(f.name, await embedAll(extractor, f.items.map((i) => i.query)));
for (const [name, score] of Object.entries(SHAPES)) {
  const cells: string[] = [];
  for (const f of fixtures) {
    const qv = qvecs.get(f.name)!;
    let s1 = 0, s3 = 0, s32 = 0;
    f.items.forEach((it, qi) => {
      const scored: Array<[number, string]> = [];
      docs.forEach((d, di) => { if (d.agent_id === it.agent) scored.push([score(qv[qi]!, di), d.id]); });
      scored.sort((a, b) => b[0] - a[0]);
      const idx = scored.slice(0, 32).findIndex(([, id]) => id === it.goldId);
      if (idx === 0) s1++; if (idx >= 0 && idx < 3) s3++; if (idx >= 0) s32++;
    });
    const n = f.items.length;
    cells.push(`${(100 * s1 / n).toFixed(1)} / ${(100 * s3 / n).toFixed(1)} / ${(100 * s32 / n).toFixed(1)}`.padStart(34));
  }
  console.log(`${name.padEnd(26)}${cells.join('')}`);
}
process.exit(0);
