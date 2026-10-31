/**
 * Recall latency, old vs new ranking, interleaved per query in one process so both see the
 * same machine load. Env is read inside activate(), so it can be flipped between calls.
 *   npx tsx tests/realstore-eval/latency-ab.ts
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const qs = [
  ...JSON.parse(readFileSync(join(dir, 'fixture-nl.json'), 'utf8')).items.slice(0, 100),
  ...JSON.parse(readFileSync(join(dir, 'fixture-category.json'), 'utf8')).items.slice(0, 100),
];
const work = join(tmpdir(), `awm-lat-${process.pid}.db`);
copyFileSync(join(dir, 'snapshot', 'store.db'), work);
const eng = new ActivationEngine(new EngramStore(work) as any);
const now = Date.parse('2026-08-24T09:27:21.841Z');
// LAT_OLD / LAT_NEW: JSON env overrides for each arm (default: 0.21.0 ranking vs current).
const OLD: Record<string, string> = JSON.parse(process.env.LAT_OLD ?? '{"AWM_PRESELECT":"composite","AWM_TOPN_MIN":"0","AWM_BLEND":"off"}');
const NEW: Record<string, string> = JSON.parse(process.env.LAT_NEW ?? '{}');
const set = (o: Record<string, string> | null) => {
  for (const k of [...Object.keys(OLD), ...Object.keys(NEW)]) delete process.env[k];
  if (o) Object.assign(process.env, o);
};
const t = { old: [] as number[], new: [] as number[] };
const call = (q: any) => eng.activate({ agentId: q.agent ?? 'work', context: q.query, limit: 3, minScore: 0.05, requireConfidence: 0.05, internal: true, now, asOf: now } as any);
for (const q of qs.slice(0, 10)) { set(NEW); await call(q); set(OLD); await call(q); } // warm
for (const [i, q] of qs.entries()) {
  for (const arm of (i % 2 ? ['old', 'new'] : ['new', 'old']) as Array<'old' | 'new'>) {
    set(arm === 'old' ? OLD : NEW);
    const t0 = performance.now(); await call(q); t[arm].push(performance.now() - t0);
  }
}
const pc = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!.toFixed(0);
for (const arm of ['old', 'new'] as const) console.log(`${arm}: p50 ${pc(t[arm], 0.5)} ms · p90 ${pc(t[arm], 0.9)} ms · n=${t[arm].length}`);
process.exit(0);
