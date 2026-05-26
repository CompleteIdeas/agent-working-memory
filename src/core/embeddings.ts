// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Embedding Engine - vector embeddings via the ML worker pool.
 *
 * Default model: bge-small-en-v1.5 (384 dimensions, ~90MB, MTEB retrieval-optimized).
 * Configurable via AWM_EMBED_MODEL env var.
 *
 * AWM 0.8.x: inference dispatches through ml-worker.ts. The worker_threads
 * path was planned but reverted to in-process because onnxruntime-node's
 * native bindings store V8 handles that don't cross isolate boundaries
 * safely — see ml-worker.ts for the full status. The dispatch abstraction
 * is preserved for a future child_process or HTTP sidecar pool.
 * `AWM_ML_INPROCESS=1` is honored as a no-op (in-process is now the default).
 *
 * NOTE: Changing the model invalidates existing embeddings.
 * Set AWM_EMBED_MODEL=Xenova/all-MiniLM-L6-v2 for backward compatibility.
 */

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { dispatchEmbed, registerInProcessHandlers } from './ml-worker.js';

const MODEL_ID = process.env.AWM_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5';
const DIMENSIONS = parseInt(process.env.AWM_EMBED_DIMS ?? '384', 10);
const POOLING = (process.env.AWM_EMBED_POOLING ?? 'mean') as 'cls' | 'mean';

// --- In-process fallback (used by tests and crash recovery) ---

let inProcessInstance: FeatureExtractionPipeline | null = null;
let inProcessInitPromise: Promise<FeatureExtractionPipeline> | null = null;

async function loadInProcess(): Promise<FeatureExtractionPipeline> {
  if (inProcessInstance) return inProcessInstance;
  if (inProcessInitPromise) return inProcessInitPromise;
  inProcessInitPromise = pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' }).then(pipe => {
    inProcessInstance = pipe;
    console.log(`Embedding model loaded in-process: ${MODEL_ID} (${DIMENSIONS}d)`);
    return pipe;
  });
  return inProcessInitPromise;
}

async function inProcessEmbed(args: { texts: string[]; pooling: 'cls' | 'mean'; dimensions: number }): Promise<number[][]> {
  const { texts, pooling, dimensions } = args;
  if (texts.length === 0) return [];
  const embedder = await loadInProcess();
  const result = await embedder(texts, { pooling, normalize: true });
  const data = result.data as Float32Array;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(data.slice(i * dimensions, (i + 1) * dimensions)));
  }
  return vectors;
}

// Register the in-process handler with the pool (used in test mode and as fallback)
registerInProcessHandlers({ embed: inProcessEmbed });

// --- Public API ---

/**
 * Get or initialize the embedding pipeline (singleton).
 * Kept for backwards compat — returns the in-process pipeline only.
 * Most consumers should use embed() / embedBatch() which dispatch
 * to the worker pool by default.
 */
export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  return loadInProcess();
}

/**
 * Generate an embedding vector for a text string.
 * Dispatches to the worker pool (or in-process fallback).
 */
export async function embed(text: string): Promise<number[]> {
  const vectors = await dispatchEmbed({ texts: [text], pooling: POOLING, dimensions: DIMENSIONS });
  return vectors[0] ?? new Array(DIMENSIONS).fill(0);
}

/**
 * Generate embeddings for multiple texts in a batch.
 * More efficient than calling embed() in a loop — the worker batches the
 * tokenization + forward pass.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return dispatchEmbed({ texts, pooling: POOLING, dimensions: DIMENSIONS });
}

/** Get the current embedding model ID (for version tracking in stored embeddings) */
export function getModelId(): string {
  return MODEL_ID;
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
