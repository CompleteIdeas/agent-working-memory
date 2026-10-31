// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Fit the calibrated abstention gate (abstention-gate.ts) for one agent from its own store.
 *
 * Generates synthetic queries the same way the measured experiment did
 * (tests/realstore-eval/synthetic-calibration.ts), runs them as INTERNAL recalls — no touch,
 * no Hebbian, no activation log, so calibration leaves no trace in the store — and fits the
 * three-feature model. ~300 recalls; at the measured ~250 ms p50 that is about a minute,
 * which is why it runs after consolidation, not on the hot path.
 */

import type { EngramStore } from '../storage/store.js';
import type { ActivationEngine } from './activation.js';
import { GATE_MODEL_VERSION, featureVector, fitLogistic, thresholds, gateEnabled, loadModel, saveModel, type GateFeatures, type GateModel, type ShapeModel } from './abstention-gate.js';

const STOP = new Set(('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had '
  + 'at by from as it this that not but all any can will would should could into than then there their they them its also only just more '
  + 'most some such very via per use used using new now one two').split(' '));

/** Too small a store gives too few, too similar synthetic queries to fit anything honest. */
export const MIN_STORE_FOR_CALIBRATION = 60;

export interface CalibrationOptions {
  /** 0.22: questions stored by other agents of the same store — natural never-stored probes. */
  otherAgentQuestions?: string[];
  positives?: number;
  mixedNulls?: number;
  randomNulls?: number;
  seed?: number;
}

export type CalibrationProbe = { query: string; goldId: string | null; excludeIds?: string[] };

/**
 * The synthetic queries calibration fits on, generated from the store alone: positives are a
 * memory's title words plus a term unique to it; nulls mix two memories' title words, or draw
 * random mid-frequency vocabulary. Exported so experiments fit on exactly what the gate does.
 */
