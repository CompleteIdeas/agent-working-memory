/**
 * Does rewriting a natural-language question into keyword queries — the job a calling agent
 * (or a small local model) could do before recall — recover what AWM loses on human phrasing?
 *
 * Reads nl-rewrites.json (written by a rewriter that saw ONLY the questions: no answers, no
 * memory content) and scores AWM on each condition × form against the same golds:
 *   original      the question as asked (the 41.2% baseline)
 *   blind.one     one keyword query from the question alone
 *   blind.multi   up to three alternative queries, each recalled, merged by reciprocal rank
 *   context.one / context.multi   the same, with a project glossary an agent would have
 *
 *   npx tsx tests/realstore-eval/nl-rewrite-eval.ts
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const fx = JSON.parse(readFileSync(join(dir, 'fixture-nl.json'), 'utf8'));
const rw = new Map((JSON.parse(readFileSync(join(dir, 'nl-rewrites.json'), 'utf8')) as any[]).map((r) => [r.i, r]));
const work = join(tmpdir(), `awm-nlrw-${process.pid}.db`);
copyFileSync(join(dir, 'snapshot', 'store.db'), work);
const store = new EngramStore(work); const eng = new ActivationEngine(store as any);
const now = Date.parse('2026-08-24T09:27:21.841Z');

const recall = async (agent: string, q: string, limit = 3) =>
  ((await eng.activate({ agentId: agent, context: q, limit, internal: true, now, asOf: now } as any)) as any[]).map((r) => r.engram.id as string);
/** Run every phrasing and merge by reciprocal rank — what a multi-query recall would do. */
const multi = async (agent: string, qs: string[]) => {
  const s = new Map<string, number>();
  for (const q of qs) (await recall(agent, q, 10)).forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (60 + i + 1)));
  return [...s].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
};

const arms = ['original', 'blind.one', 'blind.multi', 'context.one', 'context.multi'] as const;
const t = Object.fromEntries(arms.map((a) => [a, { s1: 0, s3: 0 }])) as Record<string, { s1: number; s3: number }>;
let n = 0;
for (const [i, it] of (fx.items as any[]).entries()) {
  const r = rw.get(i); if (!r) continue;
  n++;
  const res: Record<string, string[]> = {
    'original': await recall(it.agent, it.query),
    'blind.one': await recall(it.agent, r.blind.one),
    'blind.multi': await multi(it.agent, r.blind.multi),
    'context.one': await recall(it.agent, r.context.one),
    'context.multi': await multi(it.agent, r.context.multi),
  };
  for (const a of arms) { const idx = res[a]!.indexOf(it.goldId); if (idx === 0) t[a]!.s1++; if (idx >= 0) t[a]!.s3++; }
}
store.close();
console.log(`n=${n}`);
for (const a of arms) console.log(`${a.padEnd(15)} s@1 ${(100 * t[a]!.s1 / n).toFixed(1)}%   s@3 ${(100 * t[a]!.s3 / n).toFixed(1)}%`);
process.exit(0);
