// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * ML worker entry — runs INSIDE a worker_thread.
 *
 * Loaded once per worker, sets up the model for the assigned role
 * (embed | rerank | expand), then handles request messages from the
 * main thread via the parentPort.
 *
 * Protocol:
 *   Main thread → worker:  { id, op, args }    (op matches the worker's role)
 *   Worker → main thread:  { id, ok: true, result } or { id, ok: false, error }
 *   Worker → main thread:  { ready: true }     (one-time signal after model load)
 *   Main thread → worker:  { shutdown: true }  (drain queue, then terminate)
 *
 * The worker stays loaded — the model lives in memory for the worker's lifetime.
 */

import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('ml-worker-entry: must be loaded as a worker_thread');
}

type WorkerRole = 'embed' | 'rerank' | 'expand';
const role: WorkerRole = workerData?.role;
if (role !== 'embed' && role !== 'rerank' && role !== 'expand') {
  throw new Error(`ml-worker-entry: invalid role '${role}'`);
}

// --- Lazy model loaders (each worker loads only its own model) ---

let embedderPipeline: any = null;
let rerankerTokenizer: any = null;
let rerankerModel: any = null;
let expanderPipeline: any = null;

// Inside worker_threads we must use the WASM ONNX backend, not the native one.
// onnxruntime-node's native bindings store V8 handles that get invalidated when
// crossing isolate boundaries — calling from a worker crashes with
// `v8::HandleScope::CreateHandle()` failures. The WASM backend is V8-safe.
const WORKER_DEVICE = 'wasm' as const;

async function loadEmbedder(): Promise<void> {
  const { pipeline } = await import('@huggingface/transformers');
  const modelId = process.env.AWM_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5';
  embedderPipeline = await pipeline('feature-extraction', modelId, { dtype: 'fp32', device: WORKER_DEVICE });
}

async function loadReranker(): Promise<void> {
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
  const modelId = process.env.AWM_RERANKER_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2';
  rerankerTokenizer = await AutoTokenizer.from_pretrained(modelId);
  rerankerModel = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'fp32', device: WORKER_DEVICE });
}

async function loadExpander(): Promise<void> {
  const { pipeline } = await import('@huggingface/transformers');
  expanderPipeline = await pipeline('text2text-generation', 'Xenova/flan-t5-small', { dtype: 'fp32', device: WORKER_DEVICE });
}

// --- Per-role inference handlers ---

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

async function handleEmbed(args: { texts: string[]; pooling: 'cls' | 'mean'; dimensions: number }): Promise<number[][]> {
  if (!embedderPipeline) throw new Error('embedder not loaded');
  const { texts, pooling, dimensions } = args;
  if (texts.length === 0) return [];
  const result = await embedderPipeline(texts, { pooling, normalize: true });
  const data = result.data as Float32Array;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(data.slice(i * dimensions, (i + 1) * dimensions)));
  }
  return vectors;
}

interface RerankResult { index: number; score: number; }

async function handleRerank(args: { query: string; passages: string[] }): Promise<RerankResult[]> {
  if (!rerankerTokenizer || !rerankerModel) throw new Error('reranker not loaded');
  const { query, passages } = args;
  if (passages.length === 0) return [];

  // Batch path
  try {
    const queries = passages.map(() => query);
    const inputs = rerankerTokenizer(queries, {
      text_pair: passages,
      padding: true,
      truncation: true,
      return_tensors: 'pt',
    });
    const output = await rerankerModel(inputs);
    const logits = output.logits ?? output.last_hidden_state;
    const data = logits.data as Float32Array | number[];
    const results: RerankResult[] = [];
    for (let i = 0; i < passages.length; i++) {
      const rawLogit = Number(data[i] ?? 0);
      results.push({ index: i, score: sigmoid(rawLogit) });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  } catch {
    // Per-passage fallback
    const results: RerankResult[] = [];
    for (let i = 0; i < passages.length; i++) {
      try {
        const inputs = rerankerTokenizer(query, {
          text_pair: passages[i],
          padding: true,
          truncation: true,
          return_tensors: 'pt',
        });
        const output = await rerankerModel(inputs);
        const logits = output.logits ?? output.last_hidden_state;
        const rawLogit = logits.data[0] as number;
        results.push({ index: i, score: sigmoid(rawLogit) });
      } catch {
        results.push({ index: i, score: 0 });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }
}

async function handleExpand(args: { prompt: string; maxNewTokens: number; noRepeatNgramSize: number }): Promise<string> {
  if (!expanderPipeline) throw new Error('expander not loaded');
  const result = await expanderPipeline(args.prompt, {
    max_new_tokens: args.maxNewTokens,
    no_repeat_ngram_size: args.noRepeatNgramSize,
  });
  const text = Array.isArray(result) ? (result[0] as any)?.generated_text ?? '' : '';
  return String(text).trim();
}

// --- Main loop ---

let shuttingDown = false;
const inflight = new Set<Promise<void>>();

async function loadModel(): Promise<void> {
  switch (role) {
    case 'embed': await loadEmbedder(); break;
    case 'rerank': await loadReranker(); break;
    case 'expand': await loadExpander(); break;
  }
}

async function handleMessage(msg: { id: number; op: WorkerRole; args: any }): Promise<void> {
  try {
    let result: unknown;
    switch (msg.op) {
      case 'embed':  result = await handleEmbed(msg.args); break;
      case 'rerank': result = await handleRerank(msg.args); break;
      case 'expand': result = await handleExpand(msg.args); break;
    }
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
}

(async () => {
  try {
    await loadModel();
    parentPort!.postMessage({ ready: true, role });
  } catch (err) {
    parentPort!.postMessage({ ready: false, role, error: String((err as Error)?.message ?? err) });
    process.exit(1);
  }
})();

parentPort.on('message', (msg: any) => {
  if (msg?.shutdown) {
    shuttingDown = true;
    // Wait for in-flight work, then exit
    void Promise.allSettled([...inflight]).then(() => {
      parentPort!.postMessage({ shutdown: 'done' });
      process.exit(0);
    });
    return;
  }
  if (shuttingDown) return;
  if (typeof msg?.id !== 'number' || typeof msg?.op !== 'string') return;

  const promise = handleMessage(msg);
  inflight.add(promise);
  void promise.finally(() => inflight.delete(promise));
});
