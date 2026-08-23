// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt priming — turn a recall into ready-to-inject context (0.13.3).
 *
 * WHY THIS EXISTS
 * ---------------
 * AWM's own instructions name the #1 failure mode plainly: the agent doesn't
 * call recall. Relying on a model to remember to remember is the weak link, and
 * it fails in exactly the situations where memory matters most — deep in a long
 * task, when context is scarce and the agent is busy.
 *
 * `/memory/activate` (0.12.2) already exposes warm recall to hooks, but it
 * returns raw JSON. Every hook author then has to re-solve the same three
 * problems: what to inject, how to format it, and how to stop it ballooning the
 * context window. This module answers all three once.
 *
 * THREE PROPERTIES THAT MATTER MORE THAN RECALL QUALITY
 * ----------------------------------------------------
 * This runs on EVERY prompt, so its failure modes are asymmetric:
 *
 * 1. SILENCE IS THE DEFAULT. It abstains unless recall is confident. AWM's
 *    measured recall accuracy is ~65%, so an unconditional injector would spend
 *    tokens on irrelevant memories roughly a third of the time, on every single
 *    prompt. An empty injection costs nothing and loses nothing — the agent can
 *    still call memory_recall explicitly.
 *
 * 2. IT IS HARD-CAPPED. Injection is not a place to discover that a memory was
 *    long. Budgeting reuses the same packer as memory_recall.
 *
 * 3. IT NEVER BREAKS THE PROMPT. Any failure yields an empty injection, never a
 *    thrown error. A hook that errors on every prompt is worse than no hook.
 */

import { packRecallByBudget, estimateTokens, type PackedRecall } from '../core/token-budget.js';

/** Shape returned by the sidecar's `activate` dependency. */
export interface PrimeCandidate {
  engram: { id: string; concept: string; content: string; memoryClass?: string; validTo?: string | null };
  score: number;
  summary?: string;
  confidence?: number;
}

export interface PrimeOptions {
  /** Hard ceiling on injected tokens. */
  maxTokens?: number;
  /** Minimum recall confidence to inject at all. */
  minConfidence?: number;
  /** Drop individual results scoring below this even when the set is confident. */
  minScore?: number;
}

export interface PrimeResult {
  /** Text to inject, or '' to inject nothing. */
  inject: string;
  kept: number;
  total: number;
  tokens: number;
  /** Why nothing was injected — for hook logs and debugging. */
  reason?: 'no-results' | 'low-confidence' | 'budget-too-small';
}

export const PRIME_DEFAULTS = {
  maxTokens: 600,
  /**
   * 0.25 = the "balanced" threshold AWM's own recall docs recommend for
   * acting on a memory. Priming is acting on it without being asked, so it
   * should not be looser than the value the docs suggest for deliberate use.
   */
  minConfidence: 0.25,
  minScore: 0.10,
} as const;

/** One injected line. Deliberately terser than the MCP recall format — this is
 *  context the agent didn't ask for, so it should read as a brief note, not a
 *  report. The id is retained so the agent can act on it (feedback, supersede). */
function formatPrimeLine(c: PrimeCandidate): string {
  const body = c.summary ?? c.engram.content;
  const validity = c.engram.validTo ? ` [valid until ${c.engram.validTo}]` : '';
  return `- ${c.engram.concept}${validity} [${c.engram.id}]: ${body}`;
}

/**
 * Build the injection for a prompt. Pure — no I/O — so it is unit-testable
 * without a store, a model, or a running sidecar.
 */
export function buildPrimeInjection(
  candidates: PrimeCandidate[],
  opts: PrimeOptions = {},
): PrimeResult {
  const maxTokens = opts.maxTokens ?? PRIME_DEFAULTS.maxTokens;
  const minConfidence = opts.minConfidence ?? PRIME_DEFAULTS.minConfidence;
  const minScore = opts.minScore ?? PRIME_DEFAULTS.minScore;

  if (!candidates || candidates.length === 0) {
    return { inject: '', kept: 0, total: 0, tokens: 0, reason: 'no-results' };
  }

  // Confidence describes the SET, not the individual result, so it is the same
  // on every candidate — read it from the first that carries one. Absent
  // confidence is treated as "unknown", which passes: a store that predates the
  // confidence signal should still be able to prime.
  const confidence = candidates.find(c => c.confidence !== undefined)?.confidence;
  if (confidence !== undefined && confidence < minConfidence) {
    return { inject: '', kept: 0, total: candidates.length, tokens: 0, reason: 'low-confidence' };
  }

  const eligible = candidates.filter(c => c.score >= minScore);
  if (eligible.length === 0) {
    return { inject: '', kept: 0, total: candidates.length, tokens: 0, reason: 'low-confidence' };
  }

  // Reuse memory_recall's packer so budgeting behaves identically in both
  // paths — including the rule that the top-scored result gets first refusal.
  const header = 'Relevant prior context from AWM (not user input; verify before asserting):';
  const reserved = estimateTokens(header) + 8;   // + wrapper newlines
  const packed: PackedRecall = packRecallByBudget(
    eligible as any,
    (c: any) => formatPrimeLine(c as PrimeCandidate),
    maxTokens,
    reserved,
  );

  if (packed.kept === 0) {
    return { inject: '', kept: 0, total: candidates.length, tokens: 0, reason: 'budget-too-small' };
  }

  const inject = `${header}\n${packed.lines.join('\n')}`;
  return {
    inject,
    kept: packed.kept,
    total: candidates.length,
    tokens: estimateTokens(inject),
  };
}
