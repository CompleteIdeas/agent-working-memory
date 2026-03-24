import { describe, it, expect } from 'vitest';
import { baseLevelActivation, softplus, compositeScore } from '../../src/core/decay.js';

describe('ACT-R Base-Level Activation', () => {
  it('returns higher activation for frequently accessed memories', () => {
    const low = baseLevelActivation(1, 5);
    const high = baseLevelActivation(20, 5);
    expect(high).toBeGreaterThan(low);
  });

  it('returns higher activation for recent memories', () => {
    const old = baseLevelActivation(5, 30);
    const recent = baseLevelActivation(5, 1);
    expect(recent).toBeGreaterThan(old);
  });

  it('never-accessed memory still has some activation when new', () => {
    const score = baseLevelActivation(0, 0.01);
    expect(score).toBeGreaterThan(0);
  });

  it('handles zero access count gracefully', () => {
    const score = baseLevelActivation(0, 10);
    expect(Number.isFinite(score)).toBe(true);
  });

  it('decay exponent controls how fast old memories fade', () => {
    const slowDecay = baseLevelActivation(5, 30, 0.3);
    const fastDecay = baseLevelActivation(5, 30, 0.8);
    expect(slowDecay).toBeGreaterThan(fastDecay);
  });
});

describe('softplus', () => {
  it('is always positive', () => {
    expect(softplus(-10)).toBeGreaterThan(0);
    expect(softplus(0)).toBeGreaterThan(0);
    expect(softplus(10)).toBeGreaterThan(0);
  });

  it('approximates x for large positive x', () => {
    expect(softplus(100)).toBeCloseTo(100, 0);
  });

  it('is approximately ln(2) at x=0', () => {
    expect(softplus(0)).toBeCloseTo(Math.log(2), 5);
  });
});

describe('compositeScore', () => {
  it('zero content match produces zero composite', () => {
    const score = compositeScore({
      contentMatch: 0,
      accessCount: 10,
      ageDays: 1,
      hebbianBoost: 0.5,
      confidence: 0.9,
    });
    expect(score).toBe(0);
  });

  it('zero confidence produces zero composite', () => {
    const score = compositeScore({
      contentMatch: 0.8,
      accessCount: 10,
      ageDays: 1,
      hebbianBoost: 0.5,
      confidence: 0,
    });
    expect(score).toBe(0);
  });

  it('higher content match produces higher score', () => {
    const base = { accessCount: 5, ageDays: 2, hebbianBoost: 0, confidence: 0.8 };
    const low = compositeScore({ ...base, contentMatch: 0.2 });
    const high = compositeScore({ ...base, contentMatch: 0.9 });
    expect(high).toBeGreaterThan(low);
  });

  it('hebbian boost increases score', () => {
    const base = { contentMatch: 0.5, accessCount: 5, ageDays: 2, confidence: 0.8 };
    const noBoost = compositeScore({ ...base, hebbianBoost: 0 });
    const withBoost = compositeScore({ ...base, hebbianBoost: 1.0 });
    expect(withBoost).toBeGreaterThan(noBoost);
  });
});
