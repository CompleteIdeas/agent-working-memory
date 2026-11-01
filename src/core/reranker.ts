// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-Encoder Re-Ranker - scores (query, passage) pairs for relevance.
 *
 * Uses Xenova/ms-marco-MiniLM-L-6-v2 (91MB ONNX at the fp32 default; the 23MB
 * quantized file is what AWM_RERANKER_DTYPE=q8 loads) trained on MS-MARCO
 * passage ranking. Unlike bi-encoders, cross-encoders see both query and
 * passage together via full attention - much better at judging if a
 * passage actually answers a question.
 *
 * AWM 0.8.x: inference dispatches through ml-worker.ts (currently in-process
 * — see ml-worker.ts for the worker_threads → in-process revert rationale).
 */

import {
  AutoTokenizer,
  AutoModel,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from '@huggingface/transformers';
import { dispatchRerank, registerInferenceConfig, registerInProcessHandlers } from './ml-worker.js';
import { ensureModelCacheDir } from './model-cache.js';
import { loadStHead, type StHead } from './st-head.js';

const DEFAULT_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const MODEL_ID = process.env.AWM_RERANKER_MODEL || DEFAULT_MODEL;

/**
 * Weight precision for the cross-encoder. fp32 is the shipped default and the
 * only value any published number was measured at.
 *
 * It is exposed because the cross-encoder is 83% of warm recall latency
 * (measured, `npm run profile:recall`), which makes precision the largest
 * single latency lever in the system — and an unmeasurable one while it was a
 * literal. RE-MEASURED 2026-10-09 on the pipeline that ships: 'q8' cuts total
 * recall latency 26-33% across three suites, for ONE QUERY in 450 — identifier
 * success@1 unchanged at 93.0%, topic 92.2% -> 92.0%. Correct abstention is
 * unmoved on all three suites; success@5 is unmoved on both private suites and
 * moves +0.5pp on the public corpus, inside its 4pp seed-noise floor. It is deterministic (two runs agree
 * on all 450 queries to 1e-6), and because no model is bundled it SHRINKS the
 * first-run fetch: the ONNX file it loads is 23MB against fp32's 91MB. 'q4' is dominated: equal
 * accuracy, only -3% latency, 6.1s cold start against fp32's 1.6s. The default
 * is untouched because it is a product decision, not because the cost is
 * unknown; see docs/recall-latency.md.
 */
// Default q8 since 0.19 (Robert's decision, 2026-10-19, after the speed review). The
// cross-encoder is ~80% of a warm recall; q8 cut its p50 by 35–45% in an interleaved
// in-process comparison (378–492 ms against 684–1,051 ms for fp32) and 29–34% of total
// recall in the 2026-10-08 sweep, for 0.0 pp on identifier queries and −0.9 pp on topic
// queries with success@5 and abstention unchanged. Batch size 4/8/16 made no consistent
// difference in the same comparison, so RERANK_BATCH stays at 8. `AWM_RERANKER_DTYPE=fp32`
// restores the 0.18 ranker; every number published before 0.19 stands at fp32.
// One property changes at q8: a pair's score depends slightly on the other pairs in its
// batch (dynamic quantisation scales activations per batch) — measured max 0.00105 over 80
// pairs, top-1 unchanged, the order of near-zero tail scores reshuffled. fp32 is exact to
// 1e-5. For a given query and store the pool and its chunks are deterministic, so results
// are reproducible; what is lost is batch-independence, which tests/core/onnx-shape-caps
// asserts exactly at fp32 and to 5e-3 at q8.
const DTYPE = (process.env.AWM_RERANKER_DTYPE || 'q8') as 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4';

/**
 * 0.22: a second cross-encoder for NATURAL-LANGUAGE queries (src/core/query-shape.ts).
 * Measured 2026-11-01 on the real-store snapshot with questions indexed (k=3, top-1):
 *   Ettin-17m q8 on natural questions  53.6% vs MiniLM 50.0%
 *   Ettin-17m on topic lookups         93.3% vs MiniLM 96.0%  (so keyword queries keep MiniLM)
 *   recall p50 unchanged (~300 ms both, measured back to back)
 * Default Ettin-17m (on since 0.22; its HF repo ships int8 as model_quint8_avx2 / model_qint8_arm64,
 * loaded by the fallback in load(): natural 52.6 with that file, recall speed unchanged).
 * 'off' = one model for every query (0.21 behaviour). Its scores saturate near 1, so
 * recall blends its RANK, not its score, with the fused order (activation.ts).
 */
const DEFAULT_NATURAL_MODEL = 'cross-encoder/ettin-reranker-17m-v1';
const NATURAL_MODEL_RAW = (process.env.AWM_RERANKER_MODEL_NATURAL ?? DEFAULT_NATURAL_MODEL).trim();
const NATURAL_MODEL_ID: string | null =
  NATURAL_MODEL_RAW && NATURAL_MODEL_RAW !== 'off' && NATURAL_MODEL_RAW !== MODEL_ID ? NATURAL_MODEL_RAW : null;

/** The natural-language cross-encoder, or null when every query uses the main one. */
export function naturalRerankerModel(): string | null {
  return NATURAL_MODEL_ID;
}
export function mainRerankerModel(): string {
  return MODEL_ID;
}

// --- In-process inference, one loaded state per model ---

interface LoadedReranker {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
  /** Scoring head for a cross-encoder whose ONNX file is only the backbone (see st-head.ts). */
  head: StHead | null;
}
const loaded = new Map<string, Promise<LoadedReranker>>();
/** A natural model that failed to load: its queries use the main model, reported once. */
let naturalFailed = false;

function load(modelId: string): Promise<LoadedReranker> {
  let p = loaded.get(modelId);
  if (p) return p;
  p = (async () => {
    ensureModelCacheDir();
    const tokenizer = await AutoTokenizer.from_pretrained(modelId);
    // The default model is a plain sequence classifier; only another model is checked for a
    // sentence-transformers head, so the default path makes no extra request.
    const head = modelId === DEFAULT_MODEL ? null : await loadStHead(modelId);
    const Loader = head ? AutoModel : AutoModelForSequenceClassification;
    let dtype = DTYPE;
    let model: PreTrainedModel;
    try {
      model = await Loader.from_pretrained(modelId, { dtype });
    } catch (err) {
      // A model that ships no model_quantized.onnx cannot load at the q8 default. Many
      // sentence-transformers exports (the Ettin rerankers among them) ship int8 files under
      // hardware names instead: model_quint8_avx2.onnx (any x86-64 CPU with AVX2) and
      // model_qint8_arm64.onnx. Try the one for this CPU, then fp32, rather than leave recall
      // without a ranker. transformers.js appends no suffix at dtype fp32, so the named file loads as is.
      if (dtype === 'fp32') throw err;
      const hwFile = process.arch === 'arm64' ? 'model_qint8_arm64' : process.arch === 'x64' ? 'model_quint8_avx2' : null;
      let hwLoaded = false;
      if (hwFile && (dtype === 'q8' || dtype === 'int8' || dtype === 'uint8')) {
        try {
          model = await Loader.from_pretrained(modelId, { dtype: 'fp32', model_file_name: hwFile } as any);
          dtype = hwFile as any;
          hwLoaded = true;
        } catch { /* not shipped either: full precision below */ }
      }
      if (!hwLoaded) {
        console.error(`Re-ranker ${modelId} has no ${dtype} weights (${(err as Error).message.slice(0, 80)}); loading fp32`);
        dtype = 'fp32';
        model = await Loader.from_pretrained(modelId, { dtype });
      }
    }
    console.error(`Re-ranker model loaded in-process: ${modelId} (${dtype}${head ? `, ${head.pooling}-pooled head` : ''})`);
    return { tokenizer, model: model!, head };
  })();
  // A failed load is not cached: the next call retries (the network may be back).
  p.catch(() => loaded.delete(modelId));
  loaded.set(modelId, p);
  return p;
}

/** The model a call runs on: the natural one when asked for and loadable, else the main one. */
async function resolveModel(natural: boolean): Promise<LoadedReranker> {
  if (natural && NATURAL_MODEL_ID && !naturalFailed) {
    try {
      return await load(NATURAL_MODEL_ID);
    } catch (err) {
      naturalFailed = true;
      console.error(`Natural-language re-ranker ${NATURAL_MODEL_ID} failed to load (${(err as Error).message.slice(0, 120)}); natural queries use ${MODEL_ID}`);
    }
  }
  return load(MODEL_ID);
}

/** True when natural queries are actually scored by the natural model (configured and loaded). */
export function naturalRerankerActive(): boolean {
  return !!NATURAL_MODEL_ID && !naturalFailed;
}

/** One logit per pair: the classifier's own output, or the head applied to the token states. */
function pairLogits(output: any, inputs: any, n: number, head: StHead | null): number[] {
  if (head) {
    const h = output.last_hidden_state;
    const [, seq, dim] = h.dims as number[];
    const data = h.data as Float32Array;
    const mask = inputs.attention_mask?.data as ArrayLike<number | bigint> | undefined;
    return Array.from({ length: n }, (_, i) =>
      head.score(data.subarray(i * seq! * dim!, (i + 1) * seq! * dim!), seq!, dim!, mask ? Array.prototype.slice.call(mask, i * seq!, (i + 1) * seq!) : undefined));
  }
  const logits = output.logits ?? output.last_hidden_state;
  const data = logits.data as Float32Array | number[];
  return Array.from({ length: n }, (_, i) => Number(data[i] ?? 0));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Input-shape caps for the cross-encoder. They exist for MEMORY, and one of them also
 * fixes RANKING.
 *
 * onnxruntime-node keeps a CPU memory arena per model that grows to the largest tensor
 * it has ever run and never shrinks. A cross-encoder's attention tensor is
 * batch x heads x seq x seq floats, so its size is quadratic in the padded pair length.
 * Measured 2026-10-16 on AWM 0.17.0: six Claude Code sessions held 13.2 GB, JS heap flat
 * at ~85 MB, and one process reranking 24 long pairs kept ~1.75 GB after going idle.
 * The shapes come from the prime hook, which recalls with the WHOLE user prompt (pastes
 * included), and from recall's 24-40 passage pool: 40 pairs at 512 tokens make one
 * attention tensor of 40 x 12 x 512 x 512 x 4 B = ~500 MB.
 *
 * - AWM_RERANK_BATCH (default 8): passages are scored in chunks. A pair's score depends
 *   only on that pair (padding is masked), so this changes memory, not order.
 * - AWM_RERANK_QUERY_TOKENS (default 128): a longer query keeps its first and last
 *   halves. transformers.js truncates a too-long pair by cutting tokens off the END,
 *   which is the passage: before this cap, a ~510-token query left the passage no tokens
 *   at all, and every memory was scored against the query alone. Passages are already
 *   capped at ~400 chars (rerank-window.ts), so a 128-token query typically keeps a
 *   pair under ~260 tokens (more for CJK text or a raised AWM_RERANK_TRUNC).
 *
 * An explicit 0 disables a cap. Anything else that is not a non-negative integer (empty,
 * 'off', -1) falls back to the default, as AWM_RERANK_TRUNC does: a typo must not quietly
 * bring back the unbounded shape.
 */
function shapeCap(name: string, fallback: number): number {
  const v = Number(process.env[name]?.trim() || NaN);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}
const RERANK_BATCH = shapeCap('AWM_RERANK_BATCH', 8);
const RERANK_QUERY_TOKENS = shapeCap('AWM_RERANK_QUERY_TOKENS', 128);

/**
 * The query the cross-encoder sees: unchanged when it fits the cap, else its first and
 * last halves. Both ends, because a pasted prompt puts the question either before the
 * paste or after it. Special tokens typed into a long query ([SEP], [UNK]) are dropped by
 * the decode; a query under the cap passes through untouched.
 */
export function capRerankQuery(tok: PreTrainedTokenizer, query: string, maxTokens = RERANK_QUERY_TOKENS): string {
  if (maxTokens <= 0) return query;
  const ids = tok.encode(query, { add_special_tokens: false });
  if (ids.length <= maxTokens) return query;
  const head = Math.ceil(maxTokens / 2);
  const tail = maxTokens - head;
  const decode = (part: number[]) => tok.decode(part, { skip_special_tokens: true, clean_up_tokenization_spaces: true });
  // A tail that starts mid-word decodes with a leading '##' continuation marker, which
  // would re-encode as two stray '#' tokens.
  return tail > 0
    ? `${decode(ids.slice(0, head))} ${decode(ids.slice(ids.length - tail)).replace(/^##/, '')}`
    : decode(ids.slice(0, head));
}

async function scoreChunk(r: LoadedReranker, query: string, passages: string[], offset: number): Promise<Array<{ index: number; score: number }>> {
  const { tokenizer, model, head } = r;
  // Batch path
  try {
    const queries = passages.map(() => query);
    const inputs = tokenizer(queries, {
      text_pair: passages,
      padding: true,
      truncation: true,
      // NOT 'return_tensors'. That key never existed in transformers.js -- it is the
      // PyTorch Python spelling -- so from 0.5.2 (commit 1ccbf95, 2026-03-21) until
      // 2026-10-09 it was silently ignored and the library default
      // (return_tensor=true, i.e. Tensors) applied.
      // Stating it explicitly preserves exactly the behaviour that was already
      // running, and survives a future change of default. transformers 4.x turned
      // the typo into a type error, which is the only reason it was ever noticed.
      return_tensor: true,
    });
    const output = await model(inputs);
    return pairLogits(output, inputs, passages.length, head).map((l, i) => ({ index: offset + i, score: sigmoid(l) }));
  } catch {
    // Per-passage fallback (the original 0.7.13 path)
    const results: Array<{ index: number; score: number }> = [];
    let failures = 0, lastErr: unknown;
    for (let i = 0; i < passages.length; i++) {
      try {
        const inputs = tokenizer(query, {
          text_pair: passages[i],
          padding: true,
          truncation: true,
          // Same ignored-key story as the batch path above.
          return_tensor: true,
        });
        const output = await model(inputs);
        results.push({ index: offset + i, score: sigmoid(pairLogits(output, inputs, 1, head)[0]!) });
      } catch (err) {
        failures++; lastErr = err;
        results.push({ index: offset + i, score: 0 });
      }
    }
    // Every pair failing is a broken ranker, not a batch of irrelevant passages: say so,
    // instead of returning all-zero scores that look like a working ranker's verdict.
    if (failures === passages.length) throw lastErr;
    return results;
  }
}

/** Exported with its caps as parameters so tests can compare settings in one process. */
export async function inProcessRerank(
  args: { query: string; passages: string[]; natural?: boolean },
  caps: { batch?: number; queryTokens?: number } = {},
): Promise<Array<{ index: number; score: number }>> {
  const { passages } = args;
  if (passages.length === 0) return [];
  const r = await resolveModel(!!args.natural);
  const query = capRerankQuery(r.tokenizer, args.query, caps.queryTokens ?? RERANK_QUERY_TOKENS);
  const batch = caps.batch ?? RERANK_BATCH;
  const size = batch > 0 ? batch : passages.length;
  const results: Array<{ index: number; score: number }> = [];
  for (let b = 0; b < passages.length; b += size) {
    results.push(...await scoreChunk(r, query, passages.slice(b, b + size), b));
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// Register the in-process handler with the pool
registerInProcessHandlers({ rerank: (args) => inProcessRerank(args) });
registerInferenceConfig({
  rerankModel: MODEL_ID, rerankDtype: DTYPE, rerankBatch: RERANK_BATCH, rerankQueryTokens: RERANK_QUERY_TOKENS,
  ...(NATURAL_MODEL_ID ? { rerankModelNatural: NATURAL_MODEL_ID } : {}),
});

// --- Public API ---

/** Warms the cross-encoder(s); returns the main model. Kept for backwards compat. */
export async function getReranker(): Promise<any> {
  const main = await load(MODEL_ID);
  // Warm the natural model too, so the first natural query does not pay its load. A failure
  // here is reported by resolveModel and leaves natural queries on the main model.
  if (NATURAL_MODEL_ID) await resolveModel(true);
  return main.model;
}

export interface RerankResult {
  index: number;
  score: number; // sigmoid-normalized relevance (0-1)
}

/**
 * Re-rank candidate passages against a query using the cross-encoder.
 * Returns results sorted by relevance score (descending).
 * Dispatches to the worker pool (or in-process fallback).
 */
export async function rerank(query: string, passages: string[], opts: { natural?: boolean } = {}): Promise<RerankResult[]> {
  if (passages.length === 0) return [];
  // Only flag the call when a natural model exists, so a one-model setup sends exactly the
  // request it always did (and the model daemon's protocol is unchanged for it).
  return dispatchRerank(opts.natural && NATURAL_MODEL_ID ? { query, passages, natural: true } : { query, passages });
}
