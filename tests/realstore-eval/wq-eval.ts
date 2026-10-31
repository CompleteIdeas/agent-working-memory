/**
 * Write-time questions, step 2: does indexing "questions this memory answers" help retrieval?
 * On the fixed sample store of wq-generate.ts (every memory has questions), per fixture item
 * whose gold is in the sample:
 *   vector   note vector (shipped)  vs  max(note vector, question vectors)
 *   BM25     note text              vs  note text + questions (in-memory BM25, k1 1.2, b 0.75)
 *   fused    RRF(BM25, vector) in each condition
 * Reports s@1 / s@3 / in-top-32 and a bias check: word overlap between the gold's generated
 * questions and the fixture question, against the same overlap with random memories' questions.
 *
 *   npx tsx tests/realstore-eval/wq-eval.ts
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = true;
const dir = import.meta.dirname;
const WQ = JSON.parse(readFileSync(join(dir, process.env.WQ_FILE ?? 'nl-wq.json'), 'utf8')) as { sample: string[]; questions: Record<string, string[]> };
const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });
const get = db.prepare('SELECT id, agent_id, concept, content FROM engrams WHERE id = ?');
const docs = WQ.sample.filter((id) => WQ.questions[id]?.length).map((id) => get.get(id) as { id: string; agent_id: string; concept: string; content: string });
const idx = new Map(docs.map((d, i) => [d.id, i]));
const seeded = <T,>(arr: T[], seed = 1337): T[] => {
  const a = [...arr]; let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};
const fixtures = [
  { name: 'natural-language', items: JSON.parse(readFileSync(join(dir, 'fixture-nl.json'), 'utf8')).items as any[] },
  { name: 'identifier', items: seeded(JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')).items as any[]) },
  { name: 'topic', items: JSON.parse(readFileSync(join(dir, 'fixture-category.json'), 'utf8')).items as any[] },
].map((f) => ({ ...f, items: f.items.filter((i) => idx.has(i.goldId)).map((i) => ({ query: i.query as string, goldId: i.goldId as string, agent: (i.agent ?? 'work') as string })) }));

// ── embeddings (cached per sample) ──
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'fp32' });
async function embedAll(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const t = await extractor(texts.slice(i, i + 32), { pooling: 'mean', normalize: true });
    const dim = t.dims[t.dims.length - 1];
    for (let r = 0; r < t.dims[0]; r++) out.push(Float32Array.from(t.data.slice(r * dim, (r + 1) * dim)));
  }
  return out;
}
const cacheF = join(tmpdir(), `awm-wq-vec-${(process.env.WQ_FILE ?? "nl-wq.json").replace(/\W/g, "_")}-${docs.length}.json`);
let noteV: Float32Array[], qV: Float32Array[][];
if (existsSync(cacheF)) {
  const c = JSON.parse(readFileSync(cacheF, 'utf8'));
  noteV = c.note.map((a: number[]) => Float32Array.from(a)); qV = c.q.map((qs: number[][]) => qs.map((a) => Float32Array.from(a)));
} else {
  noteV = await embedAll(docs.map((d) => `${d.concept}\n${d.content}`));
  const flat = docs.flatMap((d) => WQ.questions[d.id]!);
  const fv = await embedAll(flat);
  let k = 0; qV = docs.map((d) => WQ.questions[d.id]!.map(() => fv[k++]!));
  writeFileSync(cacheF, JSON.stringify({ note: noteV.map((a) => Array.from(a)), q: qV.map((qs) => qs.map((a) => Array.from(a))) }));
}
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

// ── BM25 ──
const STOP = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that not but all any can will would should could into than then there their they them its we our i my you why about'.split(' '));
const toks = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
function bm25Index(texts: string[]) {
  const tf = texts.map((t) => { const m = new Map<string, number>(); for (const w of toks(t)) m.set(w, (m.get(w) ?? 0) + 1); return m; });
  const len = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0)), avg = len.reduce((a, b) => a + b, 0) / len.length;
  const df = new Map<string, number>(); for (const m of tf) for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const N = texts.length;
  return (q: string, i: number) => {
    let s = 0;
    for (const w of new Set(toks(q))) {
      const f = tf[i]!.get(w); if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w)! + 0.5) / (df.get(w)! + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * len[i]! / avg));
    }
    return s;
  };
}
const bmNote = bm25Index(docs.map((d) => `${d.concept} ${d.content}`));
const bmQ = bm25Index(docs.map((d) => `${d.concept} ${d.content} ${WQ.questions[d.id]!.join(' ')}`));

// ── evaluate ──
type Arm = (q: string, qv: Float32Array, i: number) => number;
const rankList = (scores: number[], agentOk: boolean[]) => scores.map((s, i) => [s, i] as const).filter(([, i]) => agentOk[i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
const ARMS: Record<string, { kind: 'single'; f: Arm } | { kind: 'rrf'; a: Arm; b: Arm; c?: Arm }> = {
  'fused3: BM25 note + vec note + vec questions': { kind: 'rrf', a: (q, _, i) => bmNote(q, i), b: (_, qv, i) => dot(qv, noteV[i]!), c: (_, qv, i) => Math.max(...qV[i]!.map((v) => dot(qv, v))) },
  'vector: note (shipped)': { kind: 'single', f: (_, qv, i) => dot(qv, noteV[i]!) },
  'vector: note + questions': { kind: 'single', f: (_, qv, i) => Math.max(dot(qv, noteV[i]!), ...qV[i]!.map((v) => dot(qv, v))) },
  'vector: questions only': { kind: 'single', f: (_, qv, i) => Math.max(...qV[i]!.map((v) => dot(qv, v))) },
  'BM25: note (shipped)': { kind: 'single', f: (q, _, i) => bmNote(q, i) },
  'BM25: note + questions': { kind: 'single', f: (q, _, i) => bmQ(q, i) },
  'fused: note (shipped)': { kind: 'rrf', a: (q, _, i) => bmNote(q, i), b: (_, qv, i) => dot(qv, noteV[i]!) },
  'fused: BM25 note+q, vector note': { kind: 'rrf', a: (q, _, i) => bmQ(q, i), b: (_, qv, i) => dot(qv, noteV[i]!) },
  'fused: note + questions': { kind: 'rrf', a: (q, _, i) => bmQ(q, i), b: (_, qv, i) => Math.max(dot(qv, noteV[i]!), ...qV[i]!.map((v) => dot(qv, v))) },
};
console.log(`sample store: ${docs.length} memories, each with ${(docs.reduce((a, d) => a + WQ.questions[d.id]!.length, 0) / docs.length).toFixed(1)} questions`);
console.log('arm                          ' + fixtures.map((f) => `${f.name} (${f.items.length}) s@1/s@3/in32`.padStart(38)).join(''));
const qvecs = new Map<string, Float32Array[]>();
for (const f of fixtures) qvecs.set(f.name, await embedAll(f.items.map((i) => i.query)));
for (const [name, arm] of Object.entries(ARMS)) {
  const cells: string[] = [];
  for (const f of fixtures) {
    let s1 = 0, s3 = 0, s32 = 0;
    f.items.forEach((it, k) => {
      const qv = qvecs.get(f.name)![k]!, ok = docs.map((d) => d.agent_id === it.agent);
      let order: number[];
      if (arm.kind === 'single') order = rankList(docs.map((_, i) => arm.f(it.query, qv, i)), ok);
      else {
        const ra = rankList(docs.map((_, i) => arm.a(it.query, qv, i)), ok), rb = rankList(docs.map((_, i) => arm.b(it.query, qv, i)), ok);
        const r = new Map<number, number>();
        ra.forEach((i, p) => r.set(i, (r.get(i) ?? 0) + 1 / (60 + p))); rb.forEach((i, p) => r.set(i, (r.get(i) ?? 0) + 1 / (60 + p)));
        if (arm.c) rankList(docs.map((_, i) => arm.c!(it.query, qv, i)), ok).forEach((i, p) => r.set(i, (r.get(i) ?? 0) + 1 / (60 + p)));
        order = [...r.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
      }
      const p = order.indexOf(idx.get(it.goldId)!);
      if (p === 0) s1++; if (p >= 0 && p < 3) s3++; if (p >= 0 && p < 32) s32++;
    });
    const n = f.items.length || 1;
    cells.push(`${(100 * s1 / n).toFixed(1)} / ${(100 * s3 / n).toFixed(1)} / ${(100 * s32 / n).toFixed(1)}`.padStart(38));
  }
  console.log(`${name.padEnd(29)}${cells.join('')}`);
}

// ── bias check ──
const jac = (a: string, b: string) => { const A = new Set(toks(a)), B = new Set(toks(b)); let i = 0; for (const w of A) if (B.has(w)) i++; return i / (A.size + B.size - i || 1); };
const nlItems = fixtures[0]!.items;
const goldOv = nlItems.map((it) => Math.max(...WQ.questions[it.goldId]!.map((g) => jac(g, it.query))));
const randOv = nlItems.map((it, k) => { const d = docs[(k * 7919) % docs.length]!; return Math.max(...WQ.questions[d.id]!.map((g) => jac(g, it.query))); });
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`\nbias check (NL): word overlap of the gold's generated questions with the fixture question ${mean(goldOv).toFixed(3)} vs a random memory's ${mean(randOv).toFixed(3)}; overlap > 0.5 for ${goldOv.filter((v) => v > 0.5).length}/${goldOv.length}`);
process.exit(0);
