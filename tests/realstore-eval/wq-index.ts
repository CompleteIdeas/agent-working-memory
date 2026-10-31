/**
 * Write-time questions on the full store, the way 0.22 stores them: a copy of the snapshot is
 * opened with the current EngramStore (which migrates it: `questions` column, four-column FTS
 * index) and every memory's generated questions are set with setQuestions(). Vectors and
 * everything the cross-encoder reads are unchanged.
 *
 *   npx tsx tests/realstore-eval/wq-index.ts   -> tests/realstore-eval/snapshot/store-wq.db
 * Then: REALSTORE_SNAPSHOT=snapshot/store-wq.db for stage-diagnose.ts / gate-eval.ts / runner.ts.
 */
import { copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';

const dir = import.meta.dirname;
const out = join(dir, 'snapshot', 'store-wq.db');
for (const s of ['', '-wal', '-shm']) if (existsSync(out + s)) rmSync(out + s);
copyFileSync(join(dir, 'snapshot', 'store.db'), out);
const WQ = JSON.parse(readFileSync(join(dir, 'nl-wq.json'), 'utf8')) as { questions: Record<string, string[]> };
const t0 = Date.now();
const store = new EngramStore(out); // migrates the copy
let n = 0, missing = 0;
store.transaction(() => {
  for (const [id, qs] of Object.entries(WQ.questions)) {
    if (!qs.length) continue;
    if (!store.getEngram(id)) { missing++; continue; }
    store.setQuestions(id, qs);
    n++;
  }
});
store.close();
console.log(`questions set on ${n} memories (${missing} not found) in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${out}`);
