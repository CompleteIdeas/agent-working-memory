// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * 0.22: questions offered with a write land on the memory that holds the fact, whichever path
 * the write took, cleaned and capped, redacted like content, and searchable by keyword.
 *
 * Run: npx vitest run tests/core/write-questions.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { normalizeQuestions } from '../../src/core/questions.js';

const AGENT = 'write-q';
const MCP = { surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3, eventType: 'observation' as const };

describe('normalizeQuestions', () => {
  it('trims, drops too-short and duplicate questions, caps at five', () => {
    expect(normalizeQuestions(['  How do I   deploy it?  ', 'how do i deploy it?', 'short', 42 as any, 'Where is the backup kept?',
      'Q three is long enough', 'Q four is long enough', 'Q five is long enough', 'Q six is long enough']))
      .toEqual(['How do I deploy it?', 'Where is the backup kept?', 'Q three is long enough', 'Q four is long enough', 'Q five is long enough']);
    expect(normalizeQuestions('not a list')).toEqual([]);
  });
});

describe('questions through performWrite', () => {
  let tmp: string; let store: EngramStore; let engines: any;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-wq-'));
    store = new EngramStore(join(tmp, 'm.db'));
    engines = { store, connectionEngine: new ConnectionEngine(store as any, new ActivationEngine(store as any)) };
  });
  afterEach(() => { store.close(); rmSync(tmp, { recursive: true, force: true }); });

  it('a created memory carries its questions and is found by them', async () => {
    const res = await performWrite(engines, {
      agentId: AGENT, concept: 'RosterKeep deploy command', content: 'Deploy with railway up --service rowos-app --ci after migrations.',
      questions: ['How do I ship the rowing club app to production?', 'why?'], ...MCP,
    } as any);
    expect(res.questions?.kept).toEqual(['How do I ship the rowing club app to production?']);
    expect(res.questions?.dropped).toEqual([{ question: 'why?', reason: 'invalid' }]);
    expect(store.getEngram(res.engram.id)?.questions).toEqual(['How do I ship the rowing club app to production?']);
    expect(store.searchBM25WithRank(AGENT, 'ship rowing club production', 5).map((r) => r.engram.id)).toEqual([res.engram.id]);
  });

  it('a write that reinforces an existing memory adds its questions to that memory, up to five', async () => {
    const base = { agentId: AGENT, concept: 'Medical key backup', content: 'MEDICAL_ENCRYPTION_KEY must be escrowed in the password manager.', ...MCP } as any;
    const first = await performWrite(engines, { ...base, questions: ['Where is the medical key backed up?', 'What happens if the key is lost?',
      'Who holds the escrow copy?', 'Which manager stores the secret?'] });
    const second = await performWrite(engines, { ...base, questions: ['Where is the medical key backed up?', 'How do I rotate the medical key?',
      'Is there a second copy anywhere?'] });
    expect(second.action).toBe('reinforce');
    expect(second.engram.id).toBe(first.engram.id);
    expect(store.getEngram(first.engram.id)?.questions).toEqual(['Where is the medical key backed up?', 'What happens if the key is lost?',
      'Who holds the escrow copy?', 'Which manager stores the secret?', 'How do I rotate the medical key?']);
    expect(second.questions?.dropped).toEqual([{ question: 'Is there a second copy anywhere?', reason: 'over-limit' }]);
  });

  it('a secret in a question is redacted before it is stored or searched', async () => {
    const secret = ['sk', '_live_', '51Hx9Tq2LmN8vB4kP7rS0dWz'].join('');
    const res = await performWrite(engines, {
      agentId: AGENT, concept: 'Stripe key rotation', content: 'The live key was rotated on 22 October.',
      questions: [`Is ${secret} still the live key?`], ...MCP,
    } as any);
    expect(store.getEngram(res.engram.id)?.questions?.[0]).not.toContain(secret);
    expect(res.redaction?.some((f) => f.type === 'stripe_key')).toBe(true);
  });

  it('a write without questions leaves the field empty and reports nothing', async () => {
    const res = await performWrite(engines, { agentId: AGENT, concept: 'Plain note', content: 'Nothing to ask here, just a fact about lanes.', ...MCP } as any);
    expect(res.questions).toBeUndefined();
    expect(store.getEngram(res.engram.id)?.questions).toBeNull();
  });
});
