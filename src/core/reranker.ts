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
 */
export async function rerank(
  query: string,
  passages: string[],
): Promise<RerankResult[]> {
  if (passages.length === 0) return [];

  await ensureLoaded();

  const results: RerankResult[] = [];

  for (let i = 0; i < passages.length; i++) {
    try {
      // Tokenize as a query-passage PAIR using text_pair
      const inputs = tokenizer!(query, {
        text_pair: passages[i],
        padding: true,
        truncation: true,
        return_tensors: 'pt',
      });

      const output = await model!(inputs);

      // Model outputs raw logits — extract the single relevance logit
      const logits = output.logits ?? output.last_hidden_state;
      const rawLogit = logits.data[0] as number;

      // Apply sigmoid to map to 0-1 probability
      results.push({ index: i, score: sigmoid(rawLogit) });
    } catch {
      results.push({ index: i, score: 0 });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}
