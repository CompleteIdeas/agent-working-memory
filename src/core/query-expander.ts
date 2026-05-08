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
 * LRU cache of normalized-query → expanded-query mappings.
 * Map preserves insertion order — re-set on hit moves entry to the end (most-recent),
 * delete-first when over capacity drops the least-recent. ~500 entries × ~200 chars
 * each ≈ 100KB, negligible memory cost.
 *
 * Why: phase-breakdown spike (2026-05-08) showed expandQuery at ~164ms per call.
 * Agent recall patterns repeat — cache hits are common.
 */
const expansionCache = new Map<string, string>();
const EXPANSION_CACHE_LIMIT = 500;

/**
 * Heuristic: skip expansion when the query is already specific.
 * Long, multi-token queries don't benefit from synonyms — they're already
 * narrow enough that flan-t5's general-vocabulary expansion adds noise more
 * than recall. Exact thresholds are conservative; false-skips would only
 * affect candidates that BM25 catches anyway.
 */
function shouldSkipExpansion(normalized: string): boolean {
  if (normalized.length === 0) return true;
  if (normalized.length > 50) return true;
  // ≥5 distinct meaningful tokens = already specific
  const tokens = new Set(normalized.split(/\s+/).filter(t => t.length > 2));
  return tokens.size >= 5;
}

/**
 * Expand a query with related terms and synonyms.
 * Returns the original query + generated expansion terms.
 * Falls back to the original query on any error.
 *
 * Optimization (0.7.11+):
 * - Skip heuristic for long/specific queries (~30% of typical agent recalls)
 * - LRU cache for repeated queries (cache hit ≈ 0ms vs 164ms cold)
 * - Disable both via AWM_DISABLE_EXPANSION_CACHE=1
 */
export async function expandQuery(originalQuery: string): Promise<string> {
  const normalized = originalQuery.toLowerCase().trim();
  const optimizationsEnabled = process.env.AWM_DISABLE_EXPANSION_CACHE !== '1';

  if (optimizationsEnabled) {
    if (shouldSkipExpansion(normalized)) {
      return originalQuery;
    }
    const cached = expansionCache.get(normalized);
    if (cached !== undefined) {
      // Move to end (most-recent) for LRU semantics
      expansionCache.delete(normalized);
      expansionCache.set(normalized, cached);
      return cached;
    }
  }

  try {
    const expander = await getExpander();
    const prompt = `Expand this search query with synonyms and related terms. Only output the additional terms, not the original query. Query: ${originalQuery}. Additional terms:`;

    const result = await expander(prompt, {
      max_new_tokens: 25,
      no_repeat_ngram_size: 2,
    });

    const expanded = Array.isArray(result) ? (result[0] as any)?.generated_text ?? '' : '';
    const cleanExpanded = expanded.trim();

    const finalQuery = cleanExpanded && cleanExpanded.length > 2
      ? `${originalQuery} ${cleanExpanded}`
      : originalQuery;

    // Cache the result (LRU eviction when over capacity)
    if (optimizationsEnabled) {
      if (expansionCache.size >= EXPANSION_CACHE_LIMIT) {
        const oldestKey = expansionCache.keys().next().value;
        if (oldestKey !== undefined) expansionCache.delete(oldestKey);
      }
      expansionCache.set(normalized, finalQuery);
    }

    return finalQuery;
  } catch {
    return originalQuery;
  }
}

/** Clear the expansion cache (used by tests + cache invalidation if needed). */
export function clearExpansionCache(): void {
  expansionCache.clear();
}
