/**
 * Natural-language fixture: how much do consolidation's duplicated `synth-type=pattern` memories
 * (centroid embeddings, re-created every run) cost full AWM recall? Scores the same 194 questions
 * on a copy of the snapshot as-is and with every pattern memory retracted.
 *
 *   npx tsx tests/realstore-eval/nl-nosynth-eval.ts
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const fx = JSON.parse(readFileSync(join(dir, 'fixture-nl.json'), 'utf8'));
const now = Date.parse('2026-08-24T09:27:21.841Z');
for (const retract of [false, true]) {
  const work = join(tmpdir(), `awm-nlns-${process.pid}-${retract ? 1 : 0}.db`);
  copyFileSync(join(dir, 'snapshot', 'store.db'), work);
  if (retract) { const db = new Database(work); console.log('retracted', db.prepare(`UPDATE engrams SET retracted = 1 WHERE tags LIKE '%synth-type=pattern%'`).run().changes); db.close(); }
  const store = new EngramStore(work); const eng = new ActivationEngine(store as any);
  let s1 = 0, s3 = 0, n = 0;
  for (const it of fx.items) {
    n++;
    const ids = ((await eng.activate({ agentId: it.agent, context: it.query, limit: 3, internal: true, now, asOf: now } as any)) as any[]).map((r) => r.engram.id);
    const i = ids.indexOf(it.goldId); if (i === 0) s1++; if (i >= 0) s3++;
  }
  store.close();
  console.log(`${retract ? 'patterns retracted' : 'snapshot as-is   '} n=${n} s@1 ${(100 * s1 / n).toFixed(1)}% s@3 ${(100 * s3 / n).toFixed(1)}%`);
}
process.exit(0);
