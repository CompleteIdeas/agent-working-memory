// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * PGlite schema DDL — translated from the SQLite schema in sqlite.ts:init().
 *
 * Translation notes:
 *   - SQLite TEXT → Postgres TEXT
 *   - SQLite REAL → Postgres DOUBLE PRECISION
 *   - SQLite INTEGER (0/1 booleans) → Postgres BOOLEAN
 *   - SQLite BLOB embedding → pgvector VECTOR(384) (native)
 *   - SQLite FTS5 virtual table + triggers → Postgres tsvector column with
 *     a GIN index, kept up-to-date via a BEFORE INSERT/UPDATE trigger.
 *
 * All tables and indexes use IF NOT EXISTS so re-running is idempotent.
 *
 * The vector extension MUST be loaded before this schema runs:
 *   await db.exec('CREATE EXTENSION IF NOT EXISTS vector')
 * PGlite's vector extension does this automatically when imported.
 */

export const PGLITE_VECTOR_DIMENSIONS = parseInt(process.env.AWM_EMBED_DIMS ?? '384', 10);

export const PGLITE_SCHEMA_DDL = `
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS engrams (
    id                   TEXT PRIMARY KEY,
    agent_id             TEXT NOT NULL,
    concept              TEXT NOT NULL,
    content              TEXT NOT NULL,
    embedding            VECTOR(${PGLITE_VECTOR_DIMENSIONS}),
    embedding_model      TEXT,
    confidence           DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    salience             DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    access_count         INTEGER NOT NULL DEFAULT 0,
    last_accessed        TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    salience_features    TEXT NOT NULL DEFAULT '{}',
    reason_codes         TEXT NOT NULL DEFAULT '[]',
    stage                TEXT NOT NULL DEFAULT 'active',
    ttl                  INTEGER,
    retracted            BOOLEAN NOT NULL DEFAULT FALSE,
    retracted_by         TEXT,
    retracted_at         TEXT,
    tags                 TEXT NOT NULL DEFAULT '[]',
    memory_type          TEXT NOT NULL DEFAULT 'unclassified',
    memory_class         TEXT NOT NULL DEFAULT 'working',
    superseded_by        TEXT,
    supersedes           TEXT,
    episode_id           TEXT,
    task_status          TEXT,
    task_priority        TEXT,
    blocked_by           TEXT,
    sequence             INTEGER,
    references_json      TEXT,
    fts                  TSVECTOR
  );

  CREATE INDEX IF NOT EXISTS idx_engrams_agent           ON engrams(agent_id);
  CREATE INDEX IF NOT EXISTS idx_engrams_stage           ON engrams(agent_id, stage);
  CREATE INDEX IF NOT EXISTS idx_engrams_concept         ON engrams(concept);
  CREATE INDEX IF NOT EXISTS idx_engrams_retracted       ON engrams(agent_id, retracted);
  CREATE INDEX IF NOT EXISTS idx_engrams_task            ON engrams(agent_id, task_status);
  CREATE INDEX IF NOT EXISTS idx_engrams_agent_sequence  ON engrams(agent_id, sequence) WHERE sequence IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_engrams_fts             ON engrams USING GIN(fts);

  CREATE INDEX IF NOT EXISTS idx_engrams_embedding
    ON engrams USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

  CREATE OR REPLACE FUNCTION engrams_fts_update() RETURNS TRIGGER AS $$
  BEGIN
    NEW.fts := to_tsvector('english',
      COALESCE(NEW.concept, '') || ' ' ||
      COALESCE(NEW.content, '') || ' ' ||
      COALESCE(NEW.tags, ''));
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS engrams_fts_trigger ON engrams;
  CREATE TRIGGER engrams_fts_trigger
    BEFORE INSERT OR UPDATE OF concept, content, tags ON engrams
    FOR EACH ROW EXECUTE FUNCTION engrams_fts_update();

  CREATE TABLE IF NOT EXISTS associations (
    id                TEXT PRIMARY KEY,
    from_engram_id    TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    to_engram_id      TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    weight            DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    confidence        DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    type              TEXT NOT NULL DEFAULT 'hebbian',
    activation_count  INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    last_activated    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_assoc_from        ON associations(from_engram_id);
  CREATE INDEX IF NOT EXISTS idx_assoc_to          ON associations(to_engram_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_assoc_pair ON associations(from_engram_id, to_engram_id);

  CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    config      TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS activation_events (
    id                 TEXT PRIMARY KEY,
    agent_id           TEXT NOT NULL,
    timestamp          TEXT NOT NULL,
    context            TEXT NOT NULL,
    results_returned   INTEGER NOT NULL,
    top_score          DOUBLE PRECISION,
    latency_ms         DOUBLE PRECISION NOT NULL,
    engram_ids         TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS staging_events (
    engram_id        TEXT NOT NULL,
    agent_id         TEXT NOT NULL,
    action           TEXT NOT NULL,
    resonance_score  DOUBLE PRECISION,
    timestamp        TEXT NOT NULL,
    age_ms           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS retrieval_feedback (
    id                   TEXT PRIMARY KEY,
    activation_event_id  TEXT,
    engram_id            TEXT NOT NULL,
    useful               BOOLEAN NOT NULL,
    context              TEXT,
    timestamp            TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id             TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    label          TEXT NOT NULL,
    embedding      VECTOR(${PGLITE_VECTOR_DIMENSIONS}),
    engram_count   INTEGER NOT NULL DEFAULT 0,
    start_time     TEXT NOT NULL,
    end_time       TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent_id);
  CREATE INDEX IF NOT EXISTS idx_episodes_time  ON episodes(agent_id, end_time);

  CREATE TABLE IF NOT EXISTS conscious_state (
    agent_id                            TEXT PRIMARY KEY,
    last_write_id                       TEXT,
    last_recall_context                 TEXT,
    last_recall_ids                     TEXT NOT NULL DEFAULT '[]',
    last_activity_at                    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    write_count_since_consolidation     INTEGER NOT NULL DEFAULT 0,
    recall_count_since_consolidation    INTEGER NOT NULL DEFAULT 0,
    execution_state                     TEXT,
    checkpoint_at                       TEXT,
    last_consolidation_at               TEXT,
    last_mini_consolidation_at          TEXT,
    consolidation_cycle_count           INTEGER NOT NULL DEFAULT 0,
    updated_at                          TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  );
`;
