// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * PGlite-backed EngramStore (AWM 0.8.x P4a).
 *
 * Uses @electric-sql/pglite — Postgres compiled to WASM, single-file
 * persistence (or in-memory), pgvector built in. Same SQL surface as
 * Postgres server, just a different driver.
 *
 * The full IEngramStore contract is implemented as async methods. Cognitive
 * engines call store methods with await; the existing SQLite sync path
 * continues to work via SqliteEngramStore (unchanged).
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { randomUUID } from 'node:crypto';

import type {
  Engram, EngramCreate, EngramStage, Association, AssociationType,
  SearchQuery, ActivationEvent, StagingEvent,
  Episode, TaskStatus, TaskPriority, MemoryClass, MemoryType,
  ConsciousState, CheckpointRow,
} from '../types/index.js';
import { PGLITE_SCHEMA_DDL, PGLITE_VECTOR_DIMENSIONS } from './pglite-schema.js';

function toISO(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString() : d;
}

/**
 * Optional calibration knob for `ts_rank_cd` → bm25-compatible score range.
 * **Default is pass-through (no calibration).**
 *
 * Background: SQLite normalizes FTS5 BM25 rank via `|rank|/(1+|rank|)`,
 * producing scores in [0.5, 0.95] for matched docs. Postgres `ts_rank_cd`
 * (cover density) raw values land in [0.05, 0.5] — a similar shape but a
 * different *algorithm* than BM25.
 *
 * I tried calibrating with `M=10` to make PGlite's bm25Score distribution
 * match SQLite's (`scripts/measure-bm25.ts`, 2026-05-26). The distribution
 * matched, but the test:tokens accuracy gap (PGlite 25% vs SQLite 42.5%)
 * did NOT close. Per-write trace (`scripts/trace-salience.ts`) showed
 * `ts_rank_cd` and FTS5 BM25 disagree on which document pairs are
 * "duplicates" for short-text matches — that's an algorithmic difference,
 * not a magnitude one. ts_rank (frequency-weighted) doesn't help either.
 *
 * Default M=1 = no calibration. The function is kept as a tuning surface
 * for future work on the salience-novelty path (likely going to need
 * embedding-based novelty or per-backend calibration tables).
 *
 * Env override: `AWM_PGLITE_BM25_M`.
 */
const PGLITE_BM25_M = Number(process.env.AWM_PGLITE_BM25_M ?? 1);
function calibrateBm25(rawTsRank: number): number {
  if (!Number.isFinite(rawTsRank) || rawTsRank <= 0) return 0;
  if (PGLITE_BM25_M === 1) return rawTsRank;
  const scaled = rawTsRank * PGLITE_BM25_M;
  return scaled / (1 + scaled);
}

function vectorToLiteral(v: number[] | null | undefined): string | null {
  if (!v || v.length === 0) return null;
  return '[' + v.join(',') + ']';
}

function literalToVector(s: string | null | undefined): number[] | null {
  if (!s) return null;
  return s.replace(/^\[|\]$/g, '').split(',').map(Number);
}

function rowToEngram(row: any): Engram {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    concept: row.concept as string,
    content: row.content as string,
    embedding: literalToVector(row.embedding as string | null),
    confidence: row.confidence as number,
    salience: row.salience as number,
    accessCount: row.access_count as number,
    lastAccessed: new Date(row.last_accessed as string),
    createdAt: new Date(row.created_at as string),
    salienceFeatures: row.salience_features ? JSON.parse(row.salience_features as string) : {},
    reasonCodes: row.reason_codes ? JSON.parse(row.reason_codes as string) : [],
    stage: (row.stage as EngramStage) ?? 'active',
    ttl: (row.ttl as number | null) ?? null,
    retracted: Boolean(row.retracted),
    retractedBy: (row.retracted_by as string | null) ?? null,
    retractedAt: row.retracted_at ? new Date(row.retracted_at as string) : null,
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    memoryType: (row.memory_type as MemoryType) ?? 'unclassified',
    memoryClass: (row.memory_class as MemoryClass) ?? 'working',
    supersededBy: (row.superseded_by as string | null) ?? null,
    supersedes: (row.supersedes as string | null) ?? null,
    episodeId: (row.episode_id as string | null) ?? null,
    taskStatus: (row.task_status as TaskStatus | null) ?? null,
    taskPriority: (row.task_priority as TaskPriority | null) ?? null,
    blockedBy: (row.blocked_by as string | null) ?? null,
    sequence: row.sequence == null ? null : Number(row.sequence),
    references: row.references_json ? JSON.parse(row.references_json as string) : null,
  } as Engram;
}

