import { describe, it, expect } from 'vitest';
import { strengthenAssociation, decayAssociation, CoActivationBuffer } from '../../src/core/hebbian.js';

describe('Hebbian strengthening', () => {
  it('increases weight on co-activation', () => {
    const before = 0.5;
    const after = strengthenAssociation(before);
    expect(after).toBeGreaterThan(before);
  });

  it('stronger signal produces larger increase', () => {
    const weakSignal = strengthenAssociation(0.5, 0.5);
    const strongSignal = strengthenAssociation(0.5, 2.0);
    expect(strongSignal).toBeGreaterThan(weakSignal);
  });

  it('respects maximum weight cap', () => {
    let weight = 1.0;
    for (let i = 0; i < 1000; i++) {
      weight = strengthenAssociation(weight, 1.0, 0.5);
    }
    expect(weight).toBeLessThanOrEqual(100);
  });

  it('very small weights still strengthen', () => {
    const after = strengthenAssociation(0.001);
    expect(after).toBeGreaterThan(0.001);
  });
});

describe('Association decay', () => {
  it('weight decreases over time without activation', () => {
    const before = 0.8;
    const after = decayAssociation(before, 7); // 1 scale period
    expect(after).toBeLessThan(before);
    // Power-law decay: (1 + 7/7)^(-0.8) ≈ 0.574 → 0.8 * 0.574 ≈ 0.46
    // More lenient than exponential half-life — retains more at longer intervals
    expect(after).toBeGreaterThan(before * 0.4);
    expect(after).toBeLessThan(before * 0.7);
  });

  it('no decay at zero days', () => {
    const weight = 0.8;
    const after = decayAssociation(weight, 0);
    expect(after).toBeCloseTo(weight, 5);
  });

  it('respects minimum weight floor', () => {
    const after = decayAssociation(0.01, 365);
    expect(after).toBeGreaterThan(0);
  });

  it('shorter half-life decays faster', () => {
    const slow = decayAssociation(0.8, 10, 14);
    const fast = decayAssociation(0.8, 10, 3);
    expect(fast).toBeLessThan(slow);
  });
});

describe('CoActivationBuffer', () => {
  it('records entries and finds co-activated pairs', () => {
    const buf = new CoActivationBuffer(10);
    buf.pushBatch(['a', 'b', 'c']);
    const pairs = buf.getCoActivatedPairs(10_000);
    expect(pairs.length).toBe(3); // a-b, a-c, b-c
  });

  it('respects max buffer size', () => {
    const buf = new CoActivationBuffer(3);
    buf.pushBatch(['a', 'b', 'c', 'd', 'e']);
    // Only last 3 should remain
    const pairs = buf.getCoActivatedPairs(10_000);
    const ids = new Set(pairs.flat());
    expect(ids.has('a')).toBe(false);
    expect(ids.has('b')).toBe(false);
  });

  it('does not pair an engram with itself', () => {
    const buf = new CoActivationBuffer(10);
    buf.push('a');
    buf.push('a');
    const pairs = buf.getCoActivatedPairs(10_000);
    expect(pairs.length).toBe(0);
  });

  it('clear empties the buffer', () => {
    const buf = new CoActivationBuffer(10);
    buf.pushBatch(['a', 'b']);
    buf.clear();
    expect(buf.getCoActivatedPairs(10_000).length).toBe(0);
  });
});
