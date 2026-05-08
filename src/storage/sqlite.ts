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
  RetrievalFeedbackEvent, Episode, TaskStatus, TaskPriority, MemoryClass, MemoryType,
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

/**
 * In-memory slim entry — the minimum data the activation pipeline's pre-filter
 * pass reads. Lives in EngramStore.slimCache to skip the SQL fetch + Buffer→
 * Float32Array conversion on every recall. ~22 bytes overhead per entry plus
 * the embedding (~1.5KB), so ~15MB at 10K engrams.
 */
type SlimCacheEntry = {
  id: string;
  agentId: string;
  concept: string;
  embedding: number[] | null;
  stage: EngramStage;
  retracted: boolean;
};

export class EngramStore {
  private db: Database.Database;
  private walTimer: ReturnType<typeof setInterval> | null = null;

  // Slim cache for the activation pipeline pre-filter. Populated lazily on
  // first call to getEngramsByAgentSlim(). Mutations to engrams keep this in
  // sync via private cache* helpers. Disable via AWM_DISABLE_SLIM_CACHE=1
  // (for A/B testing or if a regression appears).
  private slimCache: Map<string, SlimCacheEntry> = new Map();
  private slimCachePopulated: boolean = false;
  private slimCacheEnabled: boolean = process.env.AWM_DISABLE_SLIM_CACHE !== '1';

  constructor(dbPath: string = 'memory.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('wal_autocheckpoint = 1000');
    this.init();
    this.startWalCheckpointTimer();
  }

  // --- Slim cache management ---

  /** Lazy-populate the slim cache from the engrams table. Called on first slim fetch. */
  private ensureSlimCachePopulated(): void {
    if (this.slimCachePopulated || !this.slimCacheEnabled) return;
    const rows = this.db.prepare(
      'SELECT id, agent_id, concept, embedding, stage, retracted FROM engrams'
    ).all() as any[];
    for (const r of rows) {
      this.slimCache.set(r.id as string, {
        id: r.id as string,
        agentId: r.agent_id as string,
        concept: r.concept as string,
        embedding: r.embedding ? Array.from(bufferToFloat32Array(r.embedding)) : null,
        stage: r.stage as EngramStage,
        retracted: !!r.retracted,
      });
    }
    this.slimCachePopulated = true;
  }

  /** Add a new engram to the slim cache. Called from createEngram. */
  private cacheAdd(entry: SlimCacheEntry): void {
    if (!this.slimCacheEnabled) return;
    this.slimCache.set(entry.id, entry);
  }

  private cacheUpdateStage(id: string, stage: EngramStage): void {
    if (!this.slimCacheEnabled) return;
    const e = this.slimCache.get(id);
    if (e) e.stage = stage;
  }

  private cacheUpdateEmbedding(id: string, embedding: number[]): void {
    if (!this.slimCacheEnabled) return;
    const e = this.slimCache.get(id);
    if (e) e.embedding = embedding;
  }

  private cacheRetract(id: string): void {
    if (!this.slimCacheEnabled) return;
    const e = this.slimCache.get(id);
    if (e) e.retracted = true;
  }

  private cacheRemove(id: string): void {
    if (!this.slimCacheEnabled) return;
    this.slimCache.delete(id);
  }

  /** Reset cache (used by tests + after timeWarp/bulk operations). */
  resetSlimCache(): void {
    this.slimCache.clear();
    this.slimCachePopulated = false;
  }

  /**
   * Eager slim-cache populate — public entry point so process startup can warm
   * the cache before the first user recall. Otherwise the first recall pays
   * a ~600ms one-time SQL fetch + embedding deserialization.
   */
  warmSlimCache(): void {
    this.ensureSlimCachePopulated();
  }