export async function buildCalibrationProbes(
  store: EngramStore,
  agentId: string,
  opts: CalibrationOptions = {},
): Promise<{ pos: CalibrationProbe[]; nulls: CalibrationProbe[]; natPos: CalibrationProbe[]; natNulls: CalibrationProbe[]; storeSize: number } | null> {
  const nPos = opts.positives ?? 150, nMixed = opts.mixedNulls ?? 100, nRandom = opts.randomNulls ?? 50;
  const rows = ((await store.getEngramsByAgent(agentId, 'active')) as Array<{ id: string; concept: string; content: string; supersededBy?: string | null }>)
    .filter((e) => !e.supersededBy);
  if (rows.length < MIN_STORE_FOR_CALIBRATION) return null;

  let seed = opts.seed ?? (Date.now() >>> 0);
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

  const tok = (s: string) => (s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((t) => !STOP.has(t));
  const df = new Map<string, number>();
  for (const r of rows) for (const t of new Set(tok(`${r.concept} ${r.content}`))) df.set(t, (df.get(t) ?? 0) + 1);
  const vocab = [...df.entries()].filter(([, n]) => n >= 2 && n <= Math.max(200, rows.length / 50)).map(([t]) => t);
  if (vocab.length < 20) return null;

  // Built the way real queries look: a memory's title words plus one term unique to it.
  const titleWords = (r: { concept: string }, k: number) => tok(r.concept).slice(0, k);
  const uniqueTerm = (r: { concept: string; content: string }) =>
    [...new Set(tok(`${r.concept} ${r.content}`))].find((t) => df.get(t) === 1 && !/\d|_/.test(t) && t.length >= 6);

  type Probe = CalibrationProbe;
  const pos: Probe[] = [], nulls: Probe[] = [];
  for (let tries = 0; pos.length < nPos && tries < nPos * 30; tries++) {
    const r = pick(rows); const cw = titleWords(r, 3); const u = uniqueTerm(r);
    if (cw.length >= 2 && u) pos.push({ query: [...cw, u].join(' '), goldId: r.id });
  }
  for (let tries = 0; nulls.length < nMixed && tries < nMixed * 30; tries++) {
    const a = pick(rows), b = pick(rows);
    const wa = titleWords(a, 2), wb = titleWords(b, 2);
    if (a.id !== b.id && wa.length === 2 && wb.length === 2 && !wa.some((t) => wb.includes(t))) {
      nulls.push({ query: [wa[0], wb[0], wa[1], wb[1]].join(' '), goldId: null });
    }
  }
  // EXPERIMENT (AWM_CALIBRATE_RANDOM): how many random-vocabulary nulls. With match-density
  // features these are trivially rejected and drag the withhold line far below real absent
  // questions (first v2 live run, 2026-10-30).
  const nRand = Number(process.env.AWM_CALIBRATE_RANDOM ?? nRandom);
  for (let i = 0; i < nRand; i++) nulls.push({ query: [pick(vocab), pick(vocab), pick(vocab)].join(' '), goldId: null });
  // EXPERIMENT (AWM_CALIBRATE_HELDOUT=<n>): held-out keyword nulls — a positive's own query,
  // recalled as if its memory were never stored (the deleted-fact case, in keyword shape).
  const nHeld = Number(process.env.AWM_CALIBRATE_HELDOUT ?? 0);
  for (let i = 0; i < Math.min(nHeld, pos.length); i++) nulls.push({ query: pos[i]!.query, goldId: null, excludeIds: [pos[i]!.goldId!] });

  // 0.22: natural practice, for the natural-question model (abstention-gate.ts ShapeModel).
  //  positives — a memory's stored question, that memory as gold;
  //  nulls     — held-out: another memory's question recalled with that memory excluded (the
  //              deleted-fact case in natural phrasing), and questions stored by OTHER agents,
  //              which ask about things this agent never wrote down (never-stored, natural).
  // Only when at least a quarter of the memories carry questions; otherwise no natural model.
  const withQ = (rows as Array<{ id: string; questions?: string[] | null }>).filter((r) => r.questions?.length);
  const natPos: Probe[] = [], natNulls: Probe[] = [];
  if (withQ.length >= Math.max(MIN_STORE_FOR_CALIBRATION, rows.length / 4)) {
    for (let i = 0; i < nPos; i++) { const r = pick(withQ); natPos.push({ query: pick(r.questions!), goldId: r.id }); }
    for (let i = 0; i < Math.floor(nPos / 3); i++) {
      const r = pick(withQ); natNulls.push({ query: pick(r.questions!), goldId: null, excludeIds: [r.id] });
    }
    const others = (opts.otherAgentQuestions ?? []).filter((q) => q.trim().length >= 8);
    for (let i = 0; i < Math.min(Math.floor(nPos / 3), others.length); i++) natNulls.push({ query: pick(others), goldId: null });
  }
  if (pos.length < 30 || nulls.length < 30) return null;
  return { pos, nulls, natPos, natNulls, storeSize: rows.length };
}

export async function calibrateGate(
  store: EngramStore,
  activation: ActivationEngine,
  agentId: string,
  opts: CalibrationOptions = {},
): Promise<GateModel | null> {
  // Natural never-stored probes: questions other agents of this store have stored.
  let otherAgentQuestions = opts.otherAgentQuestions;
  if (!otherAgentQuestions) {
    otherAgentQuestions = [];
    try {
      const ids = ((await (store as any).listAgentIds?.()) ?? []) as string[];
      for (const other of ids.filter((a) => a !== agentId)) {
        const rows = (await store.getEngramsByAgent(other, 'active')) as Array<{ questions?: string[] | null }>;
        for (const r of rows) for (const q of r.questions ?? []) otherAgentQuestions.push(q);
        if (otherAgentQuestions.length >= 2000) break;
      }
    } catch { /* no other agents: the natural model fits on held-out probes alone */ }
  }
  const probes = await buildCalibrationProbes(store, agentId, { ...opts, otherAgentQuestions });
  if (!probes) return null;
  const { pos, nulls, natPos, natNulls } = probes;
  type Probe = CalibrationProbe;

  const run = async (p: Probe) => {
    const res: any[] = await activation.activate({
      agentId, context: p.query, limit: 10, minScore: 0.05, requireConfidence: 0, internal: true, skipCalibratedGate: true, excludeIds: p.excludeIds,
    } as any);
    if (res.length === 0) return null;
    const f: GateFeatures = res[0].gateFeatures ?? {
      rerankTop: res[0].phaseScores?.rerankerScore ?? 0,
      rerankSecond: res[1]?.phaseScores?.rerankerScore ?? 0,
      vectorTop: res[0].phaseScores?.vectorMatch ?? 0,
    };
    return { f, correct: !!p.goldId && res[0].engram.id === p.goldId };
  };

  // One at a time: the cross-encoder is the expensive stage and running hundreds of recalls
  // concurrently only queues them while holding every candidate pool in memory.
  const runAll = async (ps: Probe[]) => {
    const out: Array<{ f: GateFeatures; correct: boolean }> = [];
    for (const p of ps) { const r = await run(p); if (r) out.push(r); }
    return out;
  };
  const posRuns = await runAll(pos);
  const nullRuns = await runAll(nulls);
  // Without the cross-encoder every reranker feature is 0 and the gate would learn nothing.
  if (!posRuns.some((r) => r.f.rerankTop > 0)) return null;
  const correct = posRuns.filter((r) => r.correct);
  if (correct.length < 20 || nullRuns.length < 20) return null;

  const main = fitShape(posRuns, nullRuns)!;

  // The natural-question model, when the store has enough questions to practise on.
  let natural: ShapeModel | undefined;
  if (natPos.length && natNulls.length) {
    const natPosRuns = await runAll(natPos);
    const natNullRuns = await runAll(natNulls);
    if (natPosRuns.filter((r) => r.correct).length >= 20 && natNullRuns.length >= 20) natural = fitShape(natPosRuns, natNullRuns) ?? undefined;
  }
  return {
    version: GATE_MODEL_VERSION as 1 | 2, agentId, fittedAt: new Date().toISOString(), storeSize: probes.storeSize,
    ...main, ...(natural ? { natural } : {}),
  };
}

/** Fit one shape's model: logistic on the features, thresholds by the shipped rule. */
function fitShape(posRuns: Array<{ f: GateFeatures; correct: boolean }>, nullRuns: Array<{ f: GateFeatures; correct: boolean }>): ShapeModel | null {
  const correct = posRuns.filter((r) => r.correct);
  if (correct.length < 20 || nullRuns.length < 20) return null;
  const X = [...posRuns, ...nullRuns].map((r) => featureVector(r.f));
  const y = [...posRuns.map(() => 1), ...nullRuns.map(() => 0)];
  const m = fitLogistic(X, y);
  const score = (f: GateFeatures) => featureVector(f).reduce((s, v, j) => s + m.w[j]! * (v - m.mu[j]!) / m.sd[j]!, m.b);
  const t = thresholds(correct.map((r) => score(r.f)), nullRuns.map((r) => score(r.f)));
  return {
    mu: m.mu, sd: m.sd, w: m.w, b: m.b, answerAt: t.answerAt, withholdBelow: t.withholdBelow,
    stats: { positives: posRuns.length, positivesCorrect: correct.length, nulls: nullRuns.length },
  };
}

/** True when the agent's model is missing, too old, or the store has grown by a fifth since. */
export function needsRecalibration(model: GateModel | null, storeSize: number): boolean {
  if (!model) return true;
  const maxDays = Number(process.env.AWM_ABSTAIN_RECALIBRATE_DAYS ?? 7);
  const ageDays = (Date.now() - Date.parse(model.fittedAt)) / 86_400_000;
  return ageDays > maxDays || storeSize > model.storeSize * 1.2;
}

/**
 * Refit the agent's gate when it is stale. Called after a full consolidation, so the floor
 * follows the store as it grows; a no-op unless AWM_ABSTAIN_GATE=calibrated.
 */
export async function recalibrateIfStale(store: EngramStore, activation: ActivationEngine, agentId: string): Promise<GateModel | null> {
  if (!gateEnabled()) return null;
  const size = ((await store.getEngramsByAgent(agentId, 'active')) as Array<{ supersededBy?: string | null }>).filter((e) => !e.supersededBy).length;
  if (!needsRecalibration(loadModel(agentId), size)) return null;
  const model = await calibrateGate(store, activation, agentId);
  if (model) saveModel(model);
  return model;
}
