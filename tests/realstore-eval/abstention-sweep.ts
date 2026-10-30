/**
 * Can AWM's default abstention be raised so it goes silent on absent facts WITHOUT going
 * silent on facts it has? Measures both sides on the frozen snapshot.
 *
 *   answerable  identifier fixture (300, seeded as in `npm run bench`) + category (450)
 *   absent      fixture-absent.json (verified absent, see absent-probes.ts) + the 10
 *               original adversarial probes
 *
 * Per probe, once each:
 *   rank   shipped settings without the confidence gate: what comes back, is gold #1
 *   conf   the exact `computeRecallConfidence` value the gate sees (requireConfidence above 1,
 *          so the gate always fires and reports it via onAbstain)
 *   strict the benchmark's gate (minScore 0.3, abstentionThreshold 0.3): returns or not
 * Then every require_confidence threshold is evaluated offline from the recorded values.
 *
 *   npx tsx tests/realstore-eval/abstention-sweep.ts
 */
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const seeded = <T,>(arr: T[], seed = 1337): T[] => {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const ident = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'));
const cat = JSON.parse(readFileSync(join(dir, 'fixture-category.json'), 'utf8'));
const absent = JSON.parse(readFileSync(join(dir, 'fixture-absent.json'), 'utf8'));

type P = { kind: 'identifier' | 'topic' | 'absent-near' | 'absent-far' | 'adversarial'; query: string; goldId: string | null; agent: string };
const probes: P[] = [
  ...seeded(ident.items as any[]).slice(0, 300).map((i) => ({ kind: 'identifier' as const, query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
  ...seeded(cat.items as any[]).map((i) => ({ kind: 'topic' as const, query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
  ...(absent.items as any[]).map((i) => ({ kind: (i.register === 'far' ? 'absent-far' : 'absent-near') as P['kind'], query: i.query, goldId: null, agent: 'work' })),
  ...(ident.adversarialItems as any[]).map((i) => ({ kind: 'adversarial' as const, query: i.query, goldId: null, agent: 'work' })),
];

const work = join(tmpdir(), `awm-abst-sweep-${process.pid}.db`);
copyFileSync(join(dir, 'snapshot', 'store.db'), work);
const store = new EngramStore(work);
const eng = new ActivationEngine(store as any);
const now = Date.parse('2026-08-24T09:27:21.841Z');
const base = { internal: true, now, asOf: now, granularity: 'full' };

type Rec = P & { returned: boolean; top1: boolean; inTop3: boolean; conf: number | null; strictReturned: boolean; strictTop1: boolean };
const recs: Rec[] = [];
let i = 0;
for (const p of probes) {
  const res: any[] = await eng.activate({ ...base, agentId: p.agent, context: p.query, limit: 3, minScore: 0.05, requireConfidence: 0 } as any);
  let conf: number | null = null;
  await eng.activate({ ...base, agentId: p.agent, context: p.query, limit: 3, minScore: 0.05, requireConfidence: 1.5,
    onAbstain: (info: any) => { conf = info.confidence; } } as any);
  const strict: any[] = await eng.activate({ ...base, agentId: p.agent, context: p.query, limit: 3, minScore: 0.3, abstentionThreshold: 0.3 } as any);
  const idx = p.goldId ? res.findIndex((r) => r.engram.id === p.goldId) : -1;
  recs.push({ ...p, returned: res.length > 0, top1: idx === 0, inTop3: idx >= 0, conf,
    strictReturned: strict.length > 0, strictTop1: !!p.goldId && strict[0]?.engram.id === p.goldId });
  if (++i % 100 === 0) process.stderr.write(`  ${i}/${probes.length}\n`);
}
store.close();
writeFileSync(join(tmpdir(), 'awm-abstention-sweep.json'), JSON.stringify(recs));

const kinds = ['identifier', 'topic', 'absent-near', 'absent-far', 'adversarial'] as const;
const by = (k: string) => recs.filter((r) => r.kind === k);
const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');

console.log('\nCONFIDENCE DISTRIBUTION (what the require_confidence gate sees)');
for (const k of kinds) {
  const c = by(k).map((r) => r.conf ?? 0).sort((a, b) => a - b);
  const q = (f: number) => c[Math.min(c.length - 1, Math.floor(f * c.length))]!.toFixed(3);
  console.log(`  ${k.padEnd(12)} n=${String(c.length).padStart(3)}  p10 ${q(0.1)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}`);
}

console.log('\nrequire_confidence  | answerable: s@1 kept (identifier / topic) · answered-but-silenced | absent silent: near / far / adversarial');
const answerable = recs.filter((r) => r.goldId);
const s1Base = answerable.filter((r) => r.top1).length;
for (const t of [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
  const speaks = (r: Rec) => r.returned && (r.conf ?? 0) >= t;
  const s1 = (k: string) => by(k).filter((r) => r.top1 && speaks(r)).length;
  const lostCorrect = answerable.filter((r) => r.top1 && !speaks(r)).length;
  const silent = (k: string) => by(k).filter((r) => !speaks(r)).length;
  console.log(`  ${t.toFixed(2).padStart(4)}             | ${pct(s1('identifier'), by('identifier').length)} / ${pct(s1('topic'), by('topic').length)} · ${lostCorrect} of ${s1Base} correct answers silenced`
    + ` | ${pct(silent('absent-near'), by('absent-near').length)} / ${pct(silent('absent-far'), by('absent-far').length)} / ${pct(silent('adversarial'), by('adversarial').length)}`);
}
const st = (k: string) => by(k);
console.log(`\nbenchmark strict gate (minScore 0.3 + abstentionThreshold 0.3):`
  + ` s@1 ${pct(st('identifier').filter((r) => r.strictTop1).length, st('identifier').length)} / ${pct(st('topic').filter((r) => r.strictTop1).length, st('topic').length)}`
  + ` · absent silent ${pct(st('absent-near').filter((r) => !r.strictReturned).length, st('absent-near').length)} / ${pct(st('absent-far').filter((r) => !r.strictReturned).length, st('absent-far').length)} / ${pct(st('adversarial').filter((r) => !r.strictReturned).length, st('adversarial').length)}`);
process.exit(0);
