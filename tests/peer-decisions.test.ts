/**
 * Peer-decision injection tests — queryPeerDecisions, extractKeywords, formatPeerDecisions.
 *
 * Run: npx vitest run tests/peer-decisions.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';

import { initCoordinationTables } from '../src/coordination/schema.js';
import {
  extractKeywords,
  queryPeerDecisions,
  formatPeerDecisions,
  type PeerDecision,
} from '../src/coordination/peer-decisions.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DB_PATH = join(tmpdir(), `awm-peer-decisions-test-${Date.now()}.db`);
let db: Database.Database;

function insertAgent(id: string, name: string, workspace = 'TEST'): void {
  db.prepare(
    `INSERT OR REPLACE INTO coord_agents (id, name, role, status, workspace) VALUES (?, ?, 'worker', 'idle', ?)`
  ).run(id, name, workspace);
}

function insertDecision(authorId: string, summary: string, tags?: string, ageMinutes = 0): number {
  const ts = new Date(Date.now() - ageMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT INTO coord_decisions (author_id, tags, summary, created_at) VALUES (?, ?, ?, ?)`
  ).run(authorId, tags ?? null, summary, ts);
  return (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
}

beforeEach(() => {
  try { unlinkSync(DB_PATH); } catch { /* no-op */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initCoordinationTables(db);
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* no-op */ }
});

// ─── extractKeywords ─────────────────────────────────────────────────────────

describe('extractKeywords', () => {
  it('returns significant words from a query', () => {
    const kw = extractKeywords('React hooks memory leak cleanup');
    expect(kw).toContain('react');
    expect(kw).toContain('hooks');
    expect(kw).toContain('memory');
    expect(kw).toContain('leak');
    expect(kw).toContain('cleanup');
  });

  it('filters stop words', () => {
    const kw = extractKeywords('that this with from over after some more also');
    expect(kw).toHaveLength(0);
  });

  it('filters words shorter than 4 characters', () => {
    const kw = extractKeywords('the is a an by or up do go on');
    expect(kw).toHaveLength(0);
  });

  it('lowercases all keywords', () => {
    const kw = extractKeywords('DATABASE Migration Pattern');
    expect(kw).toContain('database');
    expect(kw).toContain('migration');
    expect(kw).toContain('pattern');
    expect(kw).not.toContain('DATABASE');
  });

  it('strips punctuation', () => {
    const kw = extractKeywords('auth-middleware: JWT tokens (bearer)');
    expect(kw).toContain('auth');
    expect(kw).toContain('middleware');
    expect(kw).toContain('tokens');
    expect(kw).toContain('bearer');
  });

  it('respects maxKeywords limit', () => {
    const kw = extractKeywords('alpha beta gamma delta epsilon zeta theta iota kappa lambda', 4);
    expect(kw.length).toBeLessThanOrEqual(4);
  });

  it('returns empty array for empty string', () => {
    expect(extractKeywords('')).toHaveLength(0);
  });
});

// ─── queryPeerDecisions ──────────────────────────────────────────────────────

