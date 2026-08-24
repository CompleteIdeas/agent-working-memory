// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Effective recall configuration — self-reporting, so a measurement can PROVE
 * which configuration produced it.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-23 a benchmark comparison reported "no effect" for a change that
 * demonstrably worked. The cause was not AWM: two arms shared a port, teardown
 * left the first server alive, the second arm health-checked the survivor, and
 * both arms measured the SAME baseline process. Identical inputs, identical
 * outputs, a confident and completely wrong conclusion.
 *
 * Port hygiene fixes that instance. It does not fix the class. The class is:
 * **nothing verified that the system measured was the system configured.**
 * The same gap bit the D11 spreading-activation re-test, where the tracer's arm
 * label omitted `AWM_SPREAD_INHIBIT`, so two materially different arms both
 * printed `arm=spread` and had to be told apart by diffing output by hand.
 *
 * The durable fix is for the running system to state its own effective recall
 * configuration, so a harness can assert it and fail LOUDLY instead of silently
 * measuring the wrong thing. Any new recall flag added to RECALL_FLAGS is
 * automatically covered by every consumer — the eval tracer's arm label, the
 * `/health` payload, and the benchmark driver's assertion.
 *
 * Adding a flag here is the ONLY step required to make it visible everywhere.
 */

/**
 * Every environment flag that can change what `activate()` returns.
 * Keep this list current — an unlisted flag is an invisible experiment.
 */
export const RECALL_FLAGS = [
  // Second-stage reorder (phase 9b)
  'AWM_RERANK2',
  'AWM_RERANK2_K',
  // Cross-encoder passage selection
  'AWM_RERANK_WINDOW',
  'AWM_RERANK_TRUNC',
  'AWM_RERANK_POOL',
  'AWM_DISABLE_RERANK_SKIP',
  // Spreading activation (D11 — parked)
  'AWM_SPREAD',
  'AWM_SPREAD_INJECT',
  'AWM_SPREAD_INHIBIT',
  'AWM_SPREAD_ITERS',
  'AWM_SPREAD_DAMPING',
  'AWM_SPREAD_BUDGET',
  'AWM_SPREAD_BOOST',
  // Candidate pool / retrieval breadth
  'AWM_TOPN_MULT',
  'AWM_BROAD_EDGES',
  'AWM_ENTITY_FETCH',
  'AWM_ENTITY_INDEX_FETCH',
  'AWM_QUERY_BRIDGE',
  'AWM_AUTOTAG',
  // Diagnostic escape hatches that alter ranking
  'AWM_DISABLE_POOL_FILTER',
  'AWM_DISABLE_EXPANSION_CACHE',
  'AWM_DISABLE_SLIM_CACHE',
  'AWM_ABSTAIN_GATE_K',
] as const;

export type RecallFlag = (typeof RECALL_FLAGS)[number];

/** Only the flags actually set, in declaration order. */
export function activeRecallConfig(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of RECALL_FLAGS) {
    const v = env[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Short, stable, comparable label for the active configuration.
 * `default` when nothing is set. Sorted so it never depends on declaration
 * order or on how the process was launched.
 */
export function recallConfigFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const active = activeRecallConfig(env);
  const keys = Object.keys(active).sort();
  if (keys.length === 0) return 'default';
  return keys.map(k => `${k.replace(/^AWM_/, '').toLowerCase()}=${active[k]}`).join(',');
}

/**
 * Assert the running configuration contains the expected flag values.
 * Returns the mismatches; empty array means the system is configured as
 * intended. Harnesses should treat a non-empty result as fatal — it means the
 * thing being measured is not the thing that was configured.
 */
export function diffRecallConfig(
  expected: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ flag: string; expected: string; actual: string | undefined }> {
  const active = activeRecallConfig(env);
  const bad: Array<{ flag: string; expected: string; actual: string | undefined }> = [];
  for (const [flag, want] of Object.entries(expected)) {
    if (active[flag] !== want) bad.push({ flag, expected: want, actual: active[flag] });
  }
  return bad;
}
