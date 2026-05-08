import { describe, it, expect } from 'vitest';
import { evaluateSalience, detectVerifiedFinding } from '../../src/core/salience.js';

describe('Salience Filter', () => {
  it('high surprise + decision = active disposition', () => {
    const result = evaluateSalience({
      content: 'Agent chose path A over path B after unexpected error',
      eventType: 'decision',
      surprise: 0.8,
      decisionMade: true,
      causalDepth: 0.3,
      resolutionEffort: 0.5,
    });
    expect(result.disposition).toBe('active');
    expect(result.score).toBeGreaterThan(0.4);
    expect(result.reasonCodes).toContain('high_surprise');
    expect(result.reasonCodes).toContain('decision_point');
  });

  it('low-signal observation = discard', () => {
    const result = evaluateSalience({
      content: 'File was read successfully',
      eventType: 'observation',
      surprise: 0,
      decisionMade: false,
      causalDepth: 0,
      resolutionEffort: 0,
      novelty: 0.1, // duplicate info
    });
    expect(result.disposition).toBe('discard');
    expect(result.score).toBeLessThan(0.2);
  });

  it('medium-signal friction event with default novelty = active (new info gets stored)', () => {
    const result = evaluateSalience({
      content: 'API returned 429, retried after 1s',
      eventType: 'friction',
      surprise: 0.2,
      decisionMade: false,
      causalDepth: 0,
      resolutionEffort: 0.3,
      // novelty defaults to 0.8 — new info should be stored
    });
    expect(result.disposition).toBe('active');
  });

  it('medium-signal friction event that is a duplicate = staging', () => {
    const result = evaluateSalience({
      content: 'API returned 429, retried after 1s',
      eventType: 'friction',
      surprise: 0.2,
      decisionMade: false,
      causalDepth: 0,
      resolutionEffort: 0.3,
      novelty: 0.1, // near-duplicate exists
    });
    expect(result.disposition).toBe('staging');
  });

  it('causal discovery scores high', () => {
    const result = evaluateSalience({
      content: 'Race condition caused by shared mutable state in async context',
      eventType: 'causal',
      surprise: 0.5,
      decisionMade: false,
      causalDepth: 0.9,
      resolutionEffort: 0.7,
    });
    expect(result.disposition).toBe('active');
    expect(result.reasonCodes).toContain('causal_insight');
  });

  it('persists all feature scores in result', () => {
    const result = evaluateSalience({
      content: 'test',
      eventType: 'surprise',
      surprise: 0.6,
      decisionMade: true,
      causalDepth: 0.4,
      resolutionEffort: 0.3,
    });
    expect(result.features.surprise).toBe(0.6);
    expect(result.features.decisionMade).toBe(true);
    expect(result.features.causalDepth).toBe(0.4);
    expect(result.features.resolutionEffort).toBe(0.3);
    expect(result.features.eventType).toBe('surprise');
  });

  it('score never exceeds 1.0', () => {
    const result = evaluateSalience({
      content: 'max everything',
      eventType: 'surprise',
      surprise: 1.0,
      decisionMade: true,
      causalDepth: 1.0,
      resolutionEffort: 1.0,
      novelty: 1.0,
    });
    expect(result.score).toBeLessThanOrEqual(1.0);
  });

  it('custom thresholds change disposition boundaries', () => {
    const result = evaluateSalience(
      { content: 'test', surprise: 0.3, eventType: 'observation', novelty: 0.1 },
      0.8,  // very high active threshold
      0.05  // very low staging threshold
    );
    // Low novelty + low surprise = low score, should be staging with these thresholds
    expect(result.disposition).toBe('staging');
  });

  // --- Novelty-specific tests ---

  it('novel information boosts score above discard', () => {
    // Without novelty: observation with low surprise = discard
    const duplicate = evaluateSalience({
      content: 'Education module has gaps in coverage',
      eventType: 'observation',
      surprise: 0.2,
      novelty: 0.1, // near-duplicate
    });

    const novel = evaluateSalience({
      content: 'Education module has gaps in coverage',
      eventType: 'observation',
      surprise: 0.2,
      novelty: 1.0, // completely new
    });

    expect(novel.score).toBeGreaterThan(duplicate.score);
    expect(novel.score - duplicate.score).toBeGreaterThanOrEqual(0.15); // meaningful boost
    expect(novel.reasonCodes).toContain('novel_information');
    expect(duplicate.reasonCodes).toContain('redundant_information');
  });

  it('completely novel observation with default params goes to staging or active (not discard)', () => {
    // This is the scenario from the bug: agent writes a memory with defaults, it gets discarded
    const result = evaluateSalience({
      content: 'Education admin pages (course CRUD) are missing. Compliance dashboard is a launch blocker.',
      eventType: 'observation',
      // All other params default — surprise 0, decision false, causal 0, effort 0
      novelty: 1.0, // but it's completely new information
    });
    expect(result.disposition).not.toBe('discard');
  });
});

