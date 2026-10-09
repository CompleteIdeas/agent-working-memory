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

async function inProcessRerank(args: { query: string; passages: string[] }): Promise<Array<{ index: number; score: number }>> {
  const { query, passages } = args;
  if (passages.length === 0) return [];
  await ensureLoaded();

  // Batch path
  try {
    const queries = passages.map(() => query);
    const inputs = tokenizer!(queries, {
      text_pair: passages,
      padding: true,
      truncation: true,
      return_tensors: 'pt',
    });
    const output = await model!(inputs);
    const logits = output.logits ?? output.last_hidden_state;
    const data = logits.data as Float32Array | number[];
    const results: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < passages.length; i++) {
      const rawLogit = Number(data[i] ?? 0);
      results.push({ index: i, score: sigmoid(rawLogit) });
    }
    results.sort((a, b) => b.score - a.score);
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
          return_tensors: 'pt',
        });
        const output = await model!(inputs);
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

// Register the in-process handler with the pool
registerInProcessHandlers({ rerank: inProcessRerank });

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
