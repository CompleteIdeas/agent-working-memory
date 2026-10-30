// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * `awm calibrate [--agent <id>]` — fit the store-calibrated abstention gate now, rather than
 * waiting for the next consolidation. Read-only on memories: calibration runs internal recalls
 * (no touch, no Hebbian, no activation log). Writes only abstention-model.json beside the store.
 */

import { openStore } from '../storage/factory.js';
import { ActivationEngine } from '../engine/activation.js';
import { calibrateGate, MIN_STORE_FOR_CALIBRATION } from '../engine/abstention-calibration.js';
import { saveModel, gateEnabled } from '../engine/abstention-gate.js';

export async function calibrateCmd(argv: string[]): Promise<number> {
  const agentIdx = argv.indexOf('--agent');
  const agentId = agentIdx >= 0 ? argv[agentIdx + 1]! : (process.env.AWM_AGENT_ID ?? 'claude-code');
  const { store, path } = await openStore();
  try {
    const activation = new ActivationEngine(store as any);
    console.log(`Calibrating the abstention gate for agent "${agentId}" on ${path} … (about a minute)`);
    const t0 = Date.now();
    const model = await calibrateGate(store as any, activation, agentId);
    if (!model) {
      console.error(`Not calibrated: the agent needs at least ${MIN_STORE_FOR_CALIBRATION} active memories with enough distinct `
        + 'vocabulary, and the cross-encoder must be available.');
      return 1;
    }
    saveModel(model);
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)} s. Fitted on ${model.stats.positives} synthetic answerable queries `
      + `(${model.stats.positivesCorrect} answered correctly) and ${model.stats.nulls} synthetic no-answer queries `
      + `from ${model.storeSize} memories.`);
    console.log(`  answer at ≥ ${model.answerAt.toFixed(2)} · low signal from ${model.withholdBelow.toFixed(2)} · withhold below`);
    if (!gateEnabled()) console.log('  The gate is OFF. Set AWM_ABSTAIN_GATE=calibrated in the AWM server environment to use it.');
    return 0;
  } finally {
    await (store as any).close?.();
  }
}
