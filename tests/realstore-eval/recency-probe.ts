/** Does recency survive into the FINAL ordering? Dump phaseScores per result. */
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const WORK = join(tmpdir(), `awm-recency-${process.pid}.db`);
const QUERY = process.env.PROBE_QUERY ?? 'azure app service plan capacity increase internal application';

for (const s of ['', '-wal', '-shm']) { try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch {} }
copyFileSync(SNAP, WORK);
const store = new EngramStore(WORK);
const act = new ActivationEngine(store);

const res: any[] = await act.activate({ agentId: 'work', context: QUERY, limit: Number(process.env.PROBE_K ?? 8), internal: true } as any);
console.log(`\nquery: "${QUERY}"\n`);
console.log('rank  age(d)  decay   textM   rerank  composite  final   concept');
console.log('-'.repeat(104));
const now = Date.now();
const TARGET='2ab1866e-cc5a-4381-b9a0-4995609a2c6d';
const ti=res.findIndex(r=>r.engram.id===TARGET);
console.log(ti>=0?`TARGET (Aug-21 private-plan memory) found at rank ${ti+1} of ${res.length}`:`TARGET NOT IN TOP ${res.length}`);
console.log();
res.forEach((r, i) => {
  const created = new Date(r.engram.createdAt ?? r.engram.created_at ?? 0).getTime();
  const ageD = created ? ((now - created) / 86400000) : NaN;
  const p = r.phaseScores ?? {};
  console.log(
    `${String(i + 1).padStart(4)}  ${ageD.toFixed(0).padStart(6)}  ` +
    `${(p.decayScore ?? 0).toFixed(3)}   ${(p.textMatch ?? 0).toFixed(3)}   ` +
    `${(p.rerankerScore ?? 0).toFixed(3)}   ${(p.composite ?? 0).toFixed(3)}      ` +
    `${(r.score ?? 0).toFixed(3)}   ${String(r.engram.concept).slice(0, 44)}`);
});
store.close?.();
for (const s of ['', '-wal', '-shm']) { try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch {} }
process.exit(0);
