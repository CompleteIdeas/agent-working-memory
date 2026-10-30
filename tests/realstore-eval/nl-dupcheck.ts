/**
 * Natural-language fixture: how many "misses" are really another memory carrying the same answer?
 * The store has near-duplicate memories, so a question can be answered by a memory other than
 * the one it was written from. Counts a result as answering when it contains the gold's verified
 * answer quote. Read-only (internal recall on a copy).
 *
 *   npx tsx tests/realstore-eval/nl-dupcheck.ts
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const fx = JSON.parse(readFileSync(join(dir, 'fixture-nl.json'), 'utf8'));
const qs = JSON.parse(readFileSync(join(dir, 'nl-questions.json'), 'utf8')) as Array<any>;
const quote = new Map(qs.filter((q) => !q.skipped).map((q) => [q.goldId, q.answerQuote as string]));
const work = join(tmpdir(), `awm-nldup-${process.pid}.db`);
copyFileSync(join(dir, 'snapshot', 'store.db'), work);
const store = new EngramStore(work); const eng = new ActivationEngine(store as any);
const now = Date.parse('2026-08-24T09:27:21.841Z');
let gold1 = 0, answer1 = 0, answer3 = 0;
for (const it of fx.items) {
  const res: any[] = await eng.activate({ agentId: it.agent, context: it.query, limit: 3, internal: true, now, asOf: now } as any);
  const q = quote.get(it.goldId)!;
  const has = (r: any) => r.engram.id === it.goldId || String(r.engram.content).includes(q);
  if (res[0]?.engram.id === it.goldId) gold1++;
  if (res[0] && has(res[0])) answer1++;
  if (res.some(has)) answer3++;
}
store.close();
const n = fx.items.length; const pct = (x: number) => `${(100 * x / n).toFixed(1)}%`;
console.log(`n=${n} · gold first ${pct(gold1)} · an answering memory first ${pct(answer1)} · an answering memory in top 3 ${pct(answer3)}`);
process.exit(0);
