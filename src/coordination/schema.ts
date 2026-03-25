// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * SQL table definitions for the coordination module.
 * Tables are created conditionally when AWM_COORDINATION=true.
 * Uses the same memory.db — coordination events feed the activation engine.
 */

import type Database from 'better-sqlite3';

const COORDINATION_TABLES = `
-- Coordination: agents in the hive
CREATE TABLE IF NOT EXISTS coord_agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'worker',
  status       TEXT NOT NULL DEFAULT 'idle',
  pid          INTEGER,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  current_task TEXT,
  metadata     TEXT,
  capabilities TEXT,
  workspace    TEXT
);

-- Prevent duplicate agent registrations for the same name+workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_coord_agents_name_workspace
  ON coord_agents (name, COALESCE(workspace, ''));

-- Coordination: assignments
CREATE TABLE IF NOT EXISTS coord_assignments (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT,
  task         TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  completed_at TEXT,
  result       TEXT,
  workspace    TEXT,
  FOREIGN KEY (agent_id) REFERENCES coord_agents(id)
);

-- Coordination: file locks
CREATE TABLE IF NOT EXISTS coord_locks (
  file_path    TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  locked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reason       TEXT,
  FOREIGN KEY (agent_id) REFERENCES coord_agents(id)
);

-- Coordination: orchestrator broadcast commands
CREATE TABLE IF NOT EXISTS coord_commands (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  command      TEXT NOT NULL,
  reason       TEXT,
  issued_by    TEXT,
  issued_at    TEXT NOT NULL DEFAULT (datetime('now')),
  cleared_at   TEXT,
  workspace    TEXT
);

-- Coordination: findings reported by agents
CREATE TABLE IF NOT EXISTS coord_findings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  category     TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info',
  file_path    TEXT,
  line_number  INTEGER,
  description  TEXT NOT NULL,
  suggestion   TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT,
  FOREIGN KEY (agent_id) REFERENCES coord_agents(id)
);

-- Coordination: cross-agent decision propagation
CREATE TABLE IF NOT EXISTS coord_decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id      TEXT NOT NULL,
  assignment_id  TEXT,
  tags           TEXT,
  summary        TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (author_id) REFERENCES coord_agents(id)
);
CREATE INDEX IF NOT EXISTS idx_coord_decisions_assignment
  ON coord_decisions (assignment_id, created_at);

-- Coordination: event audit trail
CREATE TABLE IF NOT EXISTS coord_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT,
  event_type   TEXT NOT NULL,
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Create all coordination tables in the given database.
 * Safe to call multiple times (CREATE IF NOT EXISTS).
 */
export function initCoordinationTables(db: Database.Database): void {
  db.exec(COORDINATION_TABLES);
}