  /** Inspect cache state — used for diagnostics + tests. */
  getSlimCacheStats(): { populated: boolean; size: number; enabled: boolean } {
    return {
      populated: this.slimCachePopulated,
      size: this.slimCache.size,
      enabled: this.slimCacheEnabled,
    };
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
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Checkpoint can fail if another connection holds the DB; non-fatal
    }
  }

  /** Start periodic WAL checkpoint every 5 minutes to prevent unbounded WAL growth. */
  private startWalCheckpointTimer(): void {
    this.walTimer = setInterval(() => {
      this.walCheckpoint();
    }, 5 * 60 * 1000);
    this.walTimer.unref();
  }

  /** Stop the WAL checkpoint timer (call before close). */
  stopWalCheckpointTimer(): void {
    if (this.walTimer) {
      clearInterval(this.walTimer);
      this.walTimer = null;
    }
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
        tags TEXT NOT NULL DEFAULT '[]',
        memory_type TEXT NOT NULL DEFAULT 'unclassified'
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

    // Migration: add embedding_model for version tracking (prevents drift on model change)
    try {
      this.db.prepare('SELECT embedding_model FROM engrams LIMIT 0').get();
    } catch {
      this.db.exec(`ALTER TABLE engrams ADD COLUMN embedding_model TEXT`);
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

    // Migration: add memory_type column if missing
    try {
      this.db.prepare('SELECT memory_type FROM engrams LIMIT 0').get();
    } catch {
      this.db.exec(`ALTER TABLE engrams ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'unclassified'`);
    }
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
        ttl, memory_class, supersedes, task_status, task_priority, blocked_by, memory_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.memoryType ?? 'unclassified',
    );

    // Add to slim cache (skip if not yet populated — first slim fetch will load it)
    if (this.slimCachePopulated) {
      this.cacheAdd({
        id,
        agentId: input.agentId,
        concept: input.concept,
        embedding: input.embedding ?? null,
        stage: 'active',
        retracted: false,
      });
    }

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

  /**
   * Slim variant that returns only (id, concept, embedding) — the minimum needed
   * for the activation pipeline's pre-filter pass (cosine sim + concept-jaccard
   * survival check). Avoids materializing the content blob, tag JSON, salience
   * features JSON, etc. for ~10K rows when only ~200 will be deep-scored.
   *
   * Why: phase-breakdown spike (2026-05-08) showed the full SELECT * over 10K
   * engrams costs 440ms on a 17K-engram corpus — 40% of recall latency. Most
   * of that is row materialization of fields we don't read in the filter pass.
   */
  getEngramsByAgentSlim(
    agentId: string,
    stage?: EngramStage,
    includeRetracted: boolean = false
  ): Array<{ id: string; concept: string; embedding: number[] | null }> {
    if (this.slimCacheEnabled) {
      this.ensureSlimCachePopulated();
      const result: Array<{ id: string; concept: string; embedding: number[] | null }> = [];
      for (const entry of this.slimCache.values()) {
        if (entry.agentId !== agentId) continue;
        if (stage && entry.stage !== stage) continue;
        if (!includeRetracted && entry.retracted) continue;
        result.push({ id: entry.id, concept: entry.concept, embedding: entry.embedding });
      }
      return result;
    }
    // Cache disabled — fall back to direct SQL
    let query = 'SELECT id, concept, embedding FROM engrams WHERE agent_id = ?';
    const params: any[] = [agentId];

    if (stage) {
      query += ' AND stage = ?';
      params.push(stage);
    }
    if (!includeRetracted) {
      query += ' AND retracted = 0';
    }

    return (this.db.prepare(query).all(...params) as any[]).map(r => ({
      id: r.id as string,
      concept: r.concept as string,
      embedding: r.embedding ? Array.from(bufferToFloat32Array(r.embedding)) : null,
    }));
  }

  /** Slim variant for multi-agent (workspace-scoped) pre-filter. */
  getEngramsByAgentsSlim(
    agentIds: string[],
    stage?: EngramStage,
    includeRetracted: boolean = false
  ): Array<{ id: string; concept: string; embedding: number[] | null }> {
    if (agentIds.length === 0) return [];
    if (agentIds.length === 1) return this.getEngramsByAgentSlim(agentIds[0], stage, includeRetracted);

    if (this.slimCacheEnabled) {
      this.ensureSlimCachePopulated();
      const agentSet = new Set(agentIds);
      const result: Array<{ id: string; concept: string; embedding: number[] | null }> = [];
      for (const entry of this.slimCache.values()) {
        if (!agentSet.has(entry.agentId)) continue;
        if (stage && entry.stage !== stage) continue;
        if (!includeRetracted && entry.retracted) continue;
        result.push({ id: entry.id, concept: entry.concept, embedding: entry.embedding });
      }
      return result;
    }

    const placeholders = agentIds.map(() => '?').join(',');
    let query = `SELECT id, concept, embedding FROM engrams WHERE agent_id IN (${placeholders})`;
    const params: any[] = [...agentIds];

    if (stage) {
      query += ' AND stage = ?';
      params.push(stage);
    }
    if (!includeRetracted) {
      query += ' AND retracted = 0';
    }

    return (this.db.prepare(query).all(...params) as any[]).map(r => ({
      id: r.id as string,
      concept: r.concept as string,
      embedding: r.embedding ? Array.from(bufferToFloat32Array(r.embedding)) : null,
    }));
  }

  /**
   * Fetch full Engram rows for a list of IDs. Used after the pre-filter to hydrate
   * only the survivors that need deep scoring. Chunks IN-clause queries to stay
   * under SQLITE_LIMIT_VARIABLE_NUMBER (default 999).
   */
  getEngramsByIds(ids: string[]): Engram[] {
    if (ids.length === 0) return [];
    const CHUNK = 800;
    const result: Engram[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT * FROM engrams WHERE id IN (${placeholders})`
      ).all(...chunk) as any[];
      for (const r of rows) result.push(this.rowToEngram(r));
    }
    return result;
  }

  /**
   * Get engrams across multiple agents (workspace-scoped recall).
   * Used when workspace mode is enabled for hive memory sharing.
   */
  getEngramsByAgents(agentIds: string[], stage?: EngramStage, includeRetracted: boolean = false): Engram[] {
    if (agentIds.length === 0) return [];
    if (agentIds.length === 1) return this.getEngramsByAgent(agentIds[0], stage, includeRetracted);

    const placeholders = agentIds.map(() => '?').join(',');
    let query = `SELECT * FROM engrams WHERE agent_id IN (${placeholders})`;
    const params: any[] = [...agentIds];

    if (stage) {
      query += ' AND stage = ?';
      params.push(stage);
    }
    if (!includeRetracted) {
      query += ' AND retracted = 0';
    }

    return (this.db.prepare(query).all(...params) as any[]).map(r => this.rowToEngram(r));
  }

  /**
   * BM25 search across multiple agents (workspace-scoped).
   */
  searchBM25WithRankMultiAgent(agentIds: string[], query: string, limit: number = 10): { engram: Engram; bm25Score: number }[] {
    if (agentIds.length === 0) return [];
    if (agentIds.length === 1) return this.searchBM25WithRank(agentIds[0], query, limit);

    const sanitized = query
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => `"${w}"`)
      .join(' OR ');

    if (!sanitized) return [];

    // CTE prefilter — see searchBM25WithRank for rationale (567× speedup verified).
    try {
      const placeholders = agentIds.map(() => '?').join(',');
      const innerLimit = Math.max(limit * 5, 50);
      const rows = this.db.prepare(`
        WITH top_fts AS (
          SELECT rowid, rank FROM engrams_fts WHERE engrams_fts MATCH ? ORDER BY rank LIMIT ?
        )
        SELECT e.*, top_fts.rank FROM top_fts
        JOIN engrams e ON e.rowid = top_fts.rowid
        WHERE e.agent_id IN (${placeholders}) AND e.retracted = 0
        ORDER BY top_fts.rank
        LIMIT ?
      `).all(sanitized, innerLimit, ...agentIds, limit) as any[];

      return rows.map(r => ({
        engram: this.rowToEngram(r),
        bm25Score: Math.abs(r.rank ?? 0) / (1 + Math.abs(r.rank ?? 0)),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get all distinct agent IDs that share a workspace (requires coord_agents table).
   * Returns just the queried agentId if coordination tables don't exist.
   */
  getWorkspaceAgentIds(agentId: string, workspace: string): string[] {
    try {
      // Return agent names (not UUIDs) — engrams.agent_id uses name strings
      const rows = this.db.prepare(
        `SELECT DISTINCT name FROM coord_agents WHERE workspace = ? AND status != 'dead'`
      ).all(workspace) as Array<{ name: string }>;
      const names = rows.map(r => r.name);
      // Ensure the querying agent is always included
      if (!names.includes(agentId)) names.push(agentId);
      return names;
    } catch {
      // No coordination tables — fall back to single agent
      return [agentId];
    }
  }

  /**
   * Touch an engram: increment access count, update last_accessed, and
   * nudge confidence upward. Each retrieval is weak evidence the memory
   * is useful — bounded so only explicit feedback can push confidence
   * above 0.85. Diminishing returns: first accesses matter most.
   *
   * Boost: +0.02 per access, scaled by 1/sqrt(accessCount+1), capped at 0.85.
   */
  touchEngram(id: string): void {
    this.db.prepare(`
      UPDATE engrams
      SET access_count = access_count + 1,
          last_accessed = ?,
          confidence = MIN(0.85, confidence + 0.02 / (1.0 + sqrt(access_count)))
      WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  updateStage(id: string, stage: EngramStage): void {
    this.db.prepare('UPDATE engrams SET stage = ? WHERE id = ?').run(stage, id);
    this.cacheUpdateStage(id, stage);
  }

  updateConfidence(id: string, confidence: number): void {
    this.db.prepare('UPDATE engrams SET confidence = ? WHERE id = ?').run(
      Math.max(0, Math.min(1, confidence)), id
    );
  }

  updateEmbedding(id: string, embedding: number[], modelId?: string): void {
    const blob = Buffer.from(new Float32Array(embedding).buffer);
    if (modelId) {
      this.db.prepare('UPDATE engrams SET embedding = ?, embedding_model = ? WHERE id = ?').run(blob, modelId, id);
    } else {
      this.db.prepare('UPDATE engrams SET embedding = ? WHERE id = ?').run(blob, id);
    }
    this.cacheUpdateEmbedding(id, embedding);
  }

  retractEngram(id: string, retractedBy: string | null): void {
    this.db.prepare(`
      UPDATE engrams SET retracted = 1, retracted_by = ?, retracted_at = ? WHERE id = ?
    `).run(retractedBy, new Date().toISOString(), id);
    this.cacheRetract(id);
  }

  deleteEngram(id: string): void {
    this.db.prepare('DELETE FROM engrams WHERE id = ?').run(id);
    this.cacheRemove(id);
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

    // CTE prefilter: force FTS5 to apply LIMIT before joining engrams.
    //
    // Why: the obvious query (JOIN engrams_fts ON rowid + WHERE MATCH + ORDER BY rank LIMIT N)
    // makes SQLite's planner materialize ALL matching FTS rows joined with engrams
    // before applying LIMIT. With wide OR queries on a 17K-engram index, that's
    // thousands of row materializations including 1.5KB embedding blobs — measured
    // at 3682ms for a 5-term OR query.
    //
    // The CTE forces FTS5 to LIMIT first (sub-ms), then join only the top-K rowids.
    // Same query plan, 567× faster (3682ms → 6ms verified on 17K engrams).
    //
    // The inner LIMIT (limit * 5) over-fetches because the agent_id + retracted
    // filter is applied AFTER the CTE. limit*5 gives enough headroom that filtered
    // results still satisfy the outer LIMIT for typical workloads (single agent
    // dominant, low retracted rate).
    try {
      const innerLimit = Math.max(limit * 5, 50);
      const rows = this.db.prepare(`
        WITH top_fts AS (
          SELECT rowid, rank FROM engrams_fts WHERE engrams_fts MATCH ? ORDER BY rank LIMIT ?
        )
        SELECT e.*, top_fts.rank FROM top_fts
        JOIN engrams e ON e.rowid = top_fts.rowid
        WHERE e.agent_id = ? AND e.retracted = 0
        ORDER BY top_fts.rank
        LIMIT ?
      `).all(sanitized, innerLimit, agentId, limit) as any[];

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

  updateTags(id: string, tags: string[]): void {
    this.db.prepare('UPDATE engrams SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
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

  /**
   * Aggregate association stats per engram — count of edges and sum of weights.
   *
   * Why: the activation scoring loop only uses `associations.length` (Hebbian gate)
   * and `sum of weights` (Hebbian mean + centrality). It doesn't read individual
   * association fields. Returning scalar stats avoids materializing thousands of
   * Association objects.
   *
   * Phase-breakdown spike (2026-05-08, post-0.7.10) showed
   * `getAssociationsForBatch` over ~300 survivors took 222ms (25% of recall floor).
   * Stats-only aggregate via a single GROUP BY drops this to ~20ms.
   *
   * Graph walk still needs full Association rows, but it operates on top-N
   * (~30 candidates) — its per-call `getAssociationsFor` is cheap.
   */
  getAssociationStatsForBatch(engramIds: string[]): Map<string, { count: number; sumWeight: number }> {
    const result = new Map<string, { count: number; sumWeight: number }>();
    if (engramIds.length === 0) return result;

    const CHUNK = 400;
    for (let i = 0; i < engramIds.length; i += CHUNK) {
      const chunk = engramIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      // UNION ALL counts each association once per endpoint that's in the candidate
      // set — same semantics as the existing getAssociationsForBatch which buckets
      // associations under both their from and to engram. Self-loops would be
      // double-counted, but they're rare in practice and the prior code handled them
      // identically.
      const rows = this.db.prepare(
        `SELECT id, SUM(cnt) AS count, SUM(sw) AS sum_weight FROM (
           SELECT from_engram_id AS id, 1 AS cnt, weight AS sw FROM associations WHERE from_engram_id IN (${placeholders})
           UNION ALL
           SELECT to_engram_id AS id, 1 AS cnt, weight AS sw FROM associations WHERE to_engram_id IN (${placeholders})
         )
         WHERE id IN (${placeholders})
         GROUP BY id`
      ).all(...chunk, ...chunk, ...chunk) as Array<{ id: string; count: number; sum_weight: number }>;

      for (const r of rows) {
        result.set(r.id, { count: r.count, sumWeight: r.sum_weight });
      }
    }
    // Ensure every requested id has an entry (even zero-edge engrams)
    for (const id of engramIds) {
      if (!result.has(id)) result.set(id, { count: 0, sumWeight: 0 });
    }
    return result;
  }

  /**
   * Batch variant of getAssociationsFor — fetches associations for many engrams
   * in a single query, returning a Map keyed by engram id.
   *
   * Why: per-candidate `getAssociationsFor` calls inside the activation scoring
   * loop are an N+1. Measured at 1300ms for 10K candidates (sub-ms per call but
   * accumulating). One IN-clause query reduces this to ~50ms.
   */
  getAssociationsForBatch(engramIds: string[]): Map<string, Association[]> {
    const result = new Map<string, Association[]>();
    if (engramIds.length === 0) return result;

    // SQLite's default SQLITE_LIMIT_VARIABLE_NUMBER is 999. Chunk to stay safely below.
    // We bind each id twice (from + to), so chunks of 400 use 800 placeholders.
    const CHUNK = 400;
    for (let i = 0; i < engramIds.length; i += CHUNK) {
      const chunk = engramIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT * FROM associations
         WHERE from_engram_id IN (${placeholders}) OR to_engram_id IN (${placeholders})`
      ).all(...chunk, ...chunk) as any[];
      for (const r of rows) {
        const a = this.rowToAssociation(r);
        // Bucket by both endpoints — getAssociationsFor returns either-direction matches.
        const fromList = result.get(a.fromEngramId) ?? [];
        fromList.push(a);
        result.set(a.fromEngramId, fromList);
        if (a.toEngramId !== a.fromEngramId) {
          const toList = result.get(a.toEngramId) ?? [];
          toList.push(a);
          result.set(a.toEngramId, toList);
        }
      }
    }
    // Ensure every requested id has an entry (even if empty) so callers can
    // .get() without null-checking.
    for (const id of engramIds) {
      if (!result.has(id)) result.set(id, []);
    }
    return result;
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
      memoryType: (row.memory_type ?? 'unclassified') as MemoryType,
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
    this.stopWalCheckpointTimer();
    this.walCheckpoint();
    this.db.close();
  }
}
