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
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from '@huggingface/transformers';
import { dispatchRerank, registerInProcessHandlers } from './ml-worker.js';
import { ensureModelCacheDir } from './model-cache.js';

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
const DTYPE = (process.env.AWM_RERANKER_DTYPE || 'fp32') as 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4';

// --- In-process fallback ---

let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
let initPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (tokenizer && model) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    ensureModelCacheDir();
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: DTYPE });
    console.error(`Re-ranker model loaded in-process: ${MODEL_ID} (${DTYPE})`);
  })();
  return initPromise;
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

async function scoreChunk(query: string, passages: string[], offset: number): Promise<Array<{ index: number; score: number }>> {
  // Batch path
  try {
    const queries = passages.map(() => query);
    const inputs = tokenizer!(queries, {
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
    const output = await model!(inputs);
    const logits = output.logits ?? output.last_hidden_state;
    const data = logits.data as Float32Array | number[];
    const results: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < passages.length; i++) {
      const rawLogit = Number(data[i] ?? 0);
      results.push({ index: offset + i, score: sigmoid(rawLogit) });
    }
    return results;
  } catch {
    // Per-passage fallback (the original 0.7.13 path)
    const results: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < passages.length; i++) {
      try {
        const inputs = tokenizer!(query, {
          text_pair: passages[i],
          padding: true,
          truncation: true,
          // Same ignored-key story as the batch path above.
          return_tensor: true,
        });
        const output = await model!(inputs);
        const logits = output.logits ?? output.last_hidden_state;
        const rawLogit = logits.data[0] as number;
        results.push({ index: offset + i, score: sigmoid(rawLogit) });
      } catch {
        results.push({ index: offset + i, score: 0 });
      }
    }
    return results;
  }
}

/** Exported with its caps as parameters so tests can compare settings in one process. */
export async function inProcessRerank(
  args: { query: string; passages: string[] },
  caps: { batch?: number; queryTokens?: number } = {},
): Promise<Array<{ index: number; score: number }>> {
  const { passages } = args;
  if (passages.length === 0) return [];
  await ensureLoaded();
  const query = capRerankQuery(tokenizer!, args.query, caps.queryTokens ?? RERANK_QUERY_TOKENS);
  const batch = caps.batch ?? RERANK_BATCH;
  const size = batch > 0 ? batch : passages.length;
  const results: Array<{ index: number; score: number }> = [];
  for (let b = 0; b < passages.length; b += size) {
    results.push(...await scoreChunk(query, passages.slice(b, b + size), b));
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// Register the in-process handler with the pool
registerInProcessHandlers({ rerank: (args) => inProcessRerank(args) });

// --- Public API ---

/** Kept for backwards compat. */
export async function getReranker(): Promise<any> {
  await ensureLoaded();
  return model;
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
export async function rerank(query: string, passages: string[]): Promise<RerankResult[]> {
  if (passages.length === 0) return [];
  return dispatchRerank({ query, passages });
}
