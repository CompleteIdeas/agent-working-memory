/**
 * Offline embedding A/B: does the dense channel improve with a different pooling, a query
 * instruction, or a different small model? Measures vector-search ALONE (no BM25, no reranker),
 * because that is the channel natural-language questions depend on: on the 194-question
 * natural-language fixture it scored 22.7% s@1 with the shipped configuration.
 *
 * Nothing in the store changes. Each variant re-embeds the retrievable work + personal memories
 * of the frozen snapshot into a cache file, then scores each fixture by cosine top-k.
 *
 *   npx tsx tests/realstore-eval/embed-ab.ts [variant ...]
 *   variants: bge-mean (shipped), bge-cls, bge-cls-instr, bge-mean-instr, e5-small, gte-small, arctic-s, gemma-300m
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = true;
const dir = import.meta.dirname;
const BGE_INSTR = 'Represent this sentence for searching relevant passages: ';

type Variant = { id: string; model: string; pooling: 'mean' | 'cls'; queryPrefix: string; docPrefix: string; batch?: number };
const VARIANTS: Record<string, Variant> = {
  'bge-mean':       { id: 'bge-mean', model: 'Xenova/bge-small-en-v1.5', pooling: 'mean', queryPrefix: '', docPrefix: '' },
  'bge-cls':        { id: 'bge-cls', model: 'Xenova/bge-small-en-v1.5', pooling: 'cls', queryPrefix: '', docPrefix: '' },
  'bge-cls-instr':  { id: 'bge-cls-instr', model: 'Xenova/bge-small-en-v1.5', pooling: 'cls', queryPrefix: BGE_INSTR, docPrefix: '' },
  'bge-mean-instr': { id: 'bge-mean-instr', model: 'Xenova/bge-small-en-v1.5', pooling: 'mean', queryPrefix: BGE_INSTR, docPrefix: '' },
  'e5-small':       { id: 'e5-small', model: 'Xenova/e5-small-v2', pooling: 'mean', queryPrefix: 'query: ', docPrefix: 'passage: ' },
  'gte-small':      { id: 'gte-small', model: 'Xenova/gte-small', pooling: 'mean', queryPrefix: '', docPrefix: '' },
  // Google's on-device embedder (308M, 768-d, 2k context). Prompts from its model card.
  'gemma-300m':     { id: 'gemma-300m', model: 'onnx-community/embeddinggemma-300m-ONNX', pooling: 'mean', queryPrefix: 'task: search result | query: ', docPrefix: 'title: none | text: ', batch: 4 },
  'arctic-s':       { id: 'arctic-s', model: 'Snowflake/snowflake-arctic-embed-s', pooling: 'cls', queryPrefix: BGE_INSTR, docPrefix: '' },
};

const seeded = <T,>(arr: T[], seed = 1337): T[] => {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};
const fixtures: Array<{ name: string; items: Array<{ query: string; goldId: string; agent: string }> }> = [
  { name: 'natural-language', items: JSON.parse(readFileSync(join(dir, 'fixture-nl.json'), 'utf8')).items },
  { name: 'identifier', items: seeded(JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')).items).slice(0, 300) },
  { name: 'topic', items: JSON.parse(readFileSync(join(dir, 'fixture-category.json'), 'utf8')).items },
].map((f) => ({ ...f, items: f.items.map((i: any) => ({ query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })) }));

const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });
const docs = db.prepare(`SELECT id, agent_id, concept, content FROM engrams WHERE agent_id IN ('work','personal')
  AND stage = 'active' AND retracted = 0 AND (superseded_by IS NULL OR superseded_by = '')`).all() as Array<{ id: string; agent_id: string; concept: string; content: string }>;
db.close();

const cacheDir = join(tmpdir(), 'awm-embed-ab'); mkdirSync(cacheDir, { recursive: true });
const norm = (v: Float32Array) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };

async function embedAll(extractor: any, texts: string[], pooling: 'mean' | 'cls', batch = 32): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const t = await extractor(texts.slice(i, i + batch), { pooling, normalize: true });
    const dim = t.dims[t.dims.length - 1];
    for (let r = 0; r < t.dims[0]; r++) out.push(Float32Array.from(t.data.slice(r * dim, (r + 1) * dim)));
    if (i % 1024 === 0) process.stderr.write(`    ${i}/${texts.length}\r`);
  }
  return out;
}

const requested = process.argv.slice(2).length ? process.argv.slice(2) : ['bge-mean', 'bge-cls', 'bge-cls-instr', 'bge-mean-instr'];
console.log(`corpus: ${docs.length} retrievable memories (work + personal)`);
console.log('variant           ' + fixtures.map((f) => `${f.name} s@1 / s@3`.padStart(26)).join(''));
for (const name of requested) {
  const v = VARIANTS[name];
  if (!v) { console.log(`unknown variant ${name}`); continue; }
  const t0 = Date.now();
  let extractor: any;
  try { extractor = await pipeline('feature-extraction', v.model, { dtype: 'fp32' }); }
  catch (e) { console.log(`${name.padEnd(18)}could not load ${v.model}: ${(e as Error).message.slice(0, 100)}`); continue; }
  const cache = join(cacheDir, `${v.model.replace(/\W/g, '_')}-${v.pooling}-${v.docPrefix ? 'dp' : 'nodp'}.json`);
  let dvec: Float32Array[];
  if (existsSync(cache)) dvec = (JSON.parse(readFileSync(cache, 'utf8')) as number[][]).map((a) => Float32Array.from(a));
  else {
    dvec = await embedAll(extractor, docs.map((d) => `${v.docPrefix}${d.concept}\n${d.content}`), v.pooling, v.batch);
    writeFileSync(cache, JSON.stringify(dvec.map((a) => Array.from(a, (x) => Math.round(x * 1e5) / 1e5))));
  }
  const cells: string[] = [];
  for (const f of fixtures) {
    const qv = await embedAll(extractor, f.items.map((i) => `${v.queryPrefix}${i.query}`), v.pooling, v.batch);
    let s1 = 0, s3 = 0;
    f.items.forEach((it, qi) => {
      const q = qv[qi]!;
      const scored: Array<[number, string]> = [];
      docs.forEach((d, di) => {
        if (d.agent_id !== it.agent) return;
        const dv = dvec[di]!; let s = 0;
        for (let k = 0; k < q.length; k++) s += q[k]! * dv[k]!;
        scored.push([s, d.id]);
      });
      scored.sort((a, b) => b[0] - a[0]);
      const idx = scored.slice(0, 3).findIndex(([, id]) => id === it.goldId);
      if (idx === 0) s1++; if (idx >= 0) s3++;
    });
    cells.push(`${(100 * s1 / f.items.length).toFixed(1)}% / ${(100 * s3 / f.items.length).toFixed(1)}%`.padStart(26));
  }
  console.log(`${name.padEnd(18)}${cells.join('')}   (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
process.exit(0);
