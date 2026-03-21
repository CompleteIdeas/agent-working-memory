// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Query Expander — rewrites queries with synonyms and related terms.
 *
 * Uses Xenova/flan-t5-small (~80MB ONNX) to expand search queries
 * with related terms that improve BM25 recall.
 *
 * Example: "What is Caroline's identity?" →
 *   "What is Caroline's identity? Caroline personal gender transgender self"
 *
 * Singleton pattern — call getExpander() to get the shared instance.
 */

import { pipeline, type Text2TextGenerationPipeline } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/flan-t5-small';

let instance: Text2TextGenerationPipeline | null = null;
let initPromise: Promise<Text2TextGenerationPipeline> | null = null;

/**
 * Get or initialize the text generation pipeline (singleton).
 * First call downloads the model (~80MB), subsequent calls are instant.
 */
export async function getExpander(): Promise<Text2TextGenerationPipeline> {
  if (instance) return instance;
  if (initPromise) return initPromise;

  initPromise = pipeline('text2text-generation', MODEL_ID, {
    dtype: 'fp32',
  }).then(pipe => {
    instance = pipe as Text2TextGenerationPipeline;
    console.log(`Query expander loaded: ${MODEL_ID}`);
    return instance;
  });

  return initPromise;
}

/**
 * Expand a query with related terms and synonyms.
 * Returns the original query + generated expansion terms.
 * Falls back to the original query on any error.
 */
export async function expandQuery(originalQuery: string): Promise<string> {
  try {
    const expander = await getExpander();
    const prompt = `Expand this search query with synonyms and related terms. Only output the additional terms, not the original query. Query: ${originalQuery}. Additional terms:`;

    const result = await expander(prompt, {
      max_new_tokens: 25,
      no_repeat_ngram_size: 2,
    });

    const expanded = Array.isArray(result) ? (result[0] as any)?.generated_text ?? '' : '';
    const cleanExpanded = expanded.trim();

    if (cleanExpanded && cleanExpanded.length > 2) {
      return `${originalQuery} ${cleanExpanded}`;
    }
    return originalQuery;
  } catch {
    return originalQuery;
  }
}
