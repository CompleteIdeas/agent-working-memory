// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Recall-path telemetry — per-stage wall time for one `activate()` call.
 *
 * WHY THIS EXISTS
 * ---------------
 * The write path has had phase telemetry since D1 (`write-telemetry.ts`), but
 * the READ path — the hot one, the one every latency claim in the docs is
 * about — had only a single total. Every attribution of that total was
 * therefore a reading of the code rather than a measurement, and two comments
 * in this repository assert "the reranker is ~90% of warm recall latency"
 * citing nothing but each other. This module exists so that number can be
 * checked, and so a reviewer can check it too.
 *
 * USE
 * ---
 *   AWM_PROFILE_RECALL=1                  one stderr line per recall
 *   AWM_PROFILE_RECALL_OUT=path.jsonl     append one JSON object per recall
 *
 * Both unset ⇒ `startRecallProfile()` returns a shared no-op and the only
 * cost on the hot path is a handful of empty method calls.
 *
 * DESIGN
 * ------
 * Labels are FLAT and must not overlap: each `begin`/`end` pair measures a
 * span that no other pair contains. That is what makes `unaccounted`
 * (total minus the sum of all spans) meaningful — it is the synchronous
 * JavaScript that no stage claims, and if it is large that is itself the
 * finding. Repeated labels accumulate, so a per-agent loop can reuse one.
 *
 * Additive module: nothing here changes an existing export or code path.
 *
 * `node:fs` is imported statically. A lazy `require()` here was silently dead:
 * this package is ESM, `require` is not defined, and the throw landed in the
 * catch that exists so profiling can never break a recall — so the first run
 * produced an empty capture and an honest-looking zero.
 */
import { appendFileSync } from 'node:fs';

const STDERR = process.env.AWM_PROFILE_RECALL === '1';
const OUT = process.env.AWM_PROFILE_RECALL_OUT || '';
const ON = STDERR || !!OUT;

export interface RecallProfiler {
  /** Open a span. Nesting a span inside another breaks `unaccounted`. */
  begin(label: string): void;
  /** Close the most recent span with this label, accumulating its duration. */
  end(label: string): void;
  /** Record a scalar fact about this recall (pool size, counts, flags). */
  note(key: string, value: number | string | boolean): void;
  /** Emit the record. Safe to call once; later calls are ignored. */
  finish(meta?: Record<string, number | string | boolean>): void;
}

const NOOP: RecallProfiler = {
  begin() {}, end() {}, note() {}, finish() {},
};

class Profiler implements RecallProfiler {
  private readonly t0 = performance.now();
  private readonly open = new Map<string, number>();
  private readonly sums = new Map<string, number>();
  private readonly calls = new Map<string, number>();
  private readonly notes: Record<string, number | string | boolean> = {};
  private done = false;

  begin(label: string): void {
    this.open.set(label, performance.now());
  }

  end(label: string): void {
    const started = this.open.get(label);
    if (started === undefined) return;      // unbalanced end — ignore, never throw
    this.open.delete(label);
    const ms = performance.now() - started;
    this.sums.set(label, (this.sums.get(label) ?? 0) + ms);
    this.calls.set(label, (this.calls.get(label) ?? 0) + 1);
  }

  note(key: string, value: number | string | boolean): void {
    this.notes[key] = value;
  }

  finish(meta: Record<string, number | string | boolean> = {}): void {
    if (this.done) return;
    this.done = true;
    const totalMs = performance.now() - this.t0;

    const stages: Record<string, number> = {};
    let accounted = 0;
    for (const [label, ms] of this.sums) {
      stages[label] = Math.round(ms * 100) / 100;
      accounted += ms;
    }

    const record = {
      totalMs: Math.round(totalMs * 100) / 100,
      unaccountedMs: Math.round((totalMs - accounted) * 100) / 100,
      stages,
      calls: Object.fromEntries(this.calls),
      ...this.notes,
      ...meta,
    };

    if (OUT) {
      try {
        appendFileSync(OUT, JSON.stringify(record) + '\n');
      } catch { /* profiling must never break a recall */ }
    }

    if (STDERR) {
      const top = Object.entries(stages).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([k, v]) => `${k}=${Math.round(v)}ms`).join(' ');
      process.stderr.write(
        `[awm] recall ${Math.round(totalMs)}ms ${top} unaccounted=${Math.round(record.unaccountedMs)}ms\n`,
      );
    }
  }
}

/** One profiler per `activate()` call, or a shared no-op when disabled. */
export function startRecallProfile(): RecallProfiler {
  return ON ? new Profiler() : NOOP;
}

/** Whether recall profiling is active — for callers that want to skip setup work. */
export function recallProfileEnabled(): boolean {
  return ON;
}
