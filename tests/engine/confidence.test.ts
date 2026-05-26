/**
 * Unit tests for the recall-confidence calculator.
 *
 * Covers: confident-recall shape (sharp cliff + high floor), noisy-recall
 * shape (flat distribution), best-of-bad-bunch trap (sharp but low floor),
 * and edge cases (empty / single-result / two-result).
 */

import { describe, it, expect } from 'vitest';
import { computeRecallConfidence } from '../../src/engine/confidence.js';

describe('computeRecallConfidence', () => {
  it('returns zeroes for an empty result set', () => {
    const r = computeRecallConfidence([]);
    expect(r.confidence).toBe(0);
    expect(r.sharpness).toBe(0);
    expect(r.cliff).toBe(0);
    expect(r.floor).toBe(0);
  });

  it('confident recall: sharp cliff + high floor → high confidence', () => {
    // Top result dominates: 0.9 vs everyone else 0.1.
    const r = computeRecallConfidence([0.9, 0.1, 0.08, 0.06, 0.04, 0.02, 0.02, 0.01, 0.01, 0.01]);
    expect(r.floor).toBeCloseTo(0.9, 5);
    expect(r.sharpness).toBeGreaterThan(0.5);
    expect(r.cliff).toBeGreaterThan(0.9);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('noisy recall: flat distribution → low confidence', () => {
    // All similar scores — no clear winner.
    const r = computeRecallConfidence([0.12, 0.11, 0.10, 0.10, 0.09, 0.09, 0.08, 0.08, 0.07, 0.07]);
    expect(r.sharpness).toBeLessThan(0.15);
    expect(r.cliff).toBeLessThan(0.45);
    expect(r.confidence).toBeLessThan(0.2);
  });

  it('best-of-bad-bunch trap: sharp cliff but low floor → confidence below genuinely-confident', () => {
    // Sharp drop, but absolute scores are all weak.
    const trap = computeRecallConfidence([0.08, 0.005, 0.004, 0.003, 0.002, 0.001, 0.001, 0.001, 0.001, 0.001]);
    expect(trap.cliff).toBeGreaterThan(0.9); // Sharp
    expect(trap.floor).toBeLessThan(0.15);   // Weak
    // Compare against a genuinely confident recall (same shape but stronger floor):
    const confident = computeRecallConfidence([0.85, 0.06, 0.05, 0.04, 0.03, 0.02, 0.02, 0.01, 0.01, 0.01]);
    expect(trap.confidence).toBeLessThan(confident.confidence);
  });

  it('single-result: cliff=0, sharpness=0, confidence anchored low by missing peers', () => {
    const strong = computeRecallConfidence([0.85]);
    expect(strong.cliff).toBe(0);
    expect(strong.sharpness).toBe(0);
    expect(strong.floor).toBeCloseTo(0.85, 5);
    // With only 1 result, two of three signals are zero — confidence is
    // anchored low even with a strong floor. By design: we can't tell whether
    // a single result is a confident answer or a fluke without runner-up
    // comparison.
    expect(strong.confidence).toBeLessThan(0.2);

    const weak = computeRecallConfidence([0.05]);
    expect(weak.confidence).toBeLessThan(0.1);
    expect(weak.confidence).toBeLessThan(strong.confidence);
  });

  it('confidence is in [0, 1] for varied inputs', () => {
    const inputs: number[][] = [
      [1.0, 0.0],
      [0.5, 0.5, 0.5, 0.5, 0.5],
      [0.99, 0.98, 0.97, 0.96, 0.95],
      [0.01, 0.01, 0.01],
      [0.7],
    ];
    for (const s of inputs) {
      const r = computeRecallConfidence(s);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('two-result confident recall: top-1 dominates → meaningful sharpness + cliff', () => {
    const r = computeRecallConfidence([0.8, 0.05]);
    // With only 2 results, mean(top-5) = mean(top-2) = (0.8+0.05)/2 = 0.425;
    // sharpness = (1.88-1)/(1.88+1) ≈ 0.31. Still positive and well above
    // the flat-recall sharpness (~0.05) — that ordering is what matters.
    expect(r.sharpness).toBeGreaterThan(0.25);
    expect(r.cliff).toBeGreaterThan(0.9);
    expect(r.confidence).toBeGreaterThan(0.25);
    const flat = computeRecallConfidence([0.4, 0.38]);
    expect(r.confidence).toBeGreaterThan(flat.confidence);
  });

  it('confidence rises with sharper distributions', () => {
    const flat = computeRecallConfidence([0.3, 0.28, 0.27, 0.26, 0.25, 0.24, 0.23, 0.22, 0.21, 0.20]);
    const sharp = computeRecallConfidence([0.9, 0.2, 0.18, 0.16, 0.14, 0.12, 0.10, 0.08, 0.06, 0.04]);
    expect(sharp.confidence).toBeGreaterThan(flat.confidence);
  });
});
