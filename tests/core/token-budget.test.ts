import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  packRecallByBudget,
  formatTokenFooter,
} from '../../src/core/token-budget.js';
import type { ActivationResult } from '../../src/types/engram.js';

// Minimal ActivationResult good enough for the packer, which only reads
// `.score` and whatever the supplied formatter reads.
function result(score: number, body: string, id = 'x'): ActivationResult {
  return {
    engram: { id, concept: 'c', content: body } as any,
    score,
    phaseScores: {} as any,
    why: '',
    associations: [],
  };
}

// Deterministic formatter so token counts in the tests are predictable.
const fmt = (r: ActivationResult, i: number) => `${i + 1}. ${r.engram.content}`;

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('scales with length', () => {
    const short = estimateTokens('one two three');
    const long = estimateTokens('one two three '.repeat(20));
    expect(long).toBeGreaterThan(short);
  });

  it('over-estimates rather than under-estimates (budget safety)', () => {
    // 400 chars of single characters: chars/4 = 100, words*1.3 = 260.
    // The larger must win, so we never silently blow a budget.
    const text = 'a '.repeat(200);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
  });
});

describe('packRecallByBudget', () => {
  it('handles an empty result set', () => {
    const p = packRecallByBudget([], fmt, 100);
    expect(p).toEqual({ lines: [], kept: 0, total: 0, tokens: 0, withheldTokens: 0 });
  });

  it('returns everything when no budget is given, but still accounts', () => {
    const rs = [result(0.9, 'alpha'), result(0.5, 'beta')];
    const p = packRecallByBudget(rs, fmt);
    expect(p.kept).toBe(2);
    expect(p.total).toBe(2);
    expect(p.tokens).toBeGreaterThan(0);
    expect(p.withheldTokens).toBe(0);
  });

  it('returns everything when it already fits', () => {
    const rs = [result(0.9, 'alpha'), result(0.5, 'beta')];
    const p = packRecallByBudget(rs, fmt, 10_000);
    expect(p.kept).toBe(2);
    expect(p.withheldTokens).toBe(0);
  });

  it('drops results that do not fit and reports what was withheld', () => {
    const rs = [
      result(0.9, 'word '.repeat(100)),
      result(0.8, 'word '.repeat(100)),
      result(0.7, 'word '.repeat(100)),
    ];
    const all = packRecallByBudget(rs, fmt);
    const budget = Math.floor(all.tokens / 2);
    const p = packRecallByBudget(rs, fmt, budget);

    expect(p.kept).toBeLessThan(p.total);
    expect(p.tokens).toBeLessThanOrEqual(budget);
    expect(p.withheldTokens).toBeGreaterThan(0);
    expect(p.tokens + p.withheldTokens).toBe(all.tokens);
  });

  it('gives the top-scored result first refusal even when it is long', () => {
    // Top result is long; the others are short and would win on pure density.
    const rs = [
      result(0.95, 'LONGTOP ' + 'word '.repeat(60)),
      result(0.40, 'short a'),
      result(0.39, 'short b'),
    ];
    const topTokens = estimateTokens(fmt(rs[0], 0));
    const p = packRecallByBudget(rs, fmt, topTokens + 5);

    expect(p.lines.join('\n')).toContain('LONGTOP');
    expect(p.kept).toBeGreaterThanOrEqual(1);
  });

  it('preserves score order in the output even though it selects by density', () => {
    const rs = [
      result(0.95, 'first ' + 'w '.repeat(40)),
      result(0.90, 'second'),
      result(0.85, 'third'),
    ];
    const p = packRecallByBudget(rs, fmt, 10_000);
    const idx = (s: string) => p.lines.findIndex(l => l.includes(s));
    expect(idx('first')).toBeLessThan(idx('second'));
    expect(idx('second')).toBeLessThan(idx('third'));
  });

  it('keeps scanning after a result that does not fit (skip, not stop)', () => {
    // A huge second result must not prevent a tiny third from being included.
    const rs = [
      result(0.9, 'tiny one'),
      result(0.8, 'HUGE ' + 'word '.repeat(500)),
      result(0.7, 'tiny two'),
    ];
    const p = packRecallByBudget(rs, fmt, 60);
    const text = p.lines.join('\n');
    expect(text).toContain('tiny one');
    expect(text).toContain('tiny two');
    expect(text).not.toContain('HUGE');
  });

  it('reserves tokens for the rest of the reply (footer + peer suffix)', () => {
    // Regression for the overrun the end-to-end eval caught: budgets of
    // 600/250/80 came back as 601/256/95 because the footer was unbudgeted.
    const rs = [result(0.9, 'word '.repeat(30)), result(0.8, 'word '.repeat(30))];
    const noReserve = packRecallByBudget(rs, fmt, 200, 0);
    const withReserve = packRecallByBudget(rs, fmt, 200, 40);
    expect(withReserve.tokens).toBeLessThanOrEqual(200 - 40);
    expect(withReserve.tokens).toBeLessThanOrEqual(noReserve.tokens);
  });

  it('can admit nothing when the reserve consumes the whole budget', () => {
    const rs = [result(0.9, 'word '.repeat(50))];
    const p = packRecallByBudget(rs, fmt, 30, 40);   // reserve exceeds budget
    expect(p.kept).toBe(0);
    expect(p.total).toBe(1);
    expect(p.withheldTokens).toBeGreaterThan(0);
  });

  it('never exceeds the budget across randomised inputs', () => {
    for (let trial = 0; trial < 50; trial++) {
      const n = 1 + (trial % 9);
      const rs = Array.from({ length: n }, (_, i) =>
        result(1 - i * 0.05, 'w '.repeat(1 + ((trial * 7 + i * 13) % 80))));
      const budget = 20 + ((trial * 17) % 300);
      const p = packRecallByBudget(rs, fmt, budget);
      expect(p.tokens).toBeLessThanOrEqual(budget);
      expect(p.kept).toBeLessThanOrEqual(p.total);
    }
  });
});

describe('formatTokenFooter', () => {
  it('is empty when there were no results', () => {
    expect(formatTokenFooter({ lines: [], kept: 0, total: 0, tokens: 0, withheldTokens: 0 })).toBe('');
  });

  it('reports the spend when nothing was dropped', () => {
    const f = formatTokenFooter({ lines: [], kept: 3, total: 3, tokens: 120, withheldTokens: 0 });
    expect(f).toContain('~120 tok');
    expect(f).toContain('3 results');
    expect(f).not.toContain('withheld');
  });

  it('reports budget and withheld tokens when results were dropped', () => {
    const f = formatTokenFooter(
      { lines: [], kept: 2, total: 5, tokens: 300, withheldTokens: 900 }, 320);
    expect(f).toContain('2/5 results');
    expect(f).toContain('budget 320');
    expect(f).toContain('~900 tok withheld');
  });

  it('stays small — the footer must not undo the saving it reports', () => {
    const f = formatTokenFooter(
      { lines: [], kept: 2, total: 5, tokens: 300, withheldTokens: 900 }, 320);
    expect(estimateTokens(f)).toBeLessThan(40);
  });
});
