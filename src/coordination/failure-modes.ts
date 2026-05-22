// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * FailureMode taxonomy and mutation-hint map for the coordination control layer.
 * Part of AWM 0.8.1 — additive, no breaking changes.
 */

export enum FailureMode {
  AGENT_STALE    = 'agent_stale',
  TIMEOUT        = 'timeout',
  OUTPUT_INVALID = 'output_invalid',
  TEST_FAIL      = 'test_fail',
  LINT_FAIL      = 'lint_fail',
  MERGE_CONFLICT = 'merge_conflict',
  UNKNOWN        = 'unknown',
}

/** Classify a failure result string into one of the known modes. */
export function classifyFailure(result: string | null): FailureMode {
  if (!result) return FailureMode.UNKNOWN;
  const r = result.toLowerCase();
  if (r.includes('stale') || r.includes('disconnected')) return FailureMode.AGENT_STALE;
  if (r.includes('timeout') || r.includes('timed out'))  return FailureMode.TIMEOUT;
  if (r.includes('json') || r.includes('schema') || r.includes('parse')) return FailureMode.OUTPUT_INVALID;
  if (r.includes('test fail') || r.includes('vitest') || r.includes('jest')) return FailureMode.TEST_FAIL;
  if (r.includes('lint') || r.includes('eslint') || r.includes('typecheck')) return FailureMode.LINT_FAIL;
  if (r.includes('conflict'))                             return FailureMode.MERGE_CONFLICT;
  return FailureMode.UNKNOWN;
}

/**
 * Corrective guidance injected into the task description on retry.
 * Each hint is written in the vocabulary the next worker will read.
 */
export const MUTATION_HINTS: Record<FailureMode, string> = {
  [FailureMode.AGENT_STALE]:
    'Previous worker disconnected before completion. Resume from last known state; check git status before re-running destructive commands.',
  [FailureMode.TIMEOUT]:
    'Previous attempt timed out. Break work into smaller commits; report progress every 5 minutes.',
  [FailureMode.OUTPUT_INVALID]:
    'Previous output failed validation. Return a single fenced code block; verify JSON parses before submitting.',
  [FailureMode.TEST_FAIL]:
    'Previous attempt left tests failing. Run vitest before completion; do NOT mark complete if any test fails.',
  [FailureMode.LINT_FAIL]:
    'Previous attempt had lint/typecheck errors. Run pnpm typecheck and pnpm lint before completion.',
  [FailureMode.MERGE_CONFLICT]:
    'Previous attempt left merge conflicts unresolved. git pull --rebase, resolve, then re-attempt.',
  [FailureMode.UNKNOWN]:
    'Previous attempt failed for an unclassified reason. Investigate the prior result before re-running.',
};