function rowToAssociation(row: any): Association {
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

function rowToEpisode(row: any): Episode {
  return {
    id: row.id,
    agentId: row.agent_id,
    label: row.label,
    embedding: literalToVector(row.embedding as string | null),
    engramCount: row.engram_count,
    startTime: new Date(row.start_time),
    endTime: new Date(row.end_time),
    createdAt: new Date(row.created_at),
  };
}

function tagLike(tag: string): string {
  return `%"${tag}"%`;
}

function extractTagValue(tags: string[], prefix: string): string | null {
  for (const t of tags) {
    if (t.startsWith(prefix)) return t.slice(prefix.length);
  }
  return null;
}

export class PGliteEngramStore {
  private db!: PGlite;
  private readyPromise: Promise<void>;

  // Activation-event batching — recall path writes one event per call. On
  // PGlite that's a full transaction per recall, adding ~20-50ms. We queue
  // events in memory and flush every 5s or when buffer reaches 100.
  // Buffer is best-effort — crash loses last batch (eval data only, not state).
  private activationEventBuffer: ActivationEvent[] = [];
  private activationFlushTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly ACTIVATION_FLUSH_INTERVAL_MS = 5_000;
  private static readonly ACTIVATION_FLUSH_BATCH_SIZE = 100;

  constructor(dbPath: string = './memory.db') {
    this.readyPromise = this.init(dbPath);
  }

  private async init(dataDir: string): Promise<void> {
    this.db = await PGlite.create(dataDir, { extensions: { vector } });
    await this.db.exec(PGLITE_SCHEMA_DDL);
    // ivfflat probes: at lists=100 (set in pglite-schema.ts), default probes=1
    // scans only 1 cluster which misses neighbors on sparse query distributions.
    // probes=5 trades ~10-20ms latency for ~5x better recall on top-K — the
    // sweet spot for our 1K–100K engram range. Tunable via AWM_IVFFLAT_PROBES.
    const probes = parseInt(process.env.AWM_IVFFLAT_PROBES ?? '5', 10);
    if (probes > 1) {
      await this.db.exec(`SET ivfflat.probes = ${probes}`);
    }
    // Periodic flush for batched activation events.
    this.activationFlushTimer = setInterval(
      () => { void this.flushActivationEvents().catch(() => {/* best-effort */}); },
      PGliteEngramStore.ACTIVATION_FLUSH_INTERVAL_MS,
    );
  }

  async ready(): Promise<void> { return this.readyPromise; }

  async close(): Promise<void> {
    await this.readyPromise;
    if (this.activationFlushTimer) {
      clearInterval(this.activationFlushTimer);
      this.activationFlushTimer = null;
    }
    await this.flushActivationEvents();
    await this.db.close();
  }

  /**
   * Flush queued activation events as a single multi-row INSERT.
   * Idempotent — safe to call when the buffer is empty.
   */
  private async flushActivationEvents(): Promise<void> {
    if (this.activationEventBuffer.length === 0) return;
    const batch = this.activationEventBuffer.splice(0);
    const values: string[] = [];
    const params: any[] = [];
    for (let i = 0; i < batch.length; i++) {
      const e = batch[i];
      const base = i * 8;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
      params.push(
        e.id, e.agentId, e.timestamp.toISOString(),
        e.context, e.resultsReturned, e.topScore,
        e.latencyMs, JSON.stringify(e.engramIds),
      );
    }
    try {
      await this.db.query(
        `INSERT INTO activation_events (id, agent_id, timestamp, context, results_returned, top_score, latency_ms, engram_ids)
         VALUES ${values.join(',')}`,
        params,
      );
    } catch {
      // Drop the batch on failure — eval data, not state.
    }
  }

  /**
   * Async-aware transaction wrapper that matches IEngramStore.withTransaction.
   *
   * Uses raw BEGIN/COMMIT/ROLLBACK on the shared connection so `fn` can call
   * the regular (non-tx-context) store methods — they all funnel through
   * `this.db.query()` which serializes on the same PGlite connection.
   * The transaction lock is held across awaits inside fn.
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.readyPromise;
    await this.db.query('BEGIN');
    try {
      const result = await fn();
      await this.db.query('COMMIT');
      return result;
    } catch (err) {
      try { await this.db.query('ROLLBACK'); } catch { /* best-effort */ }
      throw err;
    }
  }

  // ============================================================
  // Engram CRUD
  // ============================================================

  async createEngram(input: EngramCreate & { id?: string }): Promise<Engram> {
    await this.readyPromise;
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();

    await this.db.query(
      `INSERT INTO engrams (
        id, agent_id, concept, content, embedding, embedding_model,
        confidence, salience, access_count, last_accessed, created_at,
        salience_features, reason_codes, stage, ttl, retracted,
        tags, memory_type, memory_class, supersedes, episode_id,
        task_status, task_priority, blocked_by, sequence, references_json
      ) VALUES (
        $1, $2, $3, $4, $5::vector, $6,
        $7, $8, 0, $9, $10,
        $11, $12, 'active', $13, FALSE,
        $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23
      )`,
      [
        id,
        input.agentId,
        input.concept,
        input.content,
        vectorToLiteral(input.embedding ?? null),
        (input as any).embeddingModel ?? null,
        input.confidence ?? 0.5,
        input.salience ?? 0.5,
        now, now,
        JSON.stringify(input.salienceFeatures ?? {}),
        JSON.stringify((input as any).reasonCodes ?? []),
        (input as any).ttl ?? null,
        JSON.stringify(input.tags ?? []),
        (input as any).memoryType ?? 'unclassified',
        (input as any).memoryClass ?? 'working',
        (input as any).supersedes ?? null,
        (input as any).episodeId ?? null,
        (input as any).taskStatus ?? null,
        (input as any).taskPriority ?? null,
        (input as any).blockedBy ?? null,
        (input as any).sequence ?? null,
        input.references && input.references.length > 0
          ? JSON.stringify(input.references) : null,
      ],
    );

    const row = await this.getEngram(id);
    if (!row) throw new Error(`createEngram: row ${id} not found after insert`);
    return row;
  }

  async getEngram(id: string): Promise<Engram | null> {
    await this.readyPromise;
    const result = await this.db.query<any>(`SELECT * FROM engrams WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return rowToEngram(result.rows[0]);
  }

  async getEngramsByAgent(agentId: string, stage?: EngramStage, includeRetracted: boolean = false): Promise<Engram[]> {
    await this.readyPromise;
    let sql = `SELECT * FROM engrams WHERE agent_id = $1`;
    const params: any[] = [agentId];
    if (stage) {
      sql += ` AND stage = $${params.length + 1}`;
      params.push(stage);
    }
    if (!includeRetracted) sql += ` AND retracted = FALSE`;
    sql += ` ORDER BY created_at DESC`;
    const result = await this.db.query<any>(sql, params);
    return result.rows.map(rowToEngram);
  }

  async getEngramsByAgentSlim(
    agentId: string,
    stage?: EngramStage,
    includeRetracted: boolean = false,
  ): Promise<Array<{ id: string; concept: string; embedding: number[] | null }>> {
    await this.readyPromise;
    let sql = `SELECT id, concept, embedding FROM engrams WHERE agent_id = $1`;
    const params: any[] = [agentId];
    if (stage) {
      sql += ` AND stage = $${params.length + 1}`;
      params.push(stage);
    }
    if (!includeRetracted) sql += ` AND retracted = FALSE`;
    const result = await this.db.query<any>(sql, params);
    return result.rows.map((r) => ({
      id: r.id as string,
      concept: r.concept as string,
      embedding: literalToVector(r.embedding as string | null),
    }));
  }

  async getEngramsByAgentsSlim(
    agentIds: string[],
    stage?: EngramStage,
    includeRetracted: boolean = false,
  ): Promise<Array<{ id: string; concept: string; embedding: number[] | null }>> {
    if (agentIds.length === 0) return [];
    if (agentIds.length === 1) return this.getEngramsByAgentSlim(agentIds[0], stage, includeRetracted);
    await this.readyPromise;
    let sql = `SELECT id, concept, embedding FROM engrams WHERE agent_id = ANY($1::text[])`;
    const params: any[] = [agentIds];
    if (stage) {
      sql += ` AND stage = $${params.length + 1}`;
      params.push(stage);
    }
    if (!includeRetracted) sql += ` AND retracted = FALSE`;
    const result = await this.db.query<any>(sql, params);
    return result.rows.map((r) => ({
      id: r.id as string,
      concept: r.concept as string,
      embedding: literalToVector(r.embedding as string | null),
    }));
  }

  async getEngramsByIds(ids: string[]): Promise<Engram[]> {
    if (ids.length === 0) return [];
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM engrams WHERE id = ANY($1::text[])`,
      [ids],
    );
    return result.rows.map(rowToEngram);
  }

  async getEngramsByAgents(agentIds: string[], stage?: EngramStage, includeRetracted: boolean = false): Promise<Engram[]> {
    if (agentIds.length === 0) return [];
    if (agentIds.length === 1) return this.getEngramsByAgent(agentIds[0], stage, includeRetracted);
    await this.readyPromise;
    let sql = `SELECT * FROM engrams WHERE agent_id = ANY($1::text[])`;
    const params: any[] = [agentIds];
    if (stage) {
      sql += ` AND stage = $${params.length + 1}`;
      params.push(stage);
    }
    if (!includeRetracted) sql += ` AND retracted = FALSE`;
    const result = await this.db.query<any>(sql, params);
    return result.rows.map(rowToEngram);
  }

  async getWorkspaceAgentIds(agentId: string, workspace: string): Promise<string[]> {
    await this.readyPromise;
    try {
      const result = await this.db.query<any>(
        `SELECT DISTINCT name FROM coord_agents WHERE workspace = $1 AND status != 'dead'`,
        [workspace],
      );
      const names = result.rows.map((r) => r.name as string);
      if (!names.includes(agentId)) names.push(agentId);
      return names;
    } catch {
      return [agentId];
    }
  }

  async touchEngram(id: string): Promise<void> {
    await this.readyPromise;
    await this.db.query(
      `UPDATE engrams
       SET access_count = access_count + 1,
           last_accessed = $1,
           confidence = LEAST(0.85, confidence + 0.02 / (1.0 + sqrt(access_count::float)))
       WHERE id = $2`,
      [new Date().toISOString(), id],
    );
  }

  async updateStage(id: string, stage: EngramStage): Promise<void> {
    await this.readyPromise;
    await this.db.query(`UPDATE engrams SET stage = $1 WHERE id = $2`, [stage, id]);
  }

  /**
   * Replace an engram's content. Used by the fade phase of consolidation
   * (Paper 1: storage degradation) to coarsen un-recalled memories.
   * The FTS trigger (BEFORE INSERT OR UPDATE OF concept, content, tags)
   * automatically refreshes the tsvector index with the new content.
   */
  async updateContent(id: string, content: string): Promise<void> {
    await this.readyPromise;
    await this.db.query(`UPDATE engrams SET content = $1 WHERE id = $2`, [content, id]);
  }

  async updateConfidence(id: string, confidence: number): Promise<void> {
    await this.readyPromise;
    const clamped = Math.max(0, Math.min(1, confidence));
    await this.db.query(`UPDATE engrams SET confidence = $1 WHERE id = $2`, [clamped, id]);
  }

  async updateEmbedding(id: string, embedding: number[], modelId?: string): Promise<void> {
    await this.readyPromise;
    if (modelId) {
      await this.db.query(
        `UPDATE engrams SET embedding = $1::vector, embedding_model = $2 WHERE id = $3`,
        [vectorToLiteral(embedding), modelId, id],
      );
    } else {
      await this.db.query(
        `UPDATE engrams SET embedding = $1::vector WHERE id = $2`,
        [vectorToLiteral(embedding), id],
      );
    }
  }

  async retractEngram(id: string, retractedBy: string | null): Promise<void> {
    await this.readyPromise;
    await this.db.query(
      `UPDATE engrams SET retracted = TRUE, retracted_by = $1, retracted_at = $2 WHERE id = $3`,
      [retractedBy, new Date().toISOString(), id],
    );
  }

  async deleteEngram(id: string): Promise<void> {
    await this.readyPromise;
    await this.db.query(`DELETE FROM engrams WHERE id = $1`, [id]);
  }

  /**
   * Time warp - shift all timestamps backward by ms milliseconds.
   * Used for testing decay-dependent behavior.
   */
  async timeWarp(agentId: string, ms: number): Promise<number> {
    await this.readyPromise;
    const seconds = Math.round(ms / 1000);
    const r1 = await this.db.query(
      `UPDATE engrams SET
         created_at = to_char(($1::timestamptz - interval '1 second' * $2), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         last_accessed = to_char(($3::timestamptz - interval '1 second' * $2), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       WHERE agent_id = $4`,
      ['now', seconds, 'now', agentId],
    );
    // Simpler: just update with relative arithmetic on stored ISO strings.
    // PGlite doesn't support all date ops cleanly; fall through to JS-side calculation.
    return (r1 as any).affectedRows ?? 0;
  }

  async getLatestEngram(agentId: string, excludeId?: string): Promise<Engram | null> {
    await this.readyPromise;
    let sql = `SELECT * FROM engrams WHERE agent_id = $1 AND retracted = FALSE`;
    const params: any[] = [agentId];
    if (excludeId) {
      sql += ` AND id != $${params.length + 1}`;
      params.push(excludeId);
    }
    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const result = await this.db.query<any>(sql, params);
    return result.rows.length > 0 ? rowToEngram(result.rows[0]) : null;
  }

  // ============================================================
  // Search
  // ============================================================

  async searchByVector(agentId: string, vec: number[], limit: number = 10): Promise<Array<{ engram: Engram; distance: number }>> {
    await this.readyPromise;
    // Restrict to active + fading. Faded engrams (Paper 1: storage degradation)
    // retain their embedding so they still participate in semantic recall, even
    // though their content has been trimmed. Excludes staging/consolidated/archived.
    const result = await this.db.query<any>(
      `SELECT *, (embedding <=> $2::vector) AS distance
       FROM engrams
       WHERE agent_id = $1
         AND embedding IS NOT NULL
         AND retracted = FALSE
         AND stage IN ('active', 'fading')
       ORDER BY distance ASC
       LIMIT $3`,
      [agentId, vectorToLiteral(vec), limit],
    );
    return result.rows.map((r) => ({ engram: rowToEngram(r), distance: r.distance as number }));
  }

  async searchBM25(agentId: string, query: string, limit: number = 10): Promise<Engram[]> {
    const ranked = await this.searchBM25WithRank(agentId, query, limit);
    return ranked.map((r) => r.engram);
  }

  async searchBM25WithRank(agentId: string, query: string, limit: number = 10): Promise<Array<{ engram: Engram; bm25Score: number }>> {
    await this.readyPromise;
    // SQLite FTS5 uses OR-by-default; we mirror that with websearch_to_tsquery
    // and explicit OR joining. plainto_tsquery would AND all terms, missing
    // documents that contain only a subset of the query (e.g., a "correction"
    // engram lacking the exact word "operator" but matching "javascript",
    // "equality", "type").
    const tokens = query.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(t => t.length > 1);
    if (tokens.length === 0) return [];
    const websearchQuery = tokens.join(' OR ');
    const result = await this.db.query<any>(
      `SELECT *, ts_rank_cd(fts, websearch_to_tsquery('english', $2)) AS rank
       FROM engrams
       WHERE agent_id = $1 AND retracted = FALSE
         AND fts @@ websearch_to_tsquery('english', $2)
       ORDER BY rank DESC
       LIMIT $3`,
      [agentId, websearchQuery, limit],
    );
    return result.rows.map((r) => ({ engram: rowToEngram(r), bm25Score: calibrateBm25(Number(r.rank)) }));
  }

  async searchBM25WithRankMultiAgent(agentIds: string[], query: string, limit: number = 10): Promise<Array<{ engram: Engram; bm25Score: number }>> {
    if (agentIds.length === 0) return [];
    if (agentIds.length === 1) return this.searchBM25WithRank(agentIds[0], query, limit);
    await this.readyPromise;
    const tokens = query.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(t => t.length > 1);
    if (tokens.length === 0) return [];
    const websearchQuery = tokens.join(' OR ');
    const result = await this.db.query<any>(
      `SELECT *, ts_rank_cd(fts, websearch_to_tsquery('english', $2)) AS rank
       FROM engrams
       WHERE agent_id = ANY($1::text[]) AND retracted = FALSE
         AND fts @@ websearch_to_tsquery('english', $2)
       ORDER BY rank DESC
       LIMIT $3`,
      [agentIds, websearchQuery, limit],
    );
    return result.rows.map((r) => ({ engram: rowToEngram(r), bm25Score: calibrateBm25(Number(r.rank)) }));
  }

  /** Deterministic search (no vector or BM25 ranking — for diagnostic / structural queries). */
  async search(query: SearchQuery): Promise<Engram[]> {
    await this.readyPromise;
    let sql = `SELECT * FROM engrams WHERE agent_id = $1`;
    const params: any[] = [query.agentId];

    if (query.text) {
      sql += ` AND (content ILIKE $${params.length + 1} OR concept ILIKE $${params.length + 1})`;
      params.push(`%${query.text}%`);
    }
    if (query.concept) {
      sql += ` AND concept = $${params.length + 1}`;
      params.push(query.concept);
    }
    if (query.stage) {
      sql += ` AND stage = $${params.length + 1}`;
      params.push(query.stage);
    }
    if (query.retracted !== undefined) {
      sql += ` AND retracted = $${params.length + 1}`;
      params.push(query.retracted);
    }
    const allTags = [...(query.tags ?? []), ...(query.tagsAll ?? [])];
    for (const tag of allTags) {
      sql += ` AND tags LIKE $${params.length + 1}`;
      params.push(tagLike(tag));
    }
    if (query.tagsAny && query.tagsAny.length > 0) {
      const ors = query.tagsAny.map((_, i) => `tags LIKE $${params.length + 1 + i}`).join(' OR ');
      sql += ` AND (${ors})`;
      for (const tag of query.tagsAny) params.push(tagLike(tag));
    }
    if (query.tagsNone && query.tagsNone.length > 0) {
      const ors = query.tagsNone.map((_, i) => `tags LIKE $${params.length + 1 + i}`).join(' OR ');
      sql += ` AND NOT (${ors})`;
      for (const tag of query.tagsNone) params.push(tagLike(tag));
    }

    const sortCol = ({
      createdAt: 'created_at', sequence: 'sequence', salience: 'salience',
      confidence: 'confidence', lastAccessed: 'last_accessed',
    } as const)[query.sortBy ?? 'lastAccessed'];
    const dir = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    if (query.sortBy === 'sequence') {
      sql += ` ORDER BY (sequence IS NULL), sequence ${dir}`;
    } else {
      sql += ` ORDER BY ${sortCol} ${dir}`;
    }
    sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(query.limit ?? 50, query.offset ?? 0);

    const result = await this.db.query<any>(sql, params);
    return result.rows.map(rowToEngram);
  }

  // ============================================================
  // Tasks
  // ============================================================

  async updateTaskStatus(id: string, status: TaskStatus): Promise<void> {
    await this.readyPromise;
    await this.db.query(`UPDATE engrams SET task_status = $1 WHERE id = $2`, [status, id]);
  }

  async updateTaskPriority(id: string, priority: TaskPriority): Promise<void> {
    await this.readyPromise;
    await this.db.query(`UPDATE engrams SET task_priority = $1 WHERE id = $2`, [priority, id]);
  }

  async updateBlockedBy(id: string, blockedBy: string | null): Promise<void> {
    await this.readyPromise;
    await this.db.query(
      `UPDATE engrams SET blocked_by = $1, task_status = $2 WHERE id = $3`,
      [blockedBy, blockedBy ? 'blocked' : 'open', id],
    );
  }

  async getTasks(agentId: string, status?: TaskStatus): Promise<Engram[]> {
    await this.readyPromise;
    let sql = `SELECT * FROM engrams WHERE agent_id = $1 AND task_status IS NOT NULL AND retracted = FALSE`;
    const params: any[] = [agentId];
    if (status) {
      sql += ` AND task_status = $${params.length + 1}`;
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
    const result = await this.db.query<any>(sql, params);
    return result.rows.map(rowToEngram);
  }

  async getNextTask(agentId: string): Promise<Engram | null> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM engrams
       WHERE agent_id = $1 AND task_status IN ('open', 'in_progress') AND retracted = FALSE
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
       LIMIT 1`,
      [agentId],
    );
    return result.rows.length > 0 ? rowToEngram(result.rows[0]) : null;
  }

  // ============================================================
  // Supersession & tags
  // ============================================================

  async supersedeEngram(oldId: string, newId: string): Promise<void> {
    await this.readyPromise;
    await this.db.query(`UPDATE engrams SET superseded_by = $1 WHERE id = $2`, [newId, oldId]);
    await this.db.query(`UPDATE engrams SET supersedes = $1 WHERE id = $2`, [oldId, newId]);
  }

  async findActiveMatchByConcept(
    agentId: string,
    concept: string,
    requiredTags?: string[],
  ): Promise<Engram | null> {
    await this.readyPromise;
    let sql = `SELECT * FROM engrams
               WHERE agent_id = $1
                 AND LOWER(TRIM(concept)) = LOWER(TRIM($2))
                 AND stage = 'active'
                 AND retracted = FALSE
                 AND superseded_by IS NULL`;
    const params: any[] = [agentId, concept];
    if (requiredTags && requiredTags.length > 0) {
      for (const tag of requiredTags) {
        sql += ` AND tags LIKE $${params.length + 1}`;
        params.push(tagLike(tag));
      }
    }
    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const result = await this.db.query<any>(sql, params);
    return result.rows.length > 0 ? rowToEngram(result.rows[0]) : null;
  }

  async isSuperseded(id: string): Promise<boolean> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT superseded_by FROM engrams WHERE id = $1`,
      [id],
    );
    return result.rows.length > 0 && result.rows[0].superseded_by != null;
  }

  async updateMemoryClass(id: string, memoryClass: MemoryClass): Promise<void> {
    await this.readyPromise;
    await this.db.query(`UPDATE engrams SET memory_class = $1 WHERE id = $2`, [memoryClass, id]);
  }

  async updateTags(id: string, tags: string[]): Promise<void> {
    await this.readyPromise;
    await this.db.query(`UPDATE engrams SET tags = $1 WHERE id = $2`, [JSON.stringify(tags), id]);
  }

  // ============================================================
  // Associations
  // ============================================================

  async upsertAssociation(
    fromId: string, toId: string, weight: number,
    type: AssociationType = 'hebbian', confidence: number = 0.5,
  ): Promise<Association> {
    await this.readyPromise;
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO associations (id, from_engram_id, to_engram_id, weight, confidence, type, activation_count, created_at, last_activated)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)
       ON CONFLICT (from_engram_id, to_engram_id) DO UPDATE SET
         weight = EXCLUDED.weight,
         confidence = EXCLUDED.confidence,
         last_activated = EXCLUDED.last_activated,
         activation_count = associations.activation_count + 1`,
      [id, fromId, toId, weight, confidence, type, now],
    );
    const assoc = await this.getAssociation(fromId, toId);
    if (!assoc) throw new Error('upsertAssociation: row not found after insert');
    return assoc;
  }

  async getAssociation(fromId: string, toId: string): Promise<Association | null> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM associations WHERE from_engram_id = $1 AND to_engram_id = $2`,
      [fromId, toId],
    );
    return result.rows.length > 0 ? rowToAssociation(result.rows[0]) : null;
  }

  async getAssociationsFor(engramId: string): Promise<Association[]> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM associations WHERE from_engram_id = $1 OR to_engram_id = $1`,
      [engramId],
    );
    return result.rows.map(rowToAssociation);
  }

  async getAssociationStatsForBatch(engramIds: string[]): Promise<Map<string, { count: number; sumWeight: number }>> {
    const result = new Map<string, { count: number; sumWeight: number }>();
    if (engramIds.length === 0) return result;
    await this.readyPromise;
    const r = await this.db.query<any>(
      `SELECT id, SUM(cnt) AS count, SUM(sw) AS sum_weight FROM (
         SELECT from_engram_id AS id, 1 AS cnt, weight AS sw FROM associations WHERE from_engram_id = ANY($1::text[])
         UNION ALL
         SELECT to_engram_id   AS id, 1 AS cnt, weight AS sw FROM associations WHERE to_engram_id   = ANY($1::text[])
       ) t
       WHERE id = ANY($1::text[])
       GROUP BY id`,
      [engramIds],
    );
    for (const row of r.rows) {
      result.set(row.id as string, { count: Number(row.count), sumWeight: Number(row.sum_weight) });
    }
    for (const id of engramIds) {
      if (!result.has(id)) result.set(id, { count: 0, sumWeight: 0 });
    }
    return result;
  }

  async getAssociationsForBatch(engramIds: string[]): Promise<Map<string, Association[]>> {
    const result = new Map<string, Association[]>();
    if (engramIds.length === 0) return result;
    await this.readyPromise;
    const r = await this.db.query<any>(
      `SELECT * FROM associations
       WHERE from_engram_id = ANY($1::text[]) OR to_engram_id = ANY($1::text[])`,
      [engramIds],
    );
    for (const row of r.rows) {
      const a = rowToAssociation(row);
      const fromList = result.get(a.fromEngramId) ?? [];
      fromList.push(a);
      result.set(a.fromEngramId, fromList);
      if (a.toEngramId !== a.fromEngramId) {
        const toList = result.get(a.toEngramId) ?? [];
        toList.push(a);
        result.set(a.toEngramId, toList);
      }
    }
    for (const id of engramIds) {
      if (!result.has(id)) result.set(id, []);
    }
    return result;
  }

  async getOutgoingAssociations(engramId: string): Promise<Association[]> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM associations WHERE from_engram_id = $1`,
      [engramId],
    );
    return result.rows.map(rowToAssociation);
  }

  async countAssociationsFor(engramId: string): Promise<number> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT COUNT(*) AS count FROM associations WHERE from_engram_id = $1`,
      [engramId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getWeakestAssociation(engramId: string): Promise<Association | null> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM associations WHERE from_engram_id = $1 ORDER BY weight ASC LIMIT 1`,
      [engramId],
    );
    return result.rows.length > 0 ? rowToAssociation(result.rows[0]) : null;
  }

  async deleteAssociation(id: string): Promise<void> {
    await this.readyPromise;
    await this.db.query(`DELETE FROM associations WHERE id = $1`, [id]);
  }

  async getAllAssociations(agentId: string): Promise<Association[]> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT a.* FROM associations a
       JOIN engrams e ON a.from_engram_id = e.id
       WHERE e.agent_id = $1`,
      [agentId],
    );
    return result.rows.map(rowToAssociation);
  }

  // ============================================================
  // Eviction & counts
  // ============================================================

  async getEvictionCandidates(agentId: string, limit: number): Promise<Engram[]> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM engrams
       WHERE agent_id = $1 AND stage = 'active' AND retracted = FALSE
       ORDER BY (salience * 0.3 + confidence * 0.3
                 + (access_count::float / (access_count + 5)) * 0.2
                 + (1.0 / (1.0 + EXTRACT(EPOCH FROM (now() - last_accessed::timestamptz)) / 86400.0)) * 0.2) ASC
       LIMIT $2`,
      [agentId, limit],
    );
    return result.rows.map(rowToEngram);
  }

  async getActiveCount(agentId: string): Promise<number> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT COUNT(*) AS count FROM engrams WHERE agent_id = $1 AND stage = 'active'`,
      [agentId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getStagingCount(agentId: string): Promise<number> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT COUNT(*) AS count FROM engrams WHERE agent_id = $1 AND stage = 'staging'`,
      [agentId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getExpiredStaging(): Promise<Engram[]> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM engrams WHERE stage = 'staging' AND ttl IS NOT NULL`,
    );
    const now = Date.now();
    return result.rows
      .map(rowToEngram)
      .filter((e) => e.ttl && (e.createdAt.getTime() + e.ttl) < now);
  }

  // ============================================================
  // Eval logging
  // ============================================================

  async logActivationEvent(event: ActivationEvent): Promise<void> {
    // Queue rather than write synchronously — removes activation INSERT from
    // the recall hot path. Flushed on timer (5s) or when buffer hits 100.
    this.activationEventBuffer.push(event);
    if (this.activationEventBuffer.length >= PGliteEngramStore.ACTIVATION_FLUSH_BATCH_SIZE) {
      void this.flushActivationEvents().catch(() => {/* best-effort */});
    }
  }

  async logStagingEvent(event: StagingEvent): Promise<void> {
    await this.readyPromise;
    await this.db.query(
      `INSERT INTO staging_events (engram_id, agent_id, action, resonance_score, timestamp, age_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.engramId, event.agentId, event.action,
        event.resonanceScore, event.timestamp.toISOString(), event.ageMs,
      ],
    );
  }

  async logRetrievalFeedback(activationEventId: string | null, engramId: string, useful: boolean, context: string): Promise<void> {
    await this.readyPromise;
    await this.db.query(
      `INSERT INTO retrieval_feedback (id, activation_event_id, engram_id, useful, context, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), activationEventId, engramId, useful, context, new Date().toISOString()],
    );
  }

  async getRetrievalPrecision(agentId: string, windowHours: number = 24): Promise<number> {
    await this.readyPromise;
    const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const result = await this.db.query<any>(
      `SELECT
         COUNT(CASE WHEN useful = TRUE THEN 1 END) AS useful_count,
         COUNT(*) AS total_count
       FROM retrieval_feedback rf
       LEFT JOIN activation_events ae ON rf.activation_event_id = ae.id
       JOIN engrams e ON rf.engram_id = e.id
       WHERE e.agent_id = $1 AND rf.timestamp > $2`,
      [agentId, since],
    );
    const row = result.rows[0];
    const total = Number(row?.total_count ?? 0);
    const useful = Number(row?.useful_count ?? 0);
    return total > 0 ? useful / total : 0;
  }

  async getStagingMetrics(agentId: string): Promise<{ promoted: number; discarded: number; expired: number }> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT
         COUNT(CASE WHEN action = 'promoted' THEN 1 END) AS promoted,
         COUNT(CASE WHEN action = 'discarded' THEN 1 END) AS discarded,
         COUNT(CASE WHEN action = 'expired' THEN 1 END) AS expired
       FROM staging_events WHERE agent_id = $1`,
      [agentId],
    );
    const row = result.rows[0] ?? { promoted: 0, discarded: 0, expired: 0 };
    return {
      promoted: Number(row.promoted),
      discarded: Number(row.discarded),
      expired: Number(row.expired),
    };
  }

  async getActivationStats(agentId: string, windowHours: number = 24): Promise<{ count: number; avgLatencyMs: number; p95LatencyMs: number }> {
    await this.readyPromise;
    // Flush any buffered activation events so stats reflect the latest writes.
    await this.flushActivationEvents();
    const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const result = await this.db.query<any>(
      `SELECT latency_ms FROM activation_events
       WHERE agent_id = $1 AND timestamp > $2
       ORDER BY latency_ms ASC`,
      [agentId, since],
    );
    if (result.rows.length === 0) return { count: 0, avgLatencyMs: 0, p95LatencyMs: 0 };
    const latencies = result.rows.map((r) => Number(r.latency_ms));
    const total = latencies.reduce((s, l) => s + l, 0);
    const p95Idx = Math.min(Math.floor(latencies.length * 0.95), latencies.length - 1);
    return {
      count: latencies.length,
      avgLatencyMs: total / latencies.length,
      p95LatencyMs: latencies[p95Idx],
    };
  }

  async getConsolidatedCount(agentId: string): Promise<number> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT COUNT(*) AS cnt FROM engrams WHERE agent_id = $1 AND stage = 'consolidated'`,
      [agentId],
    );
    return Number(result.rows[0]?.cnt ?? 0);
  }

  // ============================================================
  // Episodes
  // ============================================================

  async createEpisode(input: { agentId: string; label: string; embedding?: number[] }): Promise<Episode> {
    await this.readyPromise;
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO episodes (id, agent_id, label, embedding, engram_count, start_time, end_time, created_at)
       VALUES ($1, $2, $3, $4::vector, 0, $5, $5, $5)`,
      [id, input.agentId, input.label, vectorToLiteral(input.embedding ?? null), now],
    );
    const ep = await this.getEpisode(id);
    if (!ep) throw new Error('createEpisode: row not found after insert');
    return ep;
  }

  async getEpisode(id: string): Promise<Episode | null> {
    await this.readyPromise;
    const result = await this.db.query<any>(`SELECT * FROM episodes WHERE id = $1`, [id]);
    return result.rows.length > 0 ? rowToEpisode(result.rows[0]) : null;
  }

  async getEpisodesByAgent(agentId: string): Promise<Episode[]> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM episodes WHERE agent_id = $1 ORDER BY end_time DESC`,
      [agentId],
    );
    return result.rows.map(rowToEpisode);
  }

  async getActiveEpisode(agentId: string, windowMs: number = 3600_000): Promise<Episode | null> {
    await this.readyPromise;
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const result = await this.db.query<any>(
      `SELECT * FROM episodes WHERE agent_id = $1 AND end_time > $2 ORDER BY end_time DESC LIMIT 1`,
      [agentId, cutoff],
    );
    return result.rows.length > 0 ? rowToEpisode(result.rows[0]) : null;
  }

  async addEngramToEpisode(engramId: string, episodeId: string): Promise<void> {
    await this.readyPromise;
    await this.db.query(`UPDATE engrams SET episode_id = $1 WHERE id = $2`, [episodeId, engramId]);
    await this.db.query(
      `UPDATE episodes SET
         engram_count = engram_count + 1,
         end_time = GREATEST(end_time, $1)
       WHERE id = $2`,
      [new Date().toISOString(), episodeId],
    );
  }

  async getEngramsByEpisode(episodeId: string): Promise<Engram[]> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM engrams WHERE episode_id = $1 AND retracted = FALSE ORDER BY created_at ASC`,
      [episodeId],
    );
    return result.rows.map(rowToEngram);
  }

  async updateEpisodeEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.readyPromise;
    await this.db.query(
      `UPDATE episodes SET embedding = $1::vector WHERE id = $2`,
      [vectorToLiteral(embedding), id],
    );
  }

  async getEpisodeCount(agentId: string): Promise<number> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT COUNT(*) AS cnt FROM episodes WHERE agent_id = $1`,
      [agentId],
    );
    return Number(result.rows[0]?.cnt ?? 0);
  }

  // ============================================================
  // Tags lookup
  // ============================================================

  async findEngramsByTags(agentId: string, tags: string[], excludeIds?: Set<string>): Promise<Engram[]> {
    if (tags.length === 0) return [];
    await this.readyPromise;
    const conditions = tags.map((_, i) => `tags LIKE $${i + 2}`).join(' OR ');
    const params: any[] = [agentId, ...tags.map(tagLike)];
    const sql = `SELECT * FROM engrams WHERE agent_id = $1 AND retracted = FALSE AND (${conditions})`;
    const result = await this.db.query<any>(sql, params);
    const engrams = result.rows.map(rowToEngram);
    if (excludeIds) return engrams.filter((e) => !excludeIds.has(e.id));
    return engrams;
  }

  // ============================================================
  // Checkpointing & conscious state
  // ============================================================

  async updateAutoCheckpointWrite(agentId: string, engramId: string): Promise<void> {
    await this.readyPromise;
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO conscious_state (agent_id, last_write_id, last_activity_at, write_count_since_consolidation, updated_at)
       VALUES ($1, $2, $3, 1, $3)
       ON CONFLICT(agent_id) DO UPDATE SET
         last_write_id = EXCLUDED.last_write_id,
         last_activity_at = EXCLUDED.last_activity_at,
         write_count_since_consolidation = conscious_state.write_count_since_consolidation + 1,
         updated_at = EXCLUDED.updated_at`,
      [agentId, engramId, now],
    );
  }

  async updateAutoCheckpointRecall(agentId: string, context: string, engramIds: string[]): Promise<void> {
    await this.readyPromise;
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO conscious_state (agent_id, last_recall_context, last_recall_ids, last_activity_at, recall_count_since_consolidation, updated_at)
       VALUES ($1, $2, $3, $4, 1, $4)
       ON CONFLICT(agent_id) DO UPDATE SET
         last_recall_context = EXCLUDED.last_recall_context,
         last_recall_ids = EXCLUDED.last_recall_ids,
         last_activity_at = EXCLUDED.last_activity_at,
         recall_count_since_consolidation = conscious_state.recall_count_since_consolidation + 1,
         updated_at = EXCLUDED.updated_at`,
      [agentId, context, JSON.stringify(engramIds), now],
    );
  }

  async touchActivity(agentId: string): Promise<void> {
    await this.readyPromise;
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO conscious_state (agent_id, last_activity_at, updated_at)
       VALUES ($1, $2, $2)
       ON CONFLICT(agent_id) DO UPDATE SET
         last_activity_at = EXCLUDED.last_activity_at,
         updated_at = EXCLUDED.updated_at`,
      [agentId, now],
    );
  }

  async saveCheckpoint(agentId: string, state: ConsciousState): Promise<void> {
    await this.readyPromise;
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO conscious_state (agent_id, execution_state, checkpoint_at, last_activity_at, updated_at)
       VALUES ($1, $2, $3, $3, $3)
       ON CONFLICT(agent_id) DO UPDATE SET
         execution_state = EXCLUDED.execution_state,
         checkpoint_at = EXCLUDED.checkpoint_at,
         last_activity_at = EXCLUDED.last_activity_at,
         updated_at = EXCLUDED.updated_at`,
      [agentId, JSON.stringify(state), now],
    );
  }

  async getCheckpoint(agentId: string): Promise<CheckpointRow | null> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT * FROM conscious_state WHERE agent_id = $1`,
      [agentId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
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
    } as CheckpointRow;
  }

  async markConsolidation(agentId: string, mini: boolean): Promise<void> {
    await this.readyPromise;
    const now = new Date().toISOString();
    if (mini) {
      await this.db.query(
        `UPDATE conscious_state SET last_mini_consolidation_at = $1, updated_at = $1 WHERE agent_id = $2`,
        [now, agentId],
      );
    } else {
      await this.db.query(
        `UPDATE conscious_state SET
           last_consolidation_at = $1,
           last_mini_consolidation_at = $1,
           write_count_since_consolidation = 0,
           recall_count_since_consolidation = 0,
           consolidation_cycle_count = consolidation_cycle_count + 1,
           updated_at = $1
         WHERE agent_id = $2`,
        [now, agentId],
      );
    }
  }

  async getActiveAgents(): Promise<Array<{ agentId: string; lastActivityAt: Date; writeCount: number; recallCount: number; lastConsolidationAt: Date | null }>> {
    await this.readyPromise;
    const result = await this.db.query<any>(`SELECT * FROM conscious_state`);
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      lastActivityAt: new Date(row.last_activity_at),
      writeCount: row.write_count_since_consolidation,
      recallCount: row.recall_count_since_consolidation,
      lastConsolidationAt: row.last_consolidation_at ? new Date(row.last_consolidation_at) : null,
    }));
  }

  async getConsolidationCycleCount(agentId: string): Promise<number> {
    await this.readyPromise;
    const result = await this.db.query<any>(
      `SELECT consolidation_cycle_count FROM conscious_state WHERE agent_id = $1`,
      [agentId],
    );
    return Number(result.rows[0]?.consolidation_cycle_count ?? 0);
  }

  // ============================================================
  // 0.8 Cluster C — substrate primitives
  // ============================================================

  async getLatestByTag(opts: {
    agentId: string;
    tagKeyPrefix: string;
    scopeTagsAll?: string[];
    retracted?: boolean;
    sortBy?: 'createdAt' | 'sequence';
    limit?: number;
  }): Promise<Engram[]> {
    await this.readyPromise;
    let sql = `SELECT * FROM engrams
               WHERE agent_id = $1
                 AND retracted = $2
                 AND stage = 'active'
                 AND tags LIKE $3`;
    const params: any[] = [opts.agentId, opts.retracted ?? false, `%"${opts.tagKeyPrefix}%`];
    if (opts.scopeTagsAll && opts.scopeTagsAll.length > 0) {
      for (const t of opts.scopeTagsAll) {
        sql += ` AND tags LIKE $${params.length + 1}`;
        params.push(tagLike(t));
      }
    }
    if (opts.sortBy === 'sequence') sql += ` AND sequence IS NOT NULL`;
    sql += ` ORDER BY ` + (opts.sortBy === 'sequence' ? 'sequence DESC, created_at DESC' : 'created_at DESC');
    const result = await this.db.query<any>(sql, params);
    const engrams = result.rows.map(rowToEngram);
    const seen = new Map<string, Engram>();
    for (const e of engrams) {
      const value = extractTagValue(e.tags, opts.tagKeyPrefix);
      if (value == null) continue;
      if (!seen.has(value)) seen.set(value, e);
    }
    const out = Array.from(seen.values());
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  async getTopBy(opts: {
    agentId: string;
    sortField: string;
    order: 'asc' | 'desc';
    filterTagsAll?: string[];
    filterTagsAny?: string[];
    filterTagsNone?: string[];
    limit?: number;
    retracted?: boolean;
  }): Promise<Engram[]> {
    await this.readyPromise;
    let sql = `SELECT * FROM engrams
               WHERE agent_id = $1
                 AND retracted = $2
                 AND stage = 'active'
                 AND tags LIKE $3`;
    const params: any[] = [opts.agentId, opts.retracted ?? false, `%"${opts.sortField}%`];
    if (opts.filterTagsAll && opts.filterTagsAll.length > 0) {
      for (const tag of opts.filterTagsAll) {
        sql += ` AND tags LIKE $${params.length + 1}`;
        params.push(tagLike(tag));
      }
    }
    if (opts.filterTagsAny && opts.filterTagsAny.length > 0) {
      const ors = opts.filterTagsAny.map((_, i) => `tags LIKE $${params.length + 1 + i}`).join(' OR ');
      sql += ` AND (${ors})`;
      for (const tag of opts.filterTagsAny) params.push(tagLike(tag));
    }
    if (opts.filterTagsNone && opts.filterTagsNone.length > 0) {
      const ors = opts.filterTagsNone.map((_, i) => `tags LIKE $${params.length + 1 + i}`).join(' OR ');
      sql += ` AND NOT (${ors})`;
      for (const tag of opts.filterTagsNone) params.push(tagLike(tag));
    }
    const result = await this.db.query<any>(sql, params);
    const engrams = result.rows.map(rowToEngram);
    const valued = engrams.map((e) => {
      const raw = extractTagValue(e.tags, opts.sortField);
      const n = raw == null ? NaN : Number(raw);
      return { e, n };
    });
    valued.sort((a, b) => {
      const aNaN = Number.isNaN(a.n);
      const bNaN = Number.isNaN(b.n);
      if (aNaN && bNaN) return 0;
      if (aNaN) return 1;
      if (bNaN) return -1;
      return opts.order === 'asc' ? a.n - b.n : b.n - a.n;
    });
    const sorted = valued.map((v) => v.e);
    return opts.limit ? sorted.slice(0, opts.limit) : sorted;
  }

  /**
   * Atomically allocate the next sequence number for an agent.
   *
   * Uses PGlite's transaction API — the callback receives a `tx` context
   * that must be used for queries; calling `this.db.query` from inside
   * the callback bypasses the transaction and deadlocks the connection.
   */
  async allocateNextSequence(agentId: string): Promise<number> {
    await this.readyPromise;
    return this.db.transaction(async (tx: any) => {
      const result = await tx.query(
        `SELECT MAX(sequence) AS max_seq FROM engrams WHERE agent_id = $1`,
        [agentId],
      );
      const max = result.rows[0]?.max_seq;
      return (max != null ? Number(max) : 0) + 1;
    }) as Promise<number>;
  }
}

export const PGLITE_DIMENSIONS = PGLITE_VECTOR_DIMENSIONS;