// --- Novelty curve regression (2026-05-05 production fix) ---
// Previous curve: novelty = max(0.1, 1 - topScore) — pinned at 0.1 for any
// populated DB because BM25 normalization put almost every match in topScore≥0.9.
// New curve: novelty = max(0.05, 1 - topScore²) — quadratic dampening preserves
// signal across the mid-range so the salience filter still discriminates after
// the DB has thousands of memories.
import { computeNovelty } from '../../src/core/salience.js';

interface FakeMatch { engram: { concept?: string; createdAt?: Date }; bm25Score: number; }

function fakeStore(matches: FakeMatch[]) {
  return {
    searchBM25WithRank(_agentId: string, _q: string, _k: number) {
      return matches;
    },
    // satisfy the EngramStore type at runtime — these are unused in computeNovelty
  } as unknown as Parameters<typeof computeNovelty>[0];
}

describe('Novelty curve (production-tuned)', () => {
  it('returns 1.0 when nothing similar exists', () => {
    const n = computeNovelty(fakeStore([]), 'agent', 'concept', 'content');
    expect(n).toBe(1.0);
  });

  it('topScore=0.95 → near-floor novelty (suppress true dupes)', () => {
    const n = computeNovelty(fakeStore([{ engram: { concept: 'x' }, bm25Score: 0.95 }]), 'agent', 'concept', 'content');
    expect(n).toBeGreaterThan(0.05);
    expect(n).toBeLessThan(0.15);
  });

  it('topScore=0.60 → meaningful novelty (loose match)', () => {
    const n = computeNovelty(fakeStore([{ engram: { concept: 'x' }, bm25Score: 0.6 }]), 'agent', 'concept', 'content');
    expect(n).toBeGreaterThan(0.55);
    expect(n).toBeLessThan(0.70);
  });

  it('topScore=0.30 → high novelty (different topic)', () => {
    const n = computeNovelty(fakeStore([{ engram: { concept: 'x' }, bm25Score: 0.3 }]), 'agent', 'concept', 'content');
    expect(n).toBeGreaterThan(0.85);
  });

  it('exact concept match within 30d → penalized', () => {
    const recent = new Date();
    const n = computeNovelty(
      fakeStore([{ engram: { concept: 'My Concept', createdAt: recent }, bm25Score: 0.5 }]),
      'agent', 'My Concept', 'content'
    );
    // Without penalty: 1 - 0.25 = 0.75. With 0.3 penalty: 0.45.
    expect(n).toBeGreaterThan(0.40);
    expect(n).toBeLessThan(0.50);
  });

  it('exact concept match older than 30d → not penalized', () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const n = computeNovelty(
      fakeStore([{ engram: { concept: 'My Concept', createdAt: old }, bm25Score: 0.5 }]),
      'agent', 'My Concept', 'content'
    );
    // 1 - 0.25 = 0.75, no penalty
    expect(n).toBeGreaterThan(0.70);
  });
});

describe('detectVerifiedFinding', () => {
  it('matches a USEF batch summary with verb + multiple IDs + dates', () => {
    const content = 'Submitted 6 events to USEF API on 2026-05-07. Events: 18969, 18971, 18972 finalized.';
    expect(detectVerifiedFinding(content)).toBe(true);
  });

  it('matches a Freshdesk triage record', () => {
    const content = 'Triaged 22 tickets on 2026-05-07. Resolved tickets #18330, #18331, #18332.';
    expect(detectVerifiedFinding(content)).toBe(true);
  });

  it('rejects content without an action verb', () => {
    const content = 'Some thoughts on USEF results from 2026-05-07. Events 18969 and 18971 came up.';
    expect(detectVerifiedFinding(content)).toBe(false);
  });

  it('rejects content with verb but no concrete identifiers', () => {
    const content = 'Submitted some changes to the production system.';
    expect(detectVerifiedFinding(content)).toBe(false);
  });

  it('rejects empty / non-string input', () => {
    expect(detectVerifiedFinding('')).toBe(false);
    expect(detectVerifiedFinding(null as unknown as string)).toBe(false);
  });

  it('low-novelty operational record gets active disposition (not discard)', () => {
    const result = evaluateSalience({
      content: 'Submitted 6 events to USEF on 2026-05-07. Events 18969, 18971, 18972, 18973 finalized.',
      novelty: 0.1, // BM25 says it looks like a duplicate (terminology repeats)
    });
    // Without the verified-finding floor, this would discard at ~0.045
    expect(result.disposition).toBe('active');
    expect(result.score).toBeGreaterThanOrEqual(0.45);
    expect(result.reasonCodes).toContain('auto:verified_finding');
  });

  it('ordinary low-novelty observation still discards', () => {
    const result = evaluateSalience({
      content: 'Looking at the events from earlier this week.',
      novelty: 0.1,
    });
    expect(result.disposition).toBe('discard');
  });
});
