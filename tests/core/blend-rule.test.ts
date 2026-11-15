// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * 0.22.4 final-order rule: the cross-encoder's order stands when it is sure (logit margin), and
 * keyword queries weight the vector rank at a quarter. Effect on ranking is measured by
 * tests/realstore-eval/blend-study.ts; these pin the decisions.
 *
 * Run: npx vitest run tests/core/blend-rule.test.ts
 */
import { describe, it, expect } from 'vitest';
import { logit, crossEncoderSure, sureThreshold, keywordVectorWeight } from '../../src/core/blend-rule.js';

describe('blend rule', () => {
  it('measures sureness in logit space, where saturated scores keep their gap', () => {
    // 0.99 vs 0.95 is a 0.04 gap in probability but 1.65 in logit: sure for a keyword query.
    expect(logit(0.99) - logit(0.95)).toBeCloseTo(1.65, 1);
    expect(crossEncoderSure([0.95, 0.99, 0.2], false, {})).toBe(true);
    // Natural queries need 1.5; 1.65 clears it too.
    expect(crossEncoderSure([0.95, 0.99], true, {})).toBe(true);
    // 0.97 vs 0.95: logit gap 0.53 — not sure, so the blend decides.
    expect(crossEncoderSure([0.97, 0.95], false, {})).toBe(false);
  });

  it('uses the per-shape thresholds and honours the overrides', () => {
    expect(sureThreshold(false, {})).toBe(1);
    expect(sureThreshold(true, {})).toBe(1.5);
    // logit gap between 0.9 and 0.75 is about 1.10: sure for keyword, not for natural.
    expect(crossEncoderSure([0.9, 0.75], false, {})).toBe(true);
    expect(crossEncoderSure([0.9, 0.75], true, {})).toBe(false);
    expect(crossEncoderSure([0.9, 0.75], false, { AWM_BLEND_SURE_KEYWORD: '2' })).toBe(false);
  });

  it('AWM_BLEND_SURE=off and a single candidate always blend', () => {
    expect(crossEncoderSure([0.999, 0.1], false, { AWM_BLEND_SURE: 'off' })).toBe(false);
    expect(crossEncoderSure([0.999], false, {})).toBe(false);
    expect(crossEncoderSure([], true, {})).toBe(false);
  });

  it('clamps 0 and 1 so identical saturated scores are not "sure"', () => {
    expect(Number.isFinite(logit(1))).toBe(true);
    expect(crossEncoderSure([1, 1], false, {})).toBe(false);
  });

  it('a keyword re-blend weights the vector rank at a quarter unless both channels rank it top two', () => {
    expect(keywordVectorWeight(5, 0, {})).toBe(0.25);   // vector #1, BM25 #6: the public-store failure
    expect(keywordVectorWeight(1, 0, {})).toBe(1);      // both channels top two: full weight
    expect(keywordVectorWeight(0, 1, {})).toBe(1);
    expect(keywordVectorWeight(-1, 0, {})).toBe(0.25);  // BM25 missed it
    expect(keywordVectorWeight(2, 2, { AWM_BLEND_AGREE_RANK: '2' })).toBe(1);
    expect(keywordVectorWeight(5, 0, { AWM_BLEND_VEC_KEYWORD: '1' })).toBe(1);
  });
});
