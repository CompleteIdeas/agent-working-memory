/**
 * End-to-end check of the SHIPPED calibrated abstention gate on the frozen snapshot: the real
 * calibrateGate() fits a model per agent from the store alone, the gate is switched on, and every
 * labelled probe goes through ordinary recall. Reports, per population, how many land in each
 * band (answer / low signal / withhold) and how many correct answers survive.
 *
 *   AWM_ABSTAIN_GATE=calibrated npx tsx tests/realstore-eval/gate-eval.ts
 */
import Database from 'better-sqlite3';
import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { calibrateGate } from '../../src/engine/abstention-calibration.js';
import { saveModel, setGateModelPathForTests } from '../../src/engine/abstention-gate.js';

process.env.AWM_ABSTAIN_GATE = 'calibrated';
const dir = import.meta.dirname;
const SNAP = join(dir, 'snapshot', 'store.db');
const seeded = <T,>(arr: T[], seed = 1337): T[] => {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const ident = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'));
const cat = JSON.parse(readFileSync(join(dir, 'fixture-category.json'), 'utf8'));
const absent = JSON.parse(readFileSync(join(dir, 'fixture-absent.json'), 'utf8'));
const topics = seeded(cat.items as any[]);
type P = { pop: string; query: string; goldId: string | null; agent: string };
const answerable: P[] = [
  ...seeded(ident.items as any[]).slice(0, 300).map((i) => ({ pop: 'answerable', query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
  ...topics.map((i) => ({ pop: 'answerable', query: i.query, goldId: i.goldId, agent: i.agent ?? 'work' })),
];
const absentNew: P[] = [
  ...(absent.items as any[]).map((i) => ({ pop: 'absent-new', query: i.query, goldId: null, agent: 'work' })),
  ...(ident.adversarialItems as any[]).map((i) => ({ pop: 'absent-new', query: i.query, goldId: null, agent: 'work' })),
];
const familiar = topics.slice(-200);
const absentFamiliar: P[] = familiar.map((i) => ({ pop: 'absent-familiar', query: i.query, goldId: null, agent: i.agent ?? 'work' }));
const now = Date.parse('2026-08-24T09:27:21.841Z');
setGateModelPathForTests(join(tmpdir(), `awm-gate-eval-${process.pid}.json`));

async function open(deleteIds: string[] = []) {
  const work = join(tmpdir(), `awm-gate-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  copyFileSync(SNAP, work);
  if (deleteIds.length) {
    const d = new Database(work); const del = d.prepare('DELETE FROM engrams WHERE id = ?');
    d.transaction(() => { for (const id of deleteIds) del.run(id); })(); d.close();
  }
  const store = new EngramStore(work);
  return { store, eng: new ActivationEngine(store as any) };
}

// 1. Calibrate on the intact store, per agent — production code, store alone, no labels.
{
  const { store, eng } = await open();
  for (const agent of ['work', 'personal']) {
    const t0 = Date.now();
    const m = await calibrateGate(store as any, eng, agent, { seed: 20261029 });
    if (!m) { console.log(`calibration skipped for ${agent}`); continue; }
    saveModel(m);
    console.log(`calibrated ${agent}: ${m.storeSize} memories · pos ${m.stats.positives} (${m.stats.positivesCorrect} correct) · nulls ${m.stats.nulls} · answer ≥ ${m.answerAt.toFixed(2)} · withhold < ${m.withholdBelow.toFixed(2)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  store.close();
}

// 2. Every labelled probe through ordinary recall with the gate on.
type Out = { pop: string; band: string; correct: boolean };
const outs: Out[] = [];
async function evaluate(probes: P[], deleteIds: string[] = []) {
  const { store, eng } = await open(deleteIds);
  for (const p of probes) {
    let withheld = false;
    const res: any[] = await eng.activate({ agentId: p.agent, context: p.query, limit: 3, minScore: 0.05, requireConfidence: 0.05,
      internal: true, now, asOf: now, onAbstain: (i: any) => { if (i.reason === 'calibrated') withheld = true; } } as any);
    const band = withheld ? 'withhold' : res.length === 0 ? 'empty' : (res[0].signal?.band ?? 'ungated');
    outs.push({ pop: p.pop, band, correct: !!p.goldId && res[0]?.engram.id === p.goldId });
  }
  store.close();
}
await evaluate([...answerable, ...absentNew]);
await evaluate(absentFamiliar, familiar.map((i: any) => i.goldId));

const bands = ['answer', 'low', 'withhold', 'empty', 'ungated'];
console.log('\npopulation              ' + bands.map((b) => b.padStart(9)).join(''));
for (const pop of ['answerable', 'absent-new', 'absent-familiar']) {
  const xs = outs.filter((o) => o.pop === pop);
  console.log(`${pop.padEnd(24)}${bands.map((b) => String(xs.filter((o) => o.band === b).length).padStart(9)).join('')}   (n=${xs.length})`);
}
const correct = outs.filter((o) => o.pop === 'answerable' && o.correct);
console.log(`\ncorrect answers (gold #1): ${correct.length}/750 · in answer band ${correct.filter((o) => o.band === 'answer').length} · flagged low ${correct.filter((o) => o.band === 'low').length} · withheld ${correct.filter((o) => o.band === 'withhold').length}`);
process.exit(0);
