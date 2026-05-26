// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Query Expander - rewrites queries with synonyms and related terms.
 *
 * Uses Xenova/flan-t5-small (~80MB ONNX) to expand search queries with
 * related terms that improve BM25 recall.
 *
 * AWM 0.8.x: inference dispatches through ml-worker.ts (currently in-process
 * — worker_threads reverted because onnxruntime-node bindings cross isolate
 * boundaries unsafely; see ml-worker.ts). The dispatch abstraction is
 * preserved for a future child_process / HTTP sidecar pool.
 *
 * The LRU cache + skip heuristic stay on the main thread — they're pure
 * filter/lookup logic that shouldn't pay IPC cost.
 */

import { pipeline, type Text2TextGenerationPipeline } from '@huggingface/transformers';
import { dispatchExpand, registerInProcessHandlers } from './ml-worker.js';

const MODEL_ID = 'Xenova/flan-t5-small';

// --- In-process fallback ---

let inProcessInstance: Text2TextGenerationPipeline | null = null;
let inProcessInitPromise: Promise<Text2TextGenerationPipeline> | null = null;

async function loadInProcess(): Promise<Text2TextGenerationPipeline> {
  if (inProcessInstance) return inProcessInstance;
  if (inProcessInitPromise) return inProcessInitPromise;
  inProcessInitPromise = pipeline('text2text-generation', MODEL_ID, { dtype: 'fp32' }).then(pipe => {
    inProcessInstance = pipe as Text2TextGenerationPipeline;
    console.log(`Query expander loaded in-process: ${MODEL_ID}`);
    return inProcessInstance;
  });
  return inProcessInitPromise;
}

async function inProcessExpand(args: { prompt: string; maxNewTokens: number; noRepeatNgramSize: number }): Promise<string> {
  const expander = await loadInProcess();
  const result = await expander(args.prompt, {
    max_new_tokens: args.maxNewTokens,
    no_repeat_ngram_size: args.noRepeatNgramSize,
  });
  const text = Array.isArray(result) ? (result[0] as any)?.generated_text ?? '' : '';
  return String(text).trim();
}

registerInProcessHandlers({ expand: inProcessExpand });

// --- Public API ---

/** Kept for backwards compat. */
export async function getExpander(): Promise<Text2TextGenerationPipeline> {
  return loadInProcess();
}

/**
 * LRU cache of normalized-query → expanded-query mappings.
 * Lives on the main thread — cache hits skip the worker IPC entirely.
 */
const expansionCache = new Map<string, string>();
const EXPANSION_CACHE_LIMIT = 500;

/**
 * Skip expansion when the query is already specific (long or many tokens).
 */
function shouldSkipExpansion(normalized: string): boolean {
  if (normalized.length === 0) return true;
  if (normalized.length > 50) return true;
  const tokens = new Set(normalized.split(/\s+/).filter(t => t.length > 2));
  return tokens.size >= 5;
}

/**
 * Expand a query with related terms and synonyms.
 * Returns the original query + generated expansion terms.
 * Falls back to the original query on any error.
 *
 * Dispatches inference to the worker pool. Cache + skip heuristic stay
 * on the main thread.
 */
export async function expandQuery(originalQuery: string): Promise<string> {
  const normalized = originalQuery.toLowerCase().trim();
  const optimizationsEnabled = process.env.AWM_DISABLE_EXPANSION_CACHE !== '1';

  if (optimizationsEnabled) {
    if (shouldSkipExpansion(normalized)) return originalQuery;
    const cached = expansionCache.get(normalized);
    if (cached !== undefined) {
      // LRU touch
      expansionCache.delete(normalized);
      expansionCache.set(normalized, cached);
      return cached;
    }
  }

  try {
    const prompt = `Expand this search query with synonyms and related terms. Only output the additional terms, not the original query. Query: ${originalQuery}. Additional terms:`;
    const expansion = await dispatchExpand({ prompt, maxNewTokens: 25, noRepeatNgramSize: 2 });
    const finalQuery = expansion && expansion.length > 2
      ? `${originalQuery} ${expansion}`
      : originalQuery;

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

/** Clear the expansion cache (used by tests + cache invalidation). */
export function clearExpansionCache(): void {
  expansionCache.clear();
}
