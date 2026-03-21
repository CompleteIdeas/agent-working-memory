// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Embedding Engine — local vector embeddings via transformers.js
 *
 * Default: gte-small (384 dimensions, ~34MB int8, MTEB 61.4) for semantic similarity.
 * Configurable via AWM_EMBED_MODEL env var.
 * Model is downloaded once on first use and cached locally.
 *
 * Singleton pattern — call getEmbedder() to get the shared instance.
 */

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL_ID = process.env.AWM_EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = parseInt(process.env.AWM_EMBED_DIMS ?? '384', 10);
const POOLING = (process.env.AWM_EMBED_POOLING ?? 'mean') as 'cls' | 'mean';

let instance: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Get or initialize the embedding pipeline (singleton).
 * First call downloads the model (~22MB), subsequent calls are instant.
 */
export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (instance) return instance;
  if (initPromise) return initPromise;

  initPromise = pipeline('feature-extraction', MODEL_ID, {
    dtype: 'fp32',
  }).then(pipe => {
    instance = pipe;
    console.log(`Embedding model loaded: ${MODEL_ID} (${DIMENSIONS}d)`);
    return pipe;
  });

  return initPromise;
}

/**
 * Generate an embedding vector for a text string.
 * Returns a normalized float32 array of length DIMENSIONS.
 */
export async function embed(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const result = await embedder(text, { pooling: POOLING, normalize: true });
  // result is a Tensor — extract the data
  return Array.from(result.data as Float32Array).slice(0, DIMENSIONS);
}

/**
 * Generate embeddings for multiple texts in a batch.
 * More efficient than calling embed() in a loop.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const embedder = await getEmbedder();
  const result = await embedder(texts, { pooling: POOLING, normalize: true });
  const data = result.data as Float32Array;

  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(data.slice(i * DIMENSIONS, (i + 1) * DIMENSIONS)));
  }
  return vectors;
}

/**
 * Cosine similarity between two normalized vectors.
 * Since vectors are pre-normalized, this is just the dot product.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Clamp to [-1, 1] to handle floating point drift
  return Math.max(-1, Math.min(1, dot));
}

/** Vector dimensions for this model */
export const EMBEDDING_DIMENSIONS = DIMENSIONS;
