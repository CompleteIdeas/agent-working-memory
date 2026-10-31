// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Calibrated abstention: AWM learns, from its own store, what "no answer here" looks like.
 *
 * WHY THIS EXISTS (measured 2026-10-29, tests/realstore-eval/abstention-*.{ts,py})
 * ---------------------------------------------------------------------------
 * The shipped `require_confidence` gate judges the SHAPE of one query's scores. On the frozen
 * 29,853-memory snapshot it could not separate answerable from absent at any threshold: at the
 * shipped 0.05 it silenced ~0% of 73 verified-absent questions; at 0.30 it silenced ~88% but
 * threw away 293 of 695 correct answers. The per-channel study found the signal it was missing:
 * the cross-encoder's score for the top result separates "the store has this" from "it does
 * not" with AUC 0.998 (absent vocabulary) and 0.905 (familiar vocabulary, answer deleted).
 *
 * WHAT IT DOES
 * ------------
 * A tiny logistic model over three features of the final ranking —
 *   logit(top reranker score), top vector match, logit margin between #1 and #2
 * — is fitted per agent on queries the store GENERATES from itself, so no human labels:
 *   positives  a random memory's title words plus a word unique to it (its answer is known)
 *   nulls      title words of two unrelated memories mixed (every word familiar, no such fact),
 *              and random words from the store's vocabulary
 * Two thresholds come out of the fit:
 *   answerAt      keeps 98% of the synthetic correct answers
 *   withholdBelow the median score of the synthetic nulls
 * and every recall is placed in one of three bands: answer, low signal (answered, flagged),
 * or withhold (reported as abstained, never silently empty).
 *
 * Fitted on synthetic queries only and scored on the real labelled probes, the gate kept
 * 674/678 correct answers in the answer band (1 fell to withhold), and withheld 66/73
 * new-vocabulary and 81/200 familiar-vocabulary absent facts, flagging 58 more as low signal.
 *
 * Opt-in: AWM_ABSTAIN_GATE=calibrated. Recalibrated after full consolidation when the model is
 * missing, older than AWM_ABSTAIN_RECALIBRATE_DAYS (7), or the store grew by a fifth.
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type SignalBand = 'answer' | 'low' | 'withhold';

/**
 * Feature-vector version a model was fitted for. 1 = the three 0.21.0 signals. 2 (0.21.1) adds
 * match density — the raw BM25 of the best match, the shape of the whole-store cosine
 * distribution — and the top result's BM25 rank. A model of another version is not scored
 * (`loadModel` returns null) and is refitted by `awm calibrate` or after consolidation.
 */
export const GATE_MODEL_VERSION = 2;

export interface GateModel {
  version: 1 | 2;
  agentId: string;
  fittedAt: string;
  /** Retrievable memories when fitted — used to decide when to refit. */
  storeSize: number;
  mu: number[];
  sd: number[];
  w: number[];
  b: number;
  answerAt: number;
  withholdBelow: number;
  /** What the fit saw, for `awm doctor` and for honest reporting. */
  stats: { positives: number; positivesCorrect: number; nulls: number };
}

export interface GateFeatures {
  rerankTop: number;
  rerankSecond: number;
  vectorTop: number;
  /** Raw FTS5 BM25 of the best keyword match (unnormalised, so comparable across queries). */
  bm25Top?: number;
  /** Highest cosine over the agent's vectors, and that minus the 10th highest. */
  cosineTop?: number;
  cosineGap?: number;
  /** How many vectors scored ≥ 0.7 (capped at the vector search's 50). */
  cosineAbove70?: number;
  /** The top result's rank in the BM25 list, −1 when absent. */
  bm25RankTop?: number;
}

export interface SignalReport {
  band: SignalBand;
  /** Model score (log-odds that the store holds the answer). */
  score: number;
  answerAt: number;
  withholdBelow: number;
}

export function gateEnabled(): boolean {
  return (process.env.AWM_ABSTAIN_GATE ?? '').trim().toLowerCase() === 'calibrated';
}

const logit = (p: number) => {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(q / (1 - q));
};

export function featureVector(f: GateFeatures, version: 1 | 2 = GATE_MODEL_VERSION as 1 | 2): number[] {
  const l1 = logit(f.rerankTop);
  const v1 = [l1, f.vectorTop, l1 - logit(f.rerankSecond)];
  if (version === 1) return v1;
  // Measured 2026-10-30 (docs/abstention-signals-2026-10-30.md): the raw BM25 of the best match
  // is the best single signal for natural-language questions whose answer was deleted; the
  // cosine shape (one clear peak, or not) is the best family for never-stored facts.
  const rank = f.bm25RankTop ?? -1;
  return [...v1, Math.log1p(Math.max(0, f.bm25Top ?? 0)), f.cosineTop ?? 0, f.cosineGap ?? 0,
    Math.log1p(Math.min(50, Math.max(0, f.cosineAbove70 ?? 0))), rank < 0 ? 0 : 1 / (1 + rank)];
}

