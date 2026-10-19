// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Temporal validity (D8) — the one place that decides whether a memory's
 * `valid_from` / `valid_to` window holds at a given moment.
 *
 * Until 2026-10-19 nothing read these fields except the two recall formatters,
 * which printed `[valid until …]` on expired memories exactly as on current
 * ones. The live store was serving 482 memories past their `valid_to` as
 * current (97 active, 385 archived). The guidance given to agents ("use
 * `valid_to` … so the memory expires") promised behaviour the code did not have.
 *
 * Ranking (activation.ts Phase 8c), the MCP recall format and the prime hook
 * all go through here so they cannot disagree about what "expired" means.
 */

export type ValidityState = 'current' | 'expired' | 'not-yet-valid';

/** The fields this needs — any engram-shaped object qualifies. */
export interface TemporallyBounded {
  validFrom?: string | null;
  validTo?: string | null;
}

/**
 * A date-only `valid_to` ("2026-01-15") means "through that day", so it is
 * compared against the END of that day in UTC. A full datetime is taken as
 * written. An unparseable value is ignored: a bad bound must not hide a memory.
 */
function boundMs(value: string, endOfDay: boolean): number {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return NaN;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  return dateOnly && endOfDay ? t + 86_400_000 - 1 : t;
}

export function validityState(e: TemporallyBounded, now: number = Date.now()): ValidityState {
  if (e.validTo) {
    const until = boundMs(e.validTo, true);
    if (Number.isFinite(until) && now > until) return 'expired';
  }
  if (e.validFrom) {
    const from = boundMs(e.validFrom, false);
    if (Number.isFinite(from) && now < from) return 'not-yet-valid';
  }
  return 'current';
}
