// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Token budgeting for memory_recall (0.13.3).
 *
 * WHY THIS EXISTS
 * ---------------
 * `limit: N` is a COUNT, which is token-blind: a 5-result recall can cost 400
 * tokens or 4,000 depending on how long the memories happen to be. AWM's own
 * benchmark shows the problem — in real sessions AWM retrieval averaged 4,514
 * tokens per call against 2,106 for plain file retrieval. AWM wins 9.8:1 in
 * AGGREGATE (it needs far fewer calls) but loses 2.1:1 PER CALL. Per-call cost
 * is the exposed flank, and a caller had no way to bound it.
 *
 * `max_tokens` lets the caller say "I have 800 tokens of context to spare"
 * instead of guessing at a result count.
 *
 * PACKING STRATEGY
 * ----------------
 * This is a 0/1 knapsack (maximise score within a token budget), so we use the
 * standard greedy density heuristic — order by score-per-token — with one
 * deliberate exception: the top-scored result is always admitted first if it
 * fits at all. Density packing alone can drop the single most relevant memory
 * purely for being long, which is exactly the answer the caller wanted.
 *
 * Selection is by density; OUTPUT is restored to score order, because a reader
 * scanning results expects the best one first.
 *
 * ESTIMATOR
 * ---------
 * Deliberately dependency-free: no tokenizer, no model load, no async. It
 * takes max(words x 1.3, chars / 4) — the two standard English/code
 * approximations — and takes the larger so the estimate errs toward
 * OVER-counting. Over-counting keeps us inside the budget; under-counting
 * would silently blow it, which is the failure that matters.
 */

import type { ActivationResult } from '../types/engram.js';

/** Rough token count. Over-estimates by design — see the note above. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(words * 1.3), Math.ceil(chars / 4));
}

export interface PackedRecall {
  /** Formatted lines that fit the budget, in score order. */
  lines: string[];
  /** How many results were kept. */
  kept: number;
  /** How many results were available before budgeting. */
  total: number;
  /** Estimated tokens of the kept lines. */
  tokens: number;
  /** Estimated tokens of everything dropped (0 when nothing was dropped). */
  withheldTokens: number;
}

/**
 * Select and format results to fit `maxTokens`.
 *
 * When `maxTokens` is undefined the behaviour is unchanged from pre-0.13.3 —
 * everything is returned — but the accounting fields are still populated, so
 * callers get per-call token visibility without opting into budgeting.
 */
export function packRecallByBudget(
  results: ActivationResult[],
  format: (r: ActivationResult, index: number) => string,
  maxTokens?: number,
  /**
   * Tokens the caller will spend on the SAME reply outside the result lines —
   * the accounting footer, and any peer-decisions suffix. Reserved up front so
   * the budget bounds the whole reply rather than just the part this function
   * happens to build.
   *
   * Found by the end-to-end eval, not by the unit tests: budgets of 600/250/80
   * came back as 601/256/95 because the footer spent tokens it never counted.
   */
  reservedTokens = 0,
): PackedRecall {
  const total = results.length;
  if (total === 0) return { lines: [], kept: 0, total: 0, tokens: 0, withheldTokens: 0 };
  const effectiveBudget = maxTokens === undefined ? undefined
    : Math.max(0, maxTokens - reservedTokens);

  // Format once against the ORIGINAL index so displayed numbering matches the
  // caller's mental model of "result 1 is the best match".
  const measured = results.map((r, i) => {
    const line = format(r, i);
    return { line, tokens: estimateTokens(line), score: r.score, order: i };
  });

  const allTokens = measured.reduce((n, m) => n + m.tokens, 0);

  // NOTE the asymmetry, which a unit test caught: `maxTokens` being absent or
  // nonsense (<= 0) means "no budget — return everything", but an
  // *effectiveBudget* of 0 means the reserve ate the entire budget, which must
  // admit NOTHING. Collapsing those two cases returned the full result set on
  // the tightest budgets — the exact opposite of what was asked for.
  const unbudgeted = maxTokens === undefined || maxTokens <= 0;
  if (unbudgeted || allTokens <= effectiveBudget!) {
    return {
      lines: measured.map(m => m.line),
      kept: total,
      total,
      tokens: allTokens,
      withheldTokens: 0,
    };
  }

  const chosen: typeof measured = [];
  let spent = 0;

  // 1. Top-scored result gets first refusal, so a long best-match is never
  //    dropped in favour of several short weak ones.
  const top = measured[0];
  if (top.tokens <= effectiveBudget!) {
    chosen.push(top);
    spent += top.tokens;
  }

  // 2. Everything else by value density (score per token), greedily.
  const rest = measured
    .filter(m => m !== top)
    .sort((a, b) => (b.score / Math.max(b.tokens, 1)) - (a.score / Math.max(a.tokens, 1)));

  for (const m of rest) {
    if (spent + m.tokens > effectiveBudget!) continue;   // skip, don't stop: a later
    chosen.push(m);                                // shorter result may still fit
    spent += m.tokens;
  }

  // 3. Restore score order for display.
  chosen.sort((a, b) => a.order - b.order);

  return {
    lines: chosen.map(m => m.line),
    kept: chosen.length,
    total,
    tokens: spent,
    withheldTokens: allTokens - spent,
  };
}

/**
 * One-line accounting footer. Costs ~15-25 tokens to report, which is a good
 * trade against a recall that can run to thousands — and it is what makes the
 * per-call cost visible to both the human and the harness. Without this,
 * AWM's token behaviour is only observable in an offline benchmark.
 */
export function formatTokenFooter(p: PackedRecall, maxTokens?: number): string {
  if (p.total === 0) return '';
  const parts = [`~${p.tokens} tok`];
  parts.push(p.kept === p.total ? `${p.total} results` : `${p.kept}/${p.total} results`);
  if (maxTokens !== undefined && maxTokens > 0) parts.push(`budget ${maxTokens}`);
  if (p.withheldTokens > 0) parts.push(`~${p.withheldTokens} tok withheld`);
  return `\n\n[awm: ${parts.join(' · ')}]`;
}
