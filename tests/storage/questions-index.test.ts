// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * 0.22: questions a memory answers are stored with it and indexed for KEYWORD search only.
 *
 * Pins: (1) a memory is found by words that appear only in its questions; (2) setQuestions
 * re-indexes an existing memory; (3) a pre-0.22 store with the three-column FTS index is
 * migrated on open — index rebuilt, nothing lost; (4) a secret written into a question is
 * redacted like one written into content.
 *
 * Run: npx vitest run tests/storage/questions-index.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { withRedaction } from '../../src/storage/redacting-store.js';
import type { IEngramStore } from '../../src/storage/store.js';

const AGENT = 'q-index';
const ids = (rs: Array<{ engram: { id: string } }>) => rs.map((r) => r.engram.id);

describe('questions in the keyword index', () => {
  let tmp: string; let dbPath: string; let store: EngramStore;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-qidx-'));
    dbPath = join(tmp, 'memory.db');
    store = new EngramStore(dbPath);
  });
  afterEach(() => { try { store.close(); } catch { /* closed */ } rmSync(tmp, { recursive: true, force: true }); });

  it('finds a memory by words that appear only in its questions', () => {
    const e = store.createEngram({
      agentId: AGENT, concept: 'RosterKeep deploy', content: 'railway up --service rowos-app --ci after migrations.',
      questions: ['How do I ship the rowing club app to production?'],
    });
    store.createEngram({ agentId: AGENT, concept: 'Unrelated', content: 'The workshop venue is in Ashburn.' });
    expect(store.getEngram(e.id)?.questions).toEqual(['How do I ship the rowing club app to production?']);
    expect(ids(store.searchBM25WithRank(AGENT, 'ship rowing club production', 5))).toEqual([e.id]);
  });

  it('setQuestions re-indexes an existing memory, and clearing them removes it from that search', () => {
    const e = store.createEngram({ agentId: AGENT, concept: 'Gate floor', content: 'answerAt -0.93, withholdBelow -1.64.' });
    expect(store.searchBM25WithRank(AGENT, 'abstention threshold numbers', 5)).toHaveLength(0);
    store.setQuestions(e.id, ['What are the abstention threshold numbers?']);
    expect(ids(store.searchBM25WithRank(AGENT, 'abstention threshold numbers', 5))).toEqual([e.id]);
    store.setQuestions(e.id, []);
    expect(store.getEngram(e.id)?.questions).toBeNull();
    expect(store.searchBM25WithRank(AGENT, 'abstention threshold numbers', 5)).toHaveLength(0);
  });

  it('migrates a pre-0.22 store: three-column index rebuilt with questions, existing memories still found', () => {
    const e = store.createEngram({ agentId: AGENT, concept: 'Settlement lock', content: 'closeRun checks BLOCKED server-side.' });
    store.close();
    // Recreate the 0.21 shape: no questions column in the index, old triggers.
    const db = new Database(dbPath);
    db.exec(`
      DROP TRIGGER engrams_ai; DROP TRIGGER engrams_ad; DROP TRIGGER engrams_au; DROP TABLE engrams_fts;
      CREATE VIRTUAL TABLE engrams_fts USING fts5(concept, content, tags, content=engrams, content_rowid=rowid);
      INSERT INTO engrams_fts(engrams_fts) VALUES('rebuild');
      CREATE TRIGGER engrams_ai AFTER INSERT ON engrams BEGIN
        INSERT INTO engrams_fts(rowid, concept, content, tags) VALUES (new.rowid, new.concept, new.content, new.tags);
      END;`);
    expect((db.prepare(`SELECT name FROM pragma_table_info('engrams_fts')`).all() as any[]).map((r) => r.name)).not.toContain('questions');
    db.close();

    store = new EngramStore(dbPath);
    const cols = (store.getDb().prepare(`SELECT name FROM pragma_table_info('engrams_fts')`).all() as any[]).map((r) => r.name);
    expect(cols).toEqual(['concept', 'content', 'tags', 'questions']);
    expect(ids(store.searchBM25WithRank(AGENT, 'closeRun BLOCKED', 5))).toEqual([e.id]);
    store.setQuestions(e.id, ['Where is the period close enforced?']);
    expect(ids(store.searchBM25WithRank(AGENT, 'period close enforced', 5))).toEqual([e.id]);
    // and a second open is a no-op
    store.close();
    store = new EngramStore(dbPath);
    expect(ids(store.searchBM25WithRank(AGENT, 'period close enforced', 5))).toEqual([e.id]);
  });

  it('redacts a secret written into a question, on disk and in the index', () => {
    const secret = ['sk', '_live_', '51Hx9Tq2LmN8vB4kP7rS0dWz'].join('');
    const redacting = withRedaction(store as unknown as IEngramStore);
    const e = redacting.createEngram({ agentId: AGENT, concept: 'Stripe', content: 'Live key rotated.', questions: [`Is ${secret} still valid?`] }) as any;
    redacting.setQuestions(e.id, [`What replaced ${secret}?`]);
    store.walCheckpoint?.();
    const disk = ['', '-wal'].map((s) => (existsSync(dbPath + s) ? readFileSync(dbPath + s).toString('latin1') : '')).join('');
    expect(disk).not.toContain(secret);
    expect(store.getEngram(e.id)?.questions?.[0]).not.toContain(secret);
  });
});
