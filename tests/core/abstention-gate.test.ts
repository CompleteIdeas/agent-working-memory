// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Calibrated abstention gate (src/engine/abstention-gate.ts). The measurement that justifies
 * it runs on the private real-store snapshot (tests/realstore-eval/gate-eval.ts); these tests
 * pin the parts that must hold anywhere: the math, the model file, and the recall contract —
 * a withheld recall is REPORTED, a low one is FLAGGED, and the gate is inert when off.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fitLogistic, thresholds, classify, featureVector, saveModel, loadModel, setGateModelPathForTests, type GateModel,
} from '../../src/engine/abstention-gate.js';
import { needsRecalibration } from '../../src/engine/abstention-calibration.js';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const model = (over: Partial<GateModel> = {}): GateModel => ({
  version: 1, agentId: 'a', fittedAt: new Date().toISOString(), storeSize: 100,
  mu: [0, 0, 0], sd: [1, 1, 1], w: [1, 0, 0], b: 0, answerAt: 1, withholdBelow: -1,
  stats: { positives: 100, positivesCorrect: 90, nulls: 100 }, ...over,
});

describe('the math', () => {
  it('fits a logistic model that ranks positives above negatives', () => {
    const X: number[][] = [], y: number[] = [];
    for (let i = 0; i < 60; i++) { X.push([2 + (i % 7) * 0.1, 0.5]); y.push(1); X.push([-2 - (i % 5) * 0.1, 0.4]); y.push(0); }
    const m = fitLogistic(X, y, 500);
    const s = (x: number[]) => x.reduce((acc, v, j) => acc + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b);
    expect(s([2.3, 0.5])).toBeGreaterThan(0);
    expect(s([-2.3, 0.4])).toBeLessThan(0);
  });

  it('answers at the score keeping 98% of correct answers, withholds below the null median', () => {
    const correct = Array.from({ length: 100 }, (_, i) => i); // 0..99
    const nulls = Array.from({ length: 50 }, (_, i) => -100 + i); // median -75
    const t = thresholds(correct, nulls);
    expect(t.answerAt).toBe(2);
    expect(t.withholdBelow).toBe(-75);
  });

  it('never puts the withhold line above the answer line', () => {
    const t = thresholds([0, 0.1, 0.2], [5, 6, 7]);
    expect(t.withholdBelow).toBeLessThanOrEqual(t.answerAt);
  });

  it('works on the reranker logit, so near-1 scores stay distinguishable', () => {
    const [a] = featureVector({ rerankTop: 0.99, rerankSecond: 0.5, vectorTop: 0.4 });
    const [b] = featureVector({ rerankTop: 0.999, rerankSecond: 0.5, vectorTop: 0.4 });
    expect(b! - a!).toBeGreaterThan(2);
  });

  it('places scores in three bands', () => {
    const m = model();
    expect(classify(m, { rerankTop: 0.99, rerankSecond: 0.5, vectorTop: 0 }).band).toBe('answer');   // logit ≈ 4.6
    expect(classify(m, { rerankTop: 0.5, rerankSecond: 0.5, vectorTop: 0 }).band).toBe('low');       // logit 0
    expect(classify(m, { rerankTop: 0.01, rerankSecond: 0.5, vectorTop: 0 }).band).toBe('withhold'); // logit ≈ -4.6
  });

  it('refits when the model is missing, old, or the store grew by a fifth', () => {
    expect(needsRecalibration(null, 100)).toBe(true);
    expect(needsRecalibration(model({ storeSize: 100 }), 110)).toBe(false);
    expect(needsRecalibration(model({ storeSize: 100 }), 130)).toBe(true);
    expect(needsRecalibration(model({ fittedAt: new Date(Date.now() - 9 * 86_400_000).toISOString() }), 100)).toBe(true);
  });
});

describe('the model file', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'awm-gate-')); setGateModelPathForTests(join(tmp, 'abstention-model.json')); });
  afterEach(() => { setGateModelPathForTests(null); rmSync(tmp, { recursive: true, force: true }); });

  it('keeps one model per agent', () => {
    saveModel(model({ agentId: 'work', answerAt: 1.5 }));
    saveModel(model({ agentId: 'personal', answerAt: 0.5 }));
    expect(loadModel('work')?.answerAt).toBe(1.5);
    expect(loadModel('personal')?.answerAt).toBe(0.5);
    expect(loadModel('nobody')).toBeNull();
  });
});

describe('recall with the gate', () => {
  let tmp: string; let store: EngramStore; let eng: ActivationEngine;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-gate-recall-'));
    setGateModelPathForTests(join(tmp, 'abstention-model.json'));
    store = new EngramStore(join(tmp, 'memory.db'));
    eng = new ActivationEngine(store as any);
    for (const [c, b] of [
      ['RosterKeep deploy command', 'Deploy RosterKeep with railway up --service rowos-app --ci after migrations.'],
      ['Wellness Loudoun workshop venue', 'The Going Deeper workshop is at Crossroads UMC in Ashburn on 26 October.'],
      ['AWM recall latency', 'Warm recall p50 is about 256 ms on a quiet machine with the q8 reranker.'],
    ]) store.createEngram({ agentId: 'a', concept: c!, content: b!, tags: [] });
  });
  afterEach(() => { delete process.env.AWM_ABSTAIN_GATE; setGateModelPathForTests(null); store.close(); rmSync(tmp, { recursive: true, force: true }); });

  const recall = (extra: Record<string, unknown> = {}) => {
    let abstained: any = null;
    const p = eng.activate({ agentId: 'a', context: 'how do I deploy RosterKeep', limit: 3, internal: true,
      onAbstain: (i: any) => { abstained = i; }, ...extra } as any);
    return p.then((res) => ({ res, abstained }));
  };

  it('is inert when AWM_ABSTAIN_GATE is not set, even with a model saved', async () => {
    saveModel(model({ agentId: 'a', answerAt: 1e9, withholdBelow: 1e9 }));
    const { res } = await recall();
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].signal).toBeUndefined();
  });

  it('a withheld recall is reported through onAbstain, never a silent empty result', async () => {
    process.env.AWM_ABSTAIN_GATE = 'calibrated';
    saveModel(model({ agentId: 'a', answerAt: 1e9, withholdBelow: 1e9 }));
    const { res, abstained } = await recall();
    expect(res).toEqual([]);
    expect(abstained?.reason).toBe('calibrated');
    expect(abstained?.signal?.band).toBe('withhold');
    expect(abstained?.candidates).toBeGreaterThan(0);
  });

  it('a low signal still answers, flagged on every result', async () => {
    process.env.AWM_ABSTAIN_GATE = 'calibrated';
    saveModel(model({ agentId: 'a', answerAt: 1e9, withholdBelow: -1e9 }));
    const { res } = await recall();
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r: any) => r.signal?.band === 'low')).toBe(true);
  });

  it('skipCalibratedGate (require_confidence: 0 in memory_recall) opens the gate', async () => {
    process.env.AWM_ABSTAIN_GATE = 'calibrated';
    saveModel(model({ agentId: 'a', answerAt: 1e9, withholdBelow: 1e9 }));
    const { res, abstained } = await recall({ skipCalibratedGate: true });
    expect(res.length).toBeGreaterThan(0);
    expect(abstained).toBeNull();
  });

  it('an agent with no model is not gated', async () => {
    process.env.AWM_ABSTAIN_GATE = 'calibrated';
    const { res } = await recall();
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].signal).toBeUndefined();
  });
});