export function scoreWith(model: GateModel, f: GateFeatures): number {
  const x = featureVector(f, model.version);
  let s = model.b;
  for (let j = 0; j < x.length; j++) s += model.w[j]! * (x[j]! - model.mu[j]!) / model.sd[j]!;
  return s;
}

export function classify(model: GateModel, f: GateFeatures): SignalReport {
  const score = scoreWith(model, f);
  const band: SignalBand = score >= model.answerAt ? 'answer' : score >= model.withholdBelow ? 'low' : 'withhold';
  return { band, score, answerAt: model.answerAt, withholdBelow: model.withholdBelow };
}

/**
 * Class-balanced logistic regression by gradient descent on standardised features — the same
 * procedure as tests/realstore-eval/abstention-combined.py, so measurements transfer.
 */
export function fitLogistic(X: number[][], y: number[], iters = 3000, lr = 0.1, l2 = 1e-3):
  { mu: number[]; sd: number[]; w: number[]; b: number } {
  const n = X.length, d = X[0]!.length;
  const mu = Array.from({ length: d }, (_, j) => X.reduce((s, x) => s + x[j]!, 0) / n);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j]! - mu[j]!) ** 2, 0) / n) || 1);
  const Z = X.map((x) => x.map((v, j) => (v - mu[j]!) / sd[j]!));
  const pos = y.reduce((s, v) => s + v, 0), neg = n - pos;
  const cw = [n / (2 * Math.max(neg, 1)), n / (2 * Math.max(pos, 1))];
  let w = new Array(d).fill(0) as number[];
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0) as number[];
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j]! * Z[i]![j]!;
      const p = 1 / (1 + Math.exp(-z));
      const e = (p - y[i]!) * cw[y[i]!]!;
      for (let j = 0; j < d; j++) gw[j]! += e * Z[i]![j]!;
      gb += e;
    }
    w = w.map((wj, j) => wj - lr * (gw[j]! / n + l2 * wj));
    b -= lr * gb / n;
  }
  return { mu, sd, w, b };
}

/** Thresholds from the fitted scores: keep 98% of synthetic correct answers; withhold below the null median. */
export function thresholds(correctScores: number[], nullScores: number[]): { answerAt: number; withholdBelow: number } {
  const c = [...correctScores].sort((a, b) => a - b);
  const z = [...nullScores].sort((a, b) => a - b);
  const answerAt = c[Math.floor(0.02 * c.length)] ?? 0;
  const nullMedian = z[Math.floor(z.length / 2)] ?? answerAt;
  return { answerAt, withholdBelow: Math.min(nullMedian, answerAt) };
}

// ─── Storage: one JSON file beside the store, one entry per agent ────────────

let modelPath: string | null = null;
let cache: { mtimeMs: number; models: Record<string, GateModel> } | null = null;

/** Where calibrated models live: beside the memory store (`abstention-model.json`). */
export function initGateStorage(storePath: string): void {
  const p = resolve(storePath);
  const dir = existsSync(p) && statSync(p).isDirectory() ? p : dirname(p);
  modelPath = join(dir, 'abstention-model.json');
  cache = null;
}

function readAll(): Record<string, GateModel> {
  if (!modelPath || !existsSync(modelPath)) return {};
  const mtimeMs = statSync(modelPath).mtimeMs;
  if (cache && cache.mtimeMs === mtimeMs) return cache.models;
  try {
    const models = JSON.parse(readFileSync(modelPath, 'utf8')) as Record<string, GateModel>;
    cache = { mtimeMs, models };
    return models;
  } catch {
    return {};
  }
}

const staleVersionReported = new Set<string>();

export function loadModel(agentId: string): GateModel | null {
  const m = readAll()[agentId] ?? null;
  if (m && m.version !== GATE_MODEL_VERSION) {
    // Scoring a v1 model with v2 features would be silent nonsense. Stand aside and say so once.
    if (!staleVersionReported.has(agentId)) {
      staleVersionReported.add(agentId);
      console.error(`[awm] abstention gate for ${agentId} was fitted for feature version ${m.version}, this build uses ${GATE_MODEL_VERSION}; the gate is off until \`awm calibrate\` (or the next consolidation) refits it.`);
    }
    return null;
  }
  return m;
}

export function saveModel(model: GateModel): void {
  if (!modelPath) throw new Error('abstention gate storage not initialised');
  const all = { ...readAll(), [model.agentId]: model };
  mkdirSync(dirname(modelPath), { recursive: true });
  // Atomic replace: several AWM processes may share one store.
  const tmp = `${modelPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 1));
  renameSync(tmp, modelPath);
  cache = null;
}

/** Tests only. */
export function setGateModelPathForTests(p: string | null): void {
  modelPath = p;
  cache = null;
}
