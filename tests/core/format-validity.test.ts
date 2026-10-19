import { describe, it, expect } from 'vitest';
import { formatRecallResultLine } from '../../src/core/format-recall.js';

/** The smallest ActivationResult the formatter needs. */
function result(engram: Record<string, unknown>) {
  return {
    engram: {
      id: 'e1',
      concept: 'Studio meeting place',
      content: 'The studio is closed; the class meets at the cafe.',
      ...engram,
    },
    score: 0.42,
  } as any;
}

const MARCH = Date.parse('2026-03-10T12:00:00Z');

describe('formatRecallResultLine — temporal validity', () => {
  it('labels a memory past its valid_to as EXPIRED, not "valid until"', () => {
    const line = formatRecallResultLine(result({ validTo: '2026-01-15' }), 0, MARCH);
    expect(line).toContain('⚠ EXPIRED 2026-01-15');
    expect(line).not.toContain('[valid until');
  });

  it('keeps "[valid until …]" while the window holds', () => {
    const line = formatRecallResultLine(result({ validTo: '2026-06-30' }), 0, MARCH);
    expect(line).toContain('[valid until 2026-06-30]');
    expect(line).not.toContain('EXPIRED');
  });

  it('labels a memory before its valid_from as not yet valid', () => {
    const line = formatRecallResultLine(result({ validFrom: '2026-11-03' }), 0, MARCH);
    expect(line).toContain('[not yet valid — from 2026-11-03]');
  });

  it('says nothing about validity when no bounds are set', () => {
    const line = formatRecallResultLine(result({}), 0, MARCH);
    expect(line).not.toMatch(/valid|EXPIRED/);
  });
});
