import { describe, it, expect } from 'vitest';
import { buildPrimeInjection, PRIME_DEFAULTS, type PrimeCandidate } from '../../src/hooks/prime.js';
import { estimateTokens } from '../../src/core/token-budget.js';

function cand(score: number, concept: string, content: string, confidence?: number): PrimeCandidate {
  return { engram: { id: `id-${concept}`, concept, content }, score, confidence };
}

describe('buildPrimeInjection — abstention (the property that matters most)', () => {
  it('injects nothing when there are no candidates', () => {
    const p = buildPrimeInjection([]);
    expect(p.inject).toBe('');
    expect(p.reason).toBe('no-results');
  });

  it('injects nothing when set confidence is below threshold', () => {
    // This runs on EVERY prompt. At AWM's measured ~65% recall accuracy, an
    // unconditional injector would spend tokens on noise roughly a third of the
    // time, every time. Silence has to be the default.
    const c = [cand(0.9, 'a', 'content', 0.05), cand(0.8, 'b', 'content', 0.05)];
    const p = buildPrimeInjection(c);
    expect(p.inject).toBe('');
    expect(p.reason).toBe('low-confidence');
    expect(p.tokens).toBe(0);
  });

  it('injects when confidence clears the threshold', () => {
    const c = [cand(0.9, 'alpha', 'the alpha decision was made in March', 0.8)];
    const p = buildPrimeInjection(c);
    expect(p.inject).toContain('alpha');
    expect(p.kept).toBe(1);
    expect(p.reason).toBeUndefined();
  });

  it('still primes when confidence is absent (older stores)', () => {
    const c = [cand(0.9, 'alpha', 'no confidence field present')];
    const p = buildPrimeInjection(c);
    expect(p.inject).toContain('alpha');
  });

  it('drops individual low-scoring results even in a confident set', () => {
    const c = [cand(0.9, 'keep', 'strong match', 0.9), cand(0.01, 'drop', 'weak match', 0.9)];
    const p = buildPrimeInjection(c);
    expect(p.inject).toContain('keep');
    expect(p.inject).not.toContain('drop');
  });

  it('abstains when every result is below minScore', () => {
    const c = [cand(0.01, 'a', 'weak', 0.9), cand(0.02, 'b', 'weak', 0.9)];
    const p = buildPrimeInjection(c);
    expect(p.inject).toBe('');
    expect(p.reason).toBe('low-confidence');
  });
});

describe('buildPrimeInjection — budget', () => {
  it('never exceeds the token cap', () => {
    const c = Array.from({ length: 12 }, (_, i) =>
      cand(0.9 - i * 0.01, `c${i}`, 'word '.repeat(120), 0.9));
    for (const budget of [800, 400, 200, 120]) {
      const p = buildPrimeInjection(c, { maxTokens: budget });
      expect(estimateTokens(p.inject)).toBeLessThanOrEqual(budget);
    }
  });

  it('reports budget-too-small rather than injecting a bare header', () => {
    const c = [cand(0.9, 'x', 'word '.repeat(400), 0.9)];
    const p = buildPrimeInjection(c, { maxTokens: 30 });
    expect(p.inject).toBe('');
    expect(p.reason).toBe('budget-too-small');
  });

  it('defaults are conservative enough for per-prompt use', () => {
    expect(PRIME_DEFAULTS.maxTokens).toBeLessThanOrEqual(800);
    expect(PRIME_DEFAULTS.minConfidence).toBeGreaterThan(0);
  });
});

describe('buildPrimeInjection — injected text', () => {
  it('labels the block as memory, not user input', () => {
    // The agent must not mistake recalled memory for something the user said.
    const p = buildPrimeInjection([cand(0.9, 'alpha', 'body', 0.9)]);
    expect(p.inject).toMatch(/AWM/);
    expect(p.inject).toMatch(/not user input/i);
  });

  it('carries the engram id so the agent can act on it', () => {
    const p = buildPrimeInjection([cand(0.9, 'alpha', 'body', 0.9)]);
    expect(p.inject).toContain('id-alpha');
  });

  it('prefers the compact summary when one is present', () => {
    const c: PrimeCandidate = {
      engram: { id: 'i', concept: 'k', content: 'THE VERY LONG FULL CONTENT'.repeat(20) },
      score: 0.9, confidence: 0.9, summary: 'short summary',
    };
    const p = buildPrimeInjection([c]);
    expect(p.inject).toContain('short summary');
    expect(p.inject).not.toContain('THE VERY LONG FULL CONTENT');
  });
});
