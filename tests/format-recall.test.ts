import { describe, it, expect } from 'vitest';
import { formatRecallResultLine } from '../src/core/format-recall.js';
import type { ActivationResult } from '../src/types/engram.js';
import type { Engram } from '../src/types/engram.js';

// Minimal Engram fixture — only the fields format-recall.ts actually reads.
function engram(overrides: Partial<Engram> = {}): Engram {
  return {
    id: 'e1111111-1111-1111-1111-111111111111',
    concept: 'test concept',
    content: 'test content',
    ...overrides,
  } as Engram;
}

function result(overrides: Partial<ActivationResult> = {}): ActivationResult {
  return {
    engram: engram(),
    score: 0.624,
    phaseScores: {} as ActivationResult['phaseScores'],
    why: '',
    associations: [],
    ...overrides,
  };
}

describe('formatRecallResultLine (0.12.1 — engram id in recall output)', () => {
  it('includes the engram id, placed right after the score', () => {
    const line = formatRecallResultLine(
      result({ engram: engram({ id: 'abc12345-0000-0000-0000-000000000000' }) }),
      0,
    );
    expect(line).toContain('[id: abc12345-0000-0000-0000-000000000000]');
    // Right after the score, before the (optional) validity/body — not
    // appended at the end where a long body could bury it.
    expect(line.indexOf('[id:')).toBeLessThan(line.indexOf(': test content'));
  });

  it('numbers results starting at 1, not the array index', () => {
    const line = formatRecallResultLine(result(), 2);
    expect(line.startsWith('3. **test concept**')).toBe(true);
  });

  it('still renders validity and superseded-chain alongside the id', () => {
    const line = formatRecallResultLine(
      result({
        engram: engram({
          id: 'e2222222-2222-2222-2222-222222222222',
          validTo: '2026-09-01',
          supersededBy: 'e3333333-3333-3333-3333-333333333333',
        }),
      }),
      0,
    );
    expect(line).toContain('[id: e2222222-2222-2222-2222-222222222222]');
    expect(line).toContain('[valid until 2026-09-01]');
    expect(line).toContain('⚠ SUPERSEDED by e3333333-3333-3333-3333-333333333333');
  });

  it('uses the summary field over full content when granularity produced one', () => {
    const line = formatRecallResultLine(
      result({ summary: 'short summary', engram: engram({ content: 'much longer full content' }) }),
      0,
    );
    expect(line).toContain('short summary');
    expect(line).not.toContain('much longer full content');
  });

  it('feeds directly into memory_feedback / memory_supersede shape: id is a bare UUID, no surrounding punctuation glued on', () => {
    const id = 'f4444444-4444-4444-4444-444444444444';
    const line = formatRecallResultLine(result({ engram: engram({ id }) }), 0);
    const match = /\[id: ([0-9a-f-]{36})\]/.exec(line);
    expect(match?.[1]).toBe(id);
  });
});
