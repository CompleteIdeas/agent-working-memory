// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite storage layer — persistence for engrams, associations, and eval events.
 *
 * Uses better-sqlite3 for synchronous, fast, embedded storage.
 * FTS5 provides BM25 full-text search for the activation pipeline.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  Engram, EngramCreate, EngramStage, Association, AssociationType,
  SearchQuery, SalienceFeatures, ActivationEvent, StagingEvent,
  RetrievalFeedbackEvent, Episode, TaskStatus, TaskPriority, MemoryClass,
  ConsciousState, AutoCheckpoint, CheckpointRow,
} from '../types/index.js';

/** Safely convert a Node Buffer to Float32Array, respecting byteOffset/byteLength. */
function bufferToFloat32Array(buf: Buffer | ArrayBuffer): Float32Array {
  if (buf instanceof ArrayBuffer) return new Float32Array(buf);
  // Node Buffer may share an underlying ArrayBuffer — slice to the exact region
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

const DEFAULT_SALIENCE_FEATURES: SalienceFeatures = {
  surprise: 0, decisionMade: false, causalDepth: 0, resolutionEffort: 0, eventType: 'observation',
};

export class EngramStore {
  private db: Database.Database;

  constructor(dbPath: string = 'memory.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  /** Expose the raw database handle for the coordination module. */
  getDb(): Database.Database {
    return this.db;
  }

  /** Run PRAGMA quick_check and return true if DB is healthy. */
  integrityCheck(): { ok: boolean; result: string } {
    try {
      const rows = this.db.pragma('quick_check') as Array<{ quick_check: string }>;
      const result = rows[0]?.quick_check ?? 'unknown';
      return { ok: result === 'ok', result };
    } catch (err) {
      return { ok: false, result: (err as Error).message };
    }
  }

  /** Hot backup using SQLite backup API. Returns the backup path. */
  backup(destPath: string): void {
    this.db.backup(destPath);
  }

  /** Flush WAL to main database file. */
  walCheckpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engrams (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        concept TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        confidence REAL NOT NULL DEFAULT 0.5,
        salience REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT NOT NULL,
        created_at TEXT NOT NULL,
        salience_features TEXT NOT NULL DEFAULT '{}',
        reason_codes TEXT NOT NULL DEFAULT '[]',
        stage TEXT NOT NULL DEFAULT 'active',
        ttl INTEGER,
        retracted INTEGER NOT NULL DEFAULT 0,
        retracted_by TEXT,
        retracted_at TEXT,
        tags TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_engrams_agent ON engrams(agent_id);
      CREATE INDEX IF NOT EXISTS idx_engrams_stage ON engrams(agent_id, stage);
      CREATE INDEX IF NOT EXISTS idx_engrams_concept ON engrams(concept);
      CREATE INDEX IF NOT EXISTS idx_engrams_retracted ON engrams(agent_id, retracted);

      CREATE TABLE IF NOT EXISTS associations (
        id TEXT PRIMARY KEY,
        from_engram_id TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
        to_engram_id TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
        weight REAL NOT NULL DEFAULT 0.1,
        confidence REAL NOT NULL DEFAULT 0.5,
        type TEXT NOT NULL DEFAULT 'hebbian',
        activation_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_activated TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_assoc_from ON associations(from_engram_id);
      CREATE INDEX IF NOT EXISTS idx_assoc_to ON associations(to_engram_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_assoc_pair ON associations(from_engram_id, to_engram_id);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}'
      );

      -- FTS5 for full-text search (BM25 ranking built in)
      CREATE VIRTUAL TABLE IF NOT EXISTS engrams_fts USING fts5(
        concept, content, tags,
        content=engrams,
        content_rowid=rowid
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS engrams_ai AFTER INSERT ON engrams BEGIN
        INSERT INTO engrams_fts(rowid, concept, content, tags) VALUES (new.rowid, new.concept, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS engrams_ad AFTER DELETE ON engrams BEGIN
        INSERT INTO engrams_fts(engrams_fts, rowid, concept, content, tags) VALUES('delete', old.rowid, old.concept, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS engrams_au AFTER UPDATE ON engrams BEGIN
        INSERT INTO engrams_fts(engrams_fts, rowid, concept, content, tags) VALUES('delete', old.rowid, old.concept, old.content, old.tags);
        INSERT INTO engrams_fts(rowid, concept, content, tags) VALUES (new.rowid, new.concept, new.content, new.tags);
      END;

      -- Eval event logs
      CREATE TABLE IF NOT EXISTS activation_events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        context TEXT NOT NULL,
        results_returned INTEGER NOT NULL,
        top_score REAL,
        latency_ms REAL NOT NULL,
        engram_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS staging_events (
        engram_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resonance_score REAL,
        timestamp TEXT NOT NULL,
        age_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retrieval_feedback (
        id TEXT PRIMARY KEY,
        activation_event_id TEXT,
        engram_id TEXT NOT NULL,
        useful INTEGER NOT NULL,
        context TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        label TEXT NOT NULL,
        embedding BLOB,
        engram_count INTEGER NOT NULL DEFAULT 0,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(agent_id, end_time);
    `);

    // Migration: add episode_id column if missing
    try {
      this.db.prepare('SELECT episode_id FROM engrams LIMIT 0').get();
    } catch {
      this.db.exec('ALTER TABLE engrams ADD COLUMN episode_id TEXT');
    }

    // Migration: add task management columns if missing
    try {
      this.db.prepare('SELECT task_status FROM engrams LIMIT 0').get();
    } catch {
      this.db.exec(`
        ALTER TABLE engrams ADD COLUMN task_status TEXT;
        ALTER TABLE engrams ADD COLUMN task_priority TEXT;
        ALTER TABLE engrams ADD COLUMN blocked_by TEXT;
      `);
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_engrams_task ON engrams(agent_id, task_status)');
    }

    // Migration: add memory_class and supersession columns if missing
    try {
      this.db.prepare('SELECT memory_class FROM engrams LIMIT 0').get();
    } catch {
      this.db.exec(`
        ALTER TABLE engrams ADD COLUMN memory_class TEXT NOT NULL DEFAULT 'working';
        ALTER TABLE engrams ADD COLUMN superseded_by TEXT;
        ALTER TABLE engrams ADD COLUMN supersedes TEXT;
      `);
    }

    // Migration: add conscious_state table for checkpointing
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conscious_state (
        agent_id TEXT PRIMARY KEY,
        last_write_id TEXT,
        last_recall_context TEXT,
        last_recall_ids TEXT NOT NULL DEFAULT '[]',
        last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
        write_count_since_consolidation INTEGER NOT NULL DEFAULT 0,
        recall_count_since_consolidation INTEGER NOT NULL DEFAULT 0,
        execution_state TEXT,
        checkpoint_at TEXT,
        last_consolidation_at TEXT,
        last_mini_consolidation_at TEXT,
        consolidation_cycle_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Migration: add consolidation_cycle_count if missing (existing DBs)
    try {
      this.db.exec(`ALTER TABLE conscious_state ADD COLUMN consolidation_cycle_count INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
  }

  // --- Engram CRUD ---

  createEngram(input: EngramCreate): Engram {
    const now = new Date().toISOString();
    const id = randomUUID();
    const embeddingBlob = input.embedding
      ? Buffer.from(new Float32Array(input.embedding).buffer)
      : null;

    this.db.prepare(`
      INSERT INTO engrams (id, agent_id, concept, content, embedding, confidence, salience,
        access_count, last_accessed, created_at, salience_features, reason_codes, stage, tags, episode_id,
        ttl, memory_class, supersedes, task_status, task_priority, blocked_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.agentId, input.concept, input.content, embeddingBlob,
      input.confidence ?? 0.5,
      input.salience ?? 0.5,
      now, now,
      JSON.stringify(input.salienceFeatures ?? DEFAULT_SALIENCE_FEATURES),
      JSON.stringify(input.reasonCodes ?? []),
      JSON.stringify(input.tags ?? []),
      input.episodeId ?? null,
      input.ttl ?? null,
      input.memoryClass ?? 'working',
      input.supersedes ?? null,
      input.taskStatus ?? null,
      input.taskPriority ?? null,
      input.blockedBy ?? null,
    );

    return this.getEngram(id)!;
  }

  getEngram(id: string): Engram | null {
    const row = this.db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as any;
    return row ? this.rowToEngram(row) : null;
  }

  getEngramsByAgent(agentId: string, stage?: EngramStage, includeRetracted: boolean = false): Engram[] {
    let query = 'SELECT * FROM engrams WHERE agent_id = ?';
    const params: any[] = [agentId];

    if (stage) {
      query += ' AND stage = ?';
      params.push(stage);
    }
    if (!includeRetracted) {
      query += ' AND retracted = 0';
    }

    return (this.db.prepare(query).all(...params) as any[]).map(r => this.rowToEngram(r));
  }

  touchEngram(id: string): void {
    this.db.prepare(`
      UPDATE engrams SET access_count = access_count + 1, last_accessed = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  updateStage(id: string, stage: EngramStage): void {
    this.db.prepare('UPDATE engrams SET stage = ? WHERE id = ?').run(stage, id);
  }

  updateConfidence(id: string, confidence: number): void {
    this.db.prepare('UPDATE engrams SET confidence = ? WHERE id = ?').run(
      Math.max(0, Math.min(1, confidence)), id
    );
  }

  updateEmbedding(id: string, embedding: number[]): void {
    const blob = Buffer.from(new Float32Array(embedding).buffer);
    this.db.prepare('UPDATE engrams SET embedding = ? WHERE id = ?').run(blob, id);
  }

  retractEngram(id: string, retractedBy: string | null): void {
    this.db.prepare(`
      UPDATE engrams SET retracted = 1, retracted_by = ?, retracted_at = ? WHERE id = ?
    `).run(retractedBy, new Date().toISOString(), id);
  }

  deleteEngram(id: string): void {
    this.db.prepare('DELETE FROM engrams WHERE id = ?').run(id);
  }

  /**
   * Time warp — shift all timestamps backward by ms milliseconds.
   * Used for testing time-dependent behavior (decay, forgetting).
   * Returns count of records shifted.
   */
  timeWarp(agentId: string, ms: number): number {
    let count = 0;
    const shiftSec = Math.round(ms / 1000);
    // Shift engram timestamps
    const r1 = this.db.prepare(`
      UPDATE engrams SET
        created_at = datetime(created_at, '-${shiftSec} seconds'),
        last_accessed = datetime(last_accessed, '-${shiftSec} seconds')
      WHERE agent_id = ?
    `).run(agentId);
    count += r1.changes;
    // Shift association timestamps
    const r2 = this.db.prepare(`
      UPDATE associations SET
        created_at = datetime(created_at, '-${shiftSec} seconds'),
        last_activated = datetime(last_activated, '-${shiftSec} seconds')
      WHERE from_engram_id IN (SELECT id FROM engrams WHERE agent_id = ?)
         OR to_engram_id IN (SELECT id FROM engrams WHERE agent_id = ?)
    `).run(agentId, agentId);
    count += r2.changes;
    return count;
  }

  // --- Full-text search (BM25) ---

  searchBM25(agentId: string, query: string, limit: number = 10): Engram[] {
    return this.searchBM25WithRank(agentId, query, limit).map(r => r.engram);
  }

  /**
   * BM25 search returning rank scores alongside engrams.
   * FTS5 rank is negative (lower = better match).
   * We normalize to 0-1 where higher = better.
   */
  searchBM25WithRank(agentId: string, query: string, limit: number = 10): { engram: Engram; bm25Score: number }[] {
    // Sanitize query for FTS5: quote each word to prevent column name interpretation
    const sanitized = query
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => `"${w}"`)
      .join(' OR ');

    if (!sanitized) return [];

    try {
      const rows = this.db.prepare(`
        SELECT e.*, rank FROM engrams e
        JOIN engrams_fts ON e.rowid = engrams_fts.rowid
        WHERE engrams_fts MATCH ? AND e.agent_id = ? AND e.retracted = 0
        ORDER BY rank
        LIMIT ?
      `).all(sanitized, agentId, limit) as any[];

      return rows.map(r => ({
        engram: this.rowToEngram(r),
        // Normalize: rank is negative, more negative = better match.
        // |rank| / (1 + |rank|) gives 0-1 where higher = better.
        bm25Score: Math.abs(r.rank ?? 0) / (1 + Math.abs(r.rank ?? 0)),
      }));
    } catch {
      return [];
    }
  }

  // --- Diagnostic search (deterministic, not cognitive) ---

  search(query: SearchQuery): Engram[] {
    let sql = 'SELECT * FROM engrams WHERE agent_id = ?';
    const params: any[] = [query.agentId];

    if (query.text) {
      sql += ' AND (content LIKE ? OR concept LIKE ?)';
      params.push(`%${query.text}%`, `%${query.text}%`);
    }
    if (query.concept) {
      sql += ' AND concept = ?';
      params.push(query.concept);
    }
    if (query.stage) {
      sql += ' AND stage = ?';
      params.push(query.stage);
    }
    if (query.retracted !== undefined) {
      sql += ' AND retracted = ?';
      params.push(query.retracted ? 1 : 0);
    }
    if (query.tags && query.tags.length > 0) {
      for (const tag of query.tags) {
        sql += ' AND tags LIKE ?';
        params.push(`%"${tag}"%`);
      }
    }

    sql += ' ORDER BY last_accessed DESC';
    sql += ` LIMIT ? OFFSET ?`;
    params.push(query.limit ?? 50, query.offset ?? 0);

    return (this.db.prepare(sql).all(...params) as any[]).map(r => this.rowToEngram(r));
  }

  /**
   * Get the most recently created engram for an agent (for temporal adjacency edges).
   */
  getLatestEngram(agentId: string, excludeId?: string): Engram | null {
    let sql = 'SELECT * FROM engrams WHERE agent_id = ? AND retracted = 0';
    const params: any[] = [agentId];
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    sql += ' ORDER BY created_at DESC LIMIT 1';
    const row = this.db.prepare(sql).get(...params) as any;
    return row ? this.rowToEngram(row) : null;
  }

  // --- Task management ---

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.db.prepare('UPDATE engrams SET task_status = ? WHERE id = ?').run(status, id);
  }

  updateTaskPriority(id: string, priority: TaskPriority): void {
    this.db.prepare('UPDATE engrams SET task_priority = ? WHERE id = ?').run(priority, id);
  }

  updateBlockedBy(id: string, blockedBy: string | null): void {
    this.db.prepare('UPDATE engrams SET blocked_by = ?, task_status = ? WHERE id = ?')
      .run(blockedBy, blockedBy ? 'blocked' : 'open', id);
  }

  /**
   * Get tasks for an agent, optionally filtered by status.
   * Results ordered by priority (urgent > high > medium > low), then creation date.
   */
  getTasks(agentId: string, status?: TaskStatus): Engram[] {
    let sql = 'SELECT * FROM engrams WHERE agent_id = ? AND task_status IS NOT NULL AND retracted = 0';
    const params: any[] = [agentId];
    if (status) {
      sql += ' AND task_status = ?';
      params.push(status);
    }
    sql += ` ORDER BY
      CASE task_priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END,
      created_at DESC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(r => this.rowToEngram(r));
  }

  /**
   * Get the next actionable task — highest priority that's not blocked or done.
   */
  getNextTask(agentId: string): Engram | null {
    const row = this.db.prepare(`
      SELECT * FROM engrams
      WHERE agent_id = ? AND task_status IN ('open', 'in_progress') AND retracted = 0
      ORDER BY
        CASE task_status WHEN 'in_progress' THEN 0 ELSE 1 END,
        CASE task_priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        created_at ASC
      LIMIT 1
    `).get(agentId) as any;
    return row ? this.rowToEngram(row) : null;
  }

  // --- Supersession ---

  /**
   * Mark an engram as superseded by another.
   * The old memory stays in the DB (historical) but gets down-ranked in recall.
   */
  supersedeEngram(oldId: string, newId: string): void {
    this.db.prepare('UPDATE engrams SET superseded_by = ? WHERE id = ?').run(newId, oldId);
    this.db.prepare('UPDATE engrams SET supersedes = ? WHERE id = ?').run(oldId, newId);
  }

  /**
   * Check if an engram has been superseded.
   */
  isSuperseded(id: string): boolean {
    const row = this.db.prepare('SELECT superseded_by FROM engrams WHERE id = ?').get(id) as any;
    return row?.superseded_by != null;
  }

  updateMemoryClass(id: string, memoryClass: MemoryClass): void {
    this.db.prepare('UPDATE engrams SET memory_class = ? WHERE id = ?').run(memoryClass, id);
  }

  // --- Associations ---

  upsertAssociation(
    fromId: string, toId: string, weight: number,
    type: AssociationType = 'hebbian', confidence: number = 0.5
  ): Association {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO associations (id, from_engram_id, to_engram_id, weight, confidence, type, activation_count, created_at, last_activated)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(from_engram_id, to_engram_id) DO UPDATE SET
        weight = ?, confidence = ?, last_activated = ?, activation_count = activation_count + 1
    `).run(id, fromId, toId, weight, confidence, type, now, now, weight, confidence, now);

    return this.getAssociation(fromId, toId)!;
  }

  getAssociation(fromId: string, toId: string): Association | null {
    const row = this.db.prepare(
      'SELECT * FROM associations WHERE from_engram_id = ? AND to_engram_id = ?'
    ).get(fromId, toId) as any;
    return row ? this.rowToAssociation(row) : null;
  }

  getAssociationsFor(engramId: string): Association[] {
    const rows = this.db.prepare(
      'SELECT * FROM associations WHERE from_engram_id = ? OR to_engram_id = ?'
    ).all(engramId, engramId);
    return (rows as any[]).map(r => this.rowToAssociation(r));
  }

  getOutgoingAssociations(engramId: string): Association[] {
    const rows = this.db.prepare(
      'SELECT * FROM associations WHERE from_engram_id = ?'
    ).all(engramId);
    return (rows as any[]).map(r => this.rowToAssociation(r));
  }

  countAssociationsFor(engramId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM associations WHERE from_engram_id = ?'
    ).get(engramId) as any;
    return row.count;
  }

  getWeakestAssociation(engramId: string): Association | null {
    const row = this.db.prepare(
      'SELECT * FROM associations WHERE from_engram_id = ? ORDER BY weight ASC LIMIT 1'
    ).get(engramId) as any;
    return row ? this.rowToAssociation(row) : null;
  }

  deleteAssociation(id: string): void {
    this.db.prepare('DELETE FROM associations WHERE id = ?').run(id);
  }

  getAllAssociations(agentId: string): Association[] {
    const rows = this.db.prepare(`
      SELECT a.* FROM associations a
      JOIN engrams e ON a.from_engram_id = e.id
      WHERE e.agent_id = ?
    `).all(agentId);
    return (rows as any[]).map(r => this.rowToAssociation(r));
  }

  // --- Eviction ---

  getEvictionCandidates(agentId: string, limit: number): Engram[] {
    // Lowest combined score: low salience + low access + low confidence + oldest
    const rows = this.db.prepare(`
      SELECT * FROM engrams
      WHERE agent_id = ? AND stage = 'active' AND retracted = 0
      ORDER BY (salience * 0.3 + confidence * 0.3 + (CAST(access_count AS REAL) / (access_count + 5)) * 0.2 +
        (1.0 / (1.0 + (julianday('now') - julianday(last_accessed)))) * 0.2) ASC
      LIMIT ?
    `).all(agentId, limit) as any[];
    return rows.map(r => this.rowToEngram(r));
  }

  getActiveCount(agentId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM engrams WHERE agent_id = ? AND stage = 'active'"
    ).get(agentId) as any;
    return row.count;
  }

  getStagingCount(agentId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM engrams WHERE agent_id = ? AND stage = 'staging'"
    ).get(agentId) as any;
    return row.count;
  }

  // --- Staging buffer ---

  getExpiredStaging(): Engram[] {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT * FROM engrams WHERE stage = 'staging' AND ttl IS NOT NULL
    `).all() as any[];

    return rows
      .map(r => this.rowToEngram(r))
      .filter(e => e.ttl && (e.createdAt.getTime() + e.ttl) < now);
  }

  // --- Eval event logging ---

  logActivationEvent(event: ActivationEvent): void {
    this.db.prepare(`
      INSERT INTO activation_events (id, agent_id, timestamp, context, results_returned, top_score, latency_ms, engram_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.agentId, event.timestamp.toISOString(),
      event.context, event.resultsReturned, event.topScore,
      event.latencyMs, JSON.stringify(event.engramIds)
    );
  }

  logStagingEvent(event: StagingEvent): void {
    this.db.prepare(`
      INSERT INTO staging_events (engram_id, agent_id, action, resonance_score, timestamp, age_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.engramId, event.agentId, event.action,
      event.resonanceScore, event.timestamp.toISOString(), event.ageMs
    );
  }

  logRetrievalFeedback(activationEventId: string | null, engramId: string, useful: boolean, context: string): void {
    this.db.prepare(`
      INSERT INTO retrieval_feedback (id, activation_event_id, engram_id, useful, context, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), activationEventId, engramId, useful ? 1 : 0, context, new Date().toISOString());
  }

  // --- Eval metrics queries ---

  getRetrievalPrecision(agentId: string, windowHours: number = 24): number {
    const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const row = this.db.prepare(`
      SELECT
        COUNT(CASE WHEN useful = 1 THEN 1 END) as useful_count,
        COUNT(*) as total_count
      FROM retrieval_feedback rf
      LEFT JOIN activation_events ae ON rf.activation_event_id = ae.id
      JOIN engrams e ON rf.engram_id = e.id
      WHERE e.agent_id = ? AND rf.timestamp > ?
    `).get(agentId, since) as any;

    return row.total_count > 0 ? row.useful_count / row.total_count : 0;
  }

  getStagingMetrics(agentId: string): { promoted: number; discarded: number; expired: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(CASE WHEN action = 'promoted' THEN 1 END) as promoted,
        COUNT(CASE WHEN action = 'discarded' THEN 1 END) as discarded,
        COUNT(CASE WHEN action = 'expired' THEN 1 END) as expired
      FROM staging_events WHERE agent_id = ?
    `).get(agentId) as any;
    return { promoted: row.promoted, discarded: row.discarded, expired: row.expired };
  }

  getActivationStats(agentId: string, windowHours: number = 24): {
    count: number; avgLatencyMs: number; p95LatencyMs: number;
  } {
    const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const rows = this.db.prepare(`
      SELECT latency_ms FROM activation_events
      WHERE agent_id = ? AND timestamp > ?
      ORDER BY latency_ms ASC
    `).all(agentId, since) as { latency_ms: number }[];

    if (rows.length === 0) return { count: 0, avgLatencyMs: 0, p95LatencyMs: 0 };

    const total = rows.reduce((s, r) => s + r.latency_ms, 0);
    const p95Index = Math.min(Math.floor(rows.length * 0.95), rows.length - 1);
    return {
      count: rows.length,
      avgLatencyMs: total / rows.length,
      p95LatencyMs: rows[p95Index].latency_ms,
    };
  }

  getConsolidatedCount(agentId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM engrams WHERE agent_id = ? AND stage = 'consolidated'`
    ).get(agentId) as any;
    return row.cnt;
  }

  // --- Helpers ---

  private rowToEngram(row: any): Engram {
    return {
      id: row.id,
      agentId: row.agent_id,
      concept: row.concept,
      content: row.content,
      embedding: row.embedding
        ? Array.from(bufferToFloat32Array(row.embedding))
        : null,
      confidence: row.confidence,
      salience: row.salience,
      accessCount: row.access_count,
      lastAccessed: new Date(row.last_accessed),
      createdAt: new Date(row.created_at),
      salienceFeatures: JSON.parse(row.salience_features || '{}'),
      reasonCodes: JSON.parse(row.reason_codes || '[]'),
      stage: row.stage as EngramStage,
      ttl: row.ttl,
      retracted: !!row.retracted,
      retractedBy: row.retracted_by,
      retractedAt: row.retracted_at ? new Date(row.retracted_at) : null,
      tags: JSON.parse(row.tags),
      episodeId: row.episode_id ?? null,
      memoryClass: (row.memory_class ?? 'working') as MemoryClass,
      supersededBy: row.superseded_by ?? null,
      supersedes: row.supersedes ?? null,
      taskStatus: row.task_status ?? null,
      taskPriority: row.task_priority ?? null,
      blockedBy: row.blocked_by ?? null,
    };
  }

  private rowToAssociation(row: any): Association {
    return {
      id: row.id,
      fromEngramId: row.from_engram_id,
      toEngramId: row.to_engram_id,
      weight: row.weight,
      confidence: row.confidence ?? 0.5,
      type: row.type as AssociationType,
      activationCount: row.activation_count ?? 0,
      createdAt: new Date(row.created_at),
      lastActivated: new Date(row.last_activated),
    };
  }

  // --- Episodes ---

  createEpisode(input: { agentId: string; label: string; embedding?: number[] }): Episode {
    const now = new Date().toISOString();
    const id = randomUUID();
    const embeddingBlob = input.embedding
      ? Buffer.from(new Float32Array(input.embedding).buffer)
      : null;

    this.db.prepare(`
      INSERT INTO episodes (id, agent_id, label, embedding, engram_count, start_time, end_time, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, input.agentId, input.label, embeddingBlob, now, now, now);

    return this.getEpisode(id)!;
  }

  getEpisode(id: string): Episode | null {
    const row = this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as any;
    return row ? this.rowToEpisode(row) : null;
  }

  getEpisodesByAgent(agentId: string): Episode[] {
    const rows = this.db.prepare(
      'SELECT * FROM episodes WHERE agent_id = ? ORDER BY end_time DESC'
    ).all(agentId) as any[];
    return rows.map(r => this.rowToEpisode(r));
  }

  getActiveEpisode(agentId: string, windowMs: number = 3600_000): Episode | null {
    // Find most recent episode that ended within the time window
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = this.db.prepare(`
      SELECT * FROM episodes WHERE agent_id = ? AND end_time > ?
      ORDER BY end_time DESC LIMIT 1
    `).get(agentId, cutoff) as any;
    return row ? this.rowToEpisode(row) : null;
  }

  addEngramToEpisode(engramId: string, episodeId: string): void {
    this.db.prepare('UPDATE engrams SET episode_id = ? WHERE id = ?').run(episodeId, engramId);
    this.db.prepare(`
      UPDATE episodes SET
        engram_count = engram_count + 1,
        end_time = MAX(end_time, ?)
      WHERE id = ?
    `).run(new Date().toISOString(), episodeId);
  }

  getEngramsByEpisode(episodeId: string): Engram[] {
    const rows = this.db.prepare(
      'SELECT * FROM engrams WHERE episode_id = ? AND retracted = 0 ORDER BY created_at ASC'
    ).all(episodeId) as any[];
    return rows.map(r => this.rowToEngram(r));
  }

  updateEpisodeEmbedding(id: string, embedding: number[]): void {
    const blob = Buffer.from(new Float32Array(embedding).buffer);
    this.db.prepare('UPDATE episodes SET embedding = ? WHERE id = ?').run(blob, id);
  }

  getEpisodeCount(agentId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM episodes WHERE agent_id = ?'
    ).get(agentId) as any;
    return row.cnt;
  }

  private rowToEpisode(row: any): Episode {
    return {
      id: row.id,
      agentId: row.agent_id,
      label: row.label,
      embedding: row.embedding
        ? Array.from(bufferToFloat32Array(row.embedding))
        : null,
      engramCount: row.engram_count,
      startTime: new Date(row.start_time),
      endTime: new Date(row.end_time),
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * Find engrams whose tags contain any of the given tag values.
   * Used for entity-bridge retrieval: given entity tags from top results,
   * find other engrams mentioning the same entities.
   */
  findEngramsByTags(agentId: string, tags: string[], excludeIds?: Set<string>): Engram[] {
    if (tags.length === 0) return [];

    // Build OR conditions for tag matching
    const conditions = tags.map(() => 'tags LIKE ?').join(' OR ');
    const params: any[] = [agentId, ...tags.map(t => `%"${t}"%`)];

    let sql = `SELECT * FROM engrams WHERE agent_id = ? AND retracted = 0 AND (${conditions})`;
    const rows = this.db.prepare(sql).all(...params) as any[];

    const results = rows.map(r => this.rowToEngram(r));
    if (excludeIds) {
      return results.filter(e => !excludeIds.has(e.id));
    }
    return results;
  }

  // --- Checkpointing ---

  updateAutoCheckpointWrite(agentId: string, engramId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conscious_state (agent_id, last_write_id, last_activity_at, write_count_since_consolidation, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_write_id = excluded.last_write_id,
        last_activity_at = excluded.last_activity_at,
        write_count_since_consolidation = write_count_since_consolidation + 1,
        updated_at = excluded.updated_at
    `).run(agentId, engramId, now, now);
  }

  updateAutoCheckpointRecall(agentId: string, context: string, engramIds: string[]): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conscious_state (agent_id, last_recall_context, last_recall_ids, last_activity_at, recall_count_since_consolidation, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_recall_context = excluded.last_recall_context,
        last_recall_ids = excluded.last_recall_ids,
        last_activity_at = excluded.last_activity_at,
        recall_count_since_consolidation = recall_count_since_consolidation + 1,
        updated_at = excluded.updated_at
    `).run(agentId, context, JSON.stringify(engramIds), now, now);
  }

  touchActivity(agentId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conscious_state (agent_id, last_activity_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_activity_at = excluded.last_activity_at,
        updated_at = excluded.updated_at
    `).run(agentId, now, now);
  }

  saveCheckpoint(agentId: string, state: ConsciousState): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conscious_state (agent_id, execution_state, checkpoint_at, last_activity_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        execution_state = excluded.execution_state,
        checkpoint_at = excluded.checkpoint_at,
        last_activity_at = excluded.last_activity_at,
        updated_at = excluded.updated_at
    `).run(agentId, JSON.stringify(state), now, now, now);
  }

  getCheckpoint(agentId: string): CheckpointRow | null {
    const row = this.db.prepare('SELECT * FROM conscious_state WHERE agent_id = ?').get(agentId) as any;
    if (!row) return null;

    return {
      agentId: row.agent_id,
      auto: {
        lastWriteId: row.last_write_id ?? null,
        lastRecallContext: row.last_recall_context ?? null,
        lastRecallIds: JSON.parse(row.last_recall_ids || '[]'),
        lastActivityAt: new Date(row.last_activity_at),
        writeCountSinceConsolidation: row.write_count_since_consolidation,
        recallCountSinceConsolidation: row.recall_count_since_consolidation,
      },
      executionState: row.execution_state ? JSON.parse(row.execution_state) : null,
      checkpointAt: row.checkpoint_at ? new Date(row.checkpoint_at) : null,
      lastConsolidationAt: row.last_consolidation_at ? new Date(row.last_consolidation_at) : null,
      lastMiniConsolidationAt: row.last_mini_consolidation_at ? new Date(row.last_mini_consolidation_at) : null,
      updatedAt: new Date(row.updated_at),
    };
  }

  markConsolidation(agentId: string, mini: boolean): void {
    const now = new Date().toISOString();
    if (mini) {
      this.db.prepare(`
        UPDATE conscious_state SET last_mini_consolidation_at = ?, updated_at = ? WHERE agent_id = ?
      `).run(now, now, agentId);
    } else {
      this.db.prepare(`
        UPDATE conscious_state SET
          last_consolidation_at = ?,
          last_mini_consolidation_at = ?,
          write_count_since_consolidation = 0,
          recall_count_since_consolidation = 0,
          consolidation_cycle_count = consolidation_cycle_count + 1,
          updated_at = ?
        WHERE agent_id = ?
      `).run(now, now, now, agentId);
    }
  }

  getActiveAgents(): Array<{ agentId: string; lastActivityAt: Date; writeCount: number; recallCount: number; lastConsolidationAt: Date | null }> {
    const rows = this.db.prepare('SELECT * FROM conscious_state').all() as any[];
    return rows.map(row => ({
      agentId: row.agent_id,
      lastActivityAt: new Date(row.last_activity_at),
      writeCount: row.write_count_since_consolidation,
      recallCount: row.recall_count_since_consolidation,
      lastConsolidationAt: row.last_consolidation_at ? new Date(row.last_consolidation_at) : null,
    }));
  }

  getConsolidationCycleCount(agentId: string): number {
    const row = this.db.prepare(
      'SELECT consolidation_cycle_count FROM conscious_state WHERE agent_id = ?',
    ).get(agentId) as { consolidation_cycle_count: number } | undefined;
    return row?.consolidation_cycle_count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