describe('queryPeerDecisions', () => {
  it('returns empty array when no decisions exist', () => {
    insertAgent('self-1', 'Worker-C');
    const result = queryPeerDecisions(db, 'Worker-C', 'some query');
    expect(result).toEqual([]);
  });

  it('returns decisions by other agents', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertDecision('peer-1', 'Use JWT for auth');

    const result = queryPeerDecisions(db, 'Worker-C', 'JWT auth tokens');
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Use JWT for auth');
    expect(result[0].author_name).toBe('Worker-A');
  });

  it('excludes decisions by the current agent', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertDecision('self-1', 'My own decision about JWT');
    insertDecision('peer-1', 'Peer decision about JWT tokens');

    const result = queryPeerDecisions(db, 'Worker-C', 'JWT tokens');
    expect(result).toHaveLength(1);
    expect(result[0].author_name).toBe('Worker-A');
  });

  it('respects the time window — excludes old decisions', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');

    // Recent decision (10 min ago) — should be included
    insertDecision('peer-1', 'Recent auth decision', undefined, 10);
    // Old decision (90 min ago) — should be excluded from 1h window
    insertDecision('peer-1', 'Old auth decision', undefined, 90);

    const result = queryPeerDecisions(db, 'Worker-C', 'auth', 1);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Recent auth decision');
  });

  it('matches keywords against decision summary', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertDecision('peer-1', 'SQLite WAL mode improves concurrency');
    insertDecision('peer-1', 'Pizza dough recipe needs yeast');

    const result = queryPeerDecisions(db, 'Worker-C', 'SQLite database');
    expect(result).toHaveLength(1);
    expect(result[0].summary).toContain('SQLite');
  });

  it('matches keywords against decision tags', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertDecision('peer-1', 'Switched to bearer tokens', 'auth,security,tokens');
    insertDecision('peer-1', 'Updated pizza recipe', 'cooking,food');

    const result = queryPeerDecisions(db, 'Worker-C', 'auth security');
    expect(result).toHaveLength(1);
    expect(result[0].summary).toContain('bearer tokens');
  });

  it('falls back to all recent decisions when no keywords match', () => {
    // Query with only short/stop words → no keywords extracted → returns all recent
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertDecision('peer-1', 'Some random decision');
    insertDecision('peer-1', 'Another random decision');

    const result = queryPeerDecisions(db, 'Worker-C', 'a is on');
    // All recent decisions returned (no keyword filter)
    expect(result.length).toBe(2);
  });

  it('respects limit parameter', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    for (let i = 0; i < 10; i++) {
      insertDecision('peer-1', `Decision about database migration step ${i}`);
    }

    const result = queryPeerDecisions(db, 'Worker-C', 'database migration', 1, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('returns results ordered newest first', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertDecision('peer-1', 'Older auth decision', undefined, 50);
    insertDecision('peer-1', 'Newer auth decision', undefined, 5);

    const result = queryPeerDecisions(db, 'Worker-C', 'auth tokens', 1);
    expect(result[0].summary).toBe('Newer auth decision');
  });

  it('includes author_name in results', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertDecision('peer-1', 'Auth decision');

    const result = queryPeerDecisions(db, 'Worker-C', 'auth');
    expect(result[0].author_name).toBe('Worker-A');
  });

  it('includes assignment_id and tags in results', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    db.prepare(
      `INSERT INTO coord_decisions (author_id, assignment_id, tags, summary) VALUES (?, ?, ?, ?)`
    ).run('peer-1', 'task-42', 'auth,security', 'Use bearer tokens for auth');

    const result = queryPeerDecisions(db, 'Worker-C', 'bearer tokens auth');
    expect(result).toHaveLength(1);
    expect(result[0].tags).toBe('auth,security');
    expect(result[0].assignment_id).toBe('task-42');
  });

  it('aggregates from multiple peer agents', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertAgent('peer-2', 'Worker-B');
    insertDecision('peer-1', 'Worker-A auth decision');
    insertDecision('peer-2', 'Worker-B auth decision');

    const result = queryPeerDecisions(db, 'Worker-C', 'auth decision');
    expect(result).toHaveLength(2);
    const names = result.map(r => r.author_name).sort();
    expect(names).toEqual(['Worker-A', 'Worker-B']);
  });

  it('returns empty array gracefully when coord tables are missing', () => {
    // Use a fresh DB without coordination tables
    const plainDb = new Database(':memory:');
    const result = queryPeerDecisions(plainDb, 'Worker-C', 'some query');
    expect(result).toEqual([]);
    plainDb.close();
  });

  it('clamps windowHours to safe range', () => {
    insertAgent('self-1', 'Worker-C');
    insertAgent('peer-1', 'Worker-A');
    insertDecision('peer-1', 'Recent decision about database');

    // Very small window (still valid, should clamp to 0.1h = 6min)
    const result = queryPeerDecisions(db, 'Worker-C', 'database', -999);
    // Decision is <1 min old, should be in 0.1h window
    expect(result).toHaveLength(1);
  });
});

// ─── formatPeerDecisions ────────────────────────────────────────────────────

describe('formatPeerDecisions', () => {
  it('returns empty string when decisions array is empty', () => {
    expect(formatPeerDecisions([])).toBe('');
  });

  it('returns formatted section with default 1h label', () => {
    const decisions: PeerDecision[] = [
      { id: 1, author_name: 'Worker-A', assignment_id: null, tags: null, summary: 'Use JWT for auth', created_at: '2026-03-26 10:00:00' },
    ];
    const output = formatPeerDecisions(decisions);
    expect(output).toContain('--- Peer Decisions (last 1h) ---');
    expect(output).toContain('[Worker-A] Use JWT for auth');
  });

  it('shows correct time label for custom window', () => {
    const decisions: PeerDecision[] = [
      { id: 1, author_name: 'Worker-B', assignment_id: null, tags: null, summary: 'Switched to WAL mode', created_at: '2026-03-26 10:00:00' },
    ];
    const output = formatPeerDecisions(decisions, 2);
    expect(output).toContain('--- Peer Decisions (last 2h) ---');
  });

  it('formats multiple decisions as separate lines', () => {
    const decisions: PeerDecision[] = [
      { id: 1, author_name: 'Worker-A', assignment_id: null, tags: null, summary: 'Use JWT', created_at: '2026-03-26 10:00:00' },
      { id: 2, author_name: 'Worker-B', assignment_id: null, tags: null, summary: 'Use Redis cache', created_at: '2026-03-26 10:01:00' },
    ];
    const output = formatPeerDecisions(decisions);
    expect(output).toContain('[Worker-A] Use JWT');
    expect(output).toContain('[Worker-B] Use Redis cache');
    // Each decision on its own line
    const lines = output.trim().split('\n');
    expect(lines.length).toBe(3); // header + 2 decisions
  });

  it('starts with a newline to separate from memory results', () => {
    const decisions: PeerDecision[] = [
      { id: 1, author_name: 'Worker-A', assignment_id: null, tags: null, summary: 'Decision', created_at: '' },
    ];
    expect(formatPeerDecisions(decisions)).toMatch(/^\n/);
  });
});
