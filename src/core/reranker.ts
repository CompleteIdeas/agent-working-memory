// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-Encoder Re-Ranker - scores (query, passage) pairs for relevance.
 *
 * Uses Xenova/ms-marco-MiniLM-L-6-v2 (~22MB ONNX) trained on MS-MARCO
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

const DEFAULT_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const MODEL_ID = process.env.AWM_RERANKER_MODEL || DEFAULT_MODEL;

// --- In-process fallback ---

let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
let initPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (tokenizer && model) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: 'fp32' });
    console.log(`Re-ranker model loaded in-process: ${MODEL_ID}`);
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
