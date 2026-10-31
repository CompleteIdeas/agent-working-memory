/**
 * Control for the questions experiment: a copy of the snapshot opened (and so migrated, FTS index
 * rebuilt) by the current EngramStore, with NO questions added. Separates the effect of rebuilding
 * the index from the effect of the questions.
 *   npx tsx tests/realstore-eval/rebuild-control.ts  -> snapshot/store-rebuilt.db
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
const dir = import.meta.dirname;
const out = join(dir, 'snapshot', 'store-rebuilt.db');
for (const s of ['', '-wal', '-shm']) if (existsSync(out + s)) rmSync(out + s);
copyFileSync(join(dir, 'snapshot', 'store.db'), out);
new EngramStore(out).close();
console.log(`migrated and rebuilt -> ${out}`);
