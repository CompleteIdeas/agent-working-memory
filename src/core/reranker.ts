// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-Encoder Re-Ranker — scores (query, passage) pairs for relevance.
 *
 * Uses Xenova/ms-marco-MiniLM-L-6-v2 (~22MB ONNX) which is trained on
 * MS-MARCO passage ranking. Unlike bi-encoders, cross-encoders see both
 * query and passage together via full attention — much better at judging
 * if a passage actually answers a question.
 *
 * Uses direct tokenizer + model inference (NOT the text-classification
 * pipeline, which doesn't support text_pair and returns identical scores).
 *
 * Singleton pattern — call getReranker() to get the shared instance.
 */

import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from '@huggingface/transformers';

const DEFAULT_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const MODEL_ID = process.env.AWM_RERANKER_MODEL || DEFAULT_MODEL;
let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
let initPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (tokenizer && model) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
      dtype: 'fp32',
    });
    console.log(`Re-ranker model loaded: ${MODEL_ID}`);
  })();

  return initPromise;
}

/** Kept for backwards compat — returns the model (unused externally). */
export async function getReranker(): Promise<any> {
  await ensureLoaded();
  return model;
}

export interface RerankResult {
  index: number;
  score: number; // sigmoid-normalized relevance (0-1)
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Re-rank candidate passages against a query using the cross-encoder.
 * Returns results sorted by relevance score (descending).
 *
 * Batch inference (0.7.14+): tokenizes all query-passage pairs in one call
 * and runs a single model forward pass. Previously the loop tokenized + ran
 * the model once per passage, which serialized 15-30 inference calls.
 * Batching is roughly 3-5× faster on transformers.js because the
 * tokenizer/model overhead amortizes.
 *
 * Falls back to per-passage scoring if the batch path errors (e.g. model
 * doesn't support batched text_pair).
 */
export async function rerank(
  query: string,
  passages: string[],
): Promise<RerankResult[]> {
  if (passages.length === 0) return [];

  await ensureLoaded();

  // Try batch inference first — much faster for typical pool sizes (15-30)
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

    // logits.data is [batch_size] when there's a single output dim
    const results: RerankResult[] = [];
    for (let i = 0; i < passages.length; i++) {
      const rawLogit = Number(data[i] ?? 0);
      results.push({ index: i, score: sigmoid(rawLogit) });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  } catch {
    // Fall back to per-passage loop (the original 0.7.13 path)
    const results: RerankResult[] = [];
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
