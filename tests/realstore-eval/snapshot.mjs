/**
 * Freeze a reproducible snapshot of the live store for benchmarking.
 *
 * WHY A SNAPSHOT AND NOT THE LIVE STORE
 * -------------------------------------
 * A benchmark has to be reproducible and must never perturb what it measures.
 * The live store is written continuously by every session, so scores taken
 * against it would drift for reasons unrelated to the code under test, and a
 * benchmark run would contend with real work. Freeze once, compare many.
 *
 * Uses SQLite's online backup API rather than a file copy: the live DB runs in
 * WAL mode with active writers, and a plain `cp` can capture a torn page set.
 *
 * The snapshot is LOCAL ONLY (~257MB, real private memories — never committed).
 * What gets committed is the derived fixture (queries + expected ids), which is
 * small and carries no memory bodies.
 *
 * Run: node tests/realstore-eval/snapshot.mjs
 */
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIVE = process.env.AWM_LIVE_DB
  ?? 'C:/Users/robert/Personal-Projects/AgentSynapse/packages/awm/memory.db';
const OUT_DIR = join(import.meta.dirname, 'snapshot');
const SNAP = join(OUT_DIR, 'store.db');

if (!existsSync(LIVE)) {
  console.error(`live store not found: ${LIVE}`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const src = new Database(LIVE, { readonly: true });
console.log(`source: ${LIVE} (${(statSync(LIVE).size / 1e6).toFixed(0)} MB)`);
console.log('taking online backup (safe against live writers)...');
await src.backup(SNAP);
src.close();

const snap = new Database(SNAP, { readonly: true });
const n = snap.prepare('SELECT COUNT(*) c FROM engrams').get().c;
const active = snap.prepare("SELECT COUNT(*) c FROM engrams WHERE stage='active' AND retracted=0").get().c;
snap.close();

console.log(`snapshot: ${SNAP}`);
console.log(`  engrams ${n} (${active} active)  ${(statSync(SNAP).size / 1e6).toFixed(0)} MB`);
console.log('\nNOTE: local only — contains real memories. Never commit.');
