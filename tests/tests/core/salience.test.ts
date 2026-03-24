import { describe, it, expect } from 'vitest';
import { evaluateSalience } from '../../src/core/salience.js';

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
