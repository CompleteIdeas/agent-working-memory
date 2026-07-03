import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPack, INTERVIEW_QUESTIONS } from '../../src/onboard/index.js';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { embedBatch } from '../../src/core/embeddings.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'awm-onboard-'));
  const docs = join(dir, 'docs');
  mkdirSync(docs);
  writeFileSync(join(docs, 'architecture.md'),
    '# Architecture\nThe system uses a queue-based pipeline for background jobs.\n\n' +
    '## Database schema\nThe member table tblMemberDetails has columns member_id and status. Query it with a SQL SELECT.\n\n' +
    '## Deployment\nThe service is deployed on Railway via the awm-deploy build context.\n');
  writeFileSync(join(docs, 'conventions.md'),
    '# Conventions\nAlways verify a fact with a query before stating it as true.\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'acme-app', version: '1.0.0', description: 'An example support app',
    dependencies: { express: '^4.0.0' }, scripts: { build: 'tsc', test: 'vitest' },
  }));
});

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

function opts() {
  return {
    docs: [join(dir, 'docs')], repo: dir, project: 'acme', agentId: 'acme',
    purpose: 'Help the agent answer member support questions accurately.',
  };
}

describe('awm onboard — scan', () => {
  it('extracts one atomic memory per doc heading', () => {
    const concepts = buildPack(opts()).memories.map((m) => m.concept);
    expect(concepts).toContain('Database schema');
    expect(concepts).toContain('Deployment');
    expect(concepts).toContain('Conventions');
    expect(concepts).toContain('Architecture');
  });

  it('captures the memory-system goal as an anchor memory when a purpose is given', () => {
    const goal = buildPack(opts()).memories.find((m) => m.concept.startsWith('Goal of this memory system'));
    expect(goal).toBeTruthy();
    expect(goal!.content).toContain('support questions');
    expect(goal!.tags).toContain('topic=goal');
  });

  it('derives a stack memory from package.json', () => {
    const stack = buildPack(opts()).memories.find((m) => m.concept.startsWith('Project stack'));
    expect(stack).toBeTruthy();
    expect(stack!.content).toContain('express');
    expect(stack!.content).toContain('example support app');
  });

  it('produces import-compatible, canonical, tagged seed memories', () => {
    for (const m of buildPack(opts()).memories) {
      expect(m.agent_id).toBe('acme');
      expect(m.memory_class).toBe('canonical'); // seed bypasses the salience filter
      expect(m.tags).toContain('src=onboarding');
      expect(m.tags).toContain('proj=acme');
      expect(typeof m.concept).toBe('string');
      expect(m.content.length).toBeGreaterThanOrEqual(24);
    }
  });

  it('emits the interview, anchored on the goal question', () => {
    const pack = buildPack(opts());
    expect(pack.questions.length).toBeGreaterThan(3);
    expect(pack.questions[0].toLowerCase()).toContain('goal of this memory system');
    expect(pack.questions).toBe(INTERVIEW_QUESTIONS);
  });

  it('is idempotent — re-running yields identical content-hashed ids', () => {
    const a = buildPack(opts()).memories.map((m) => m.id).sort();
    const b = buildPack(opts()).memories.map((m) => m.id).sort();
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length); // no dupes within a pack
  });
});

describe('awm onboard — cold store becomes warm', () => {
  it('the pack imports into an empty store and recall finds a seeded fact', async () => {
    const dbPath = join(dir, `warm-${Date.now()}.db`);
    const store = new EngramStore(dbPath);
    const activation = new ActivationEngine(store);
    try {
      const pack = buildPack(opts());
      // Import the pack the way `awm import` does: createEngram + embeddings.
      const embeddings = await embedBatch(pack.memories.map((m) => `${m.concept} ${m.content}`));
      pack.memories.forEach((m, i) => {
        store.createEngram({
          agentId: m.agent_id, concept: m.concept, content: m.content,
          tags: m.tags, embedding: embeddings[i], memoryClass: m.memory_class,
        });
      });

      // Cold store is now warm: a fresh agent asks a question, recall surfaces the seed.
      const results = await activation.activate({
        agentId: 'acme', context: 'how do I query the member table', limit: 5, internal: true,
      });
      const hit = results.some((r) =>
        r.engram.content.includes('tblMemberDetails') || r.engram.concept === 'Database schema');
      expect(results.length).toBeGreaterThan(0);
      expect(hit).toBe(true);
    } finally {
      store.close();
      for (const s of ['', '-wal', '-shm']) { try { unlinkSync(dbPath + s); } catch { /* */ } }
    }
  });
});
