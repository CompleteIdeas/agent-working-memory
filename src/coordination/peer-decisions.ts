// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Peer-decision injection for memory_recall.
 *
 * When coordination is enabled, memory_recall appends recent decisions
 * made by OTHER agents that are relevant to the current recall query.
 * This enables passive cross-agent knowledge sharing without explicit
 * communication.
 */

import type Database from 'better-sqlite3';

export interface PeerDecision {
  id: number;
  author_name: string;
  assignment_id: string | null;
  tags: string | null;
  summary: string;
  created_at: string;
}

/** Stop words filtered out before keyword matching. */
const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'been', 'will', 'when', 'what',
  'which', 'then', 'than', 'into', 'over', 'after', 'some', 'more', 'also',
  'most', 'other', 'each', 'such', 'only', 'just', 'about', 'there', 'their',
  'where', 'would', 'could', 'should', 'these', 'those', 'make', 'made',
  'using', 'used', 'call', 'calls', 'does', 'done', 'were', 'they',
]);

/**
 * Extract significant keywords from a recall query for relevance matching.
 * Returns up to maxKeywords words of length >= 4 that are not stop words.
 */
export function extractKeywords(query: string, maxKeywords = 8): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, maxKeywords);
}

/**
 * Query coord_decisions for recent decisions by agents OTHER than the current one
 * that are relevant to the given query string.
 *
 * @param db         The shared coordination database handle.
 * @param selfName   The current agent's name (AWM_AGENT_ID / WORKER_NAME). Excluded from results.
 * @param query      The recall query text used for keyword relevance matching.
 * @param windowHours  How far back to look (default 1 hour).
 * @param limit      Maximum number of decisions to return (default 5).
 * @returns Array of peer decisions, ordered newest-first. Empty array on any error.
 */
export function queryPeerDecisions(
  db: Database.Database,
  selfName: string,
  query: string,
  windowHours = 1,
  limit = 5,
): PeerDecision[] {
  try {
    const safeHours = Math.max(0.1, Math.min(windowHours, 168)); // 6min – 1 week
    const safeLimit = Math.max(1, Math.min(limit, 50));
    const keywords = extractKeywords(query);

    const baseWhere = `
      d.created_at >= datetime('now', '-${safeHours} hours')
      AND a.name != ?
    `;

    const select = `
      SELECT d.id, a.name AS author_name, d.assignment_id, d.tags, d.summary, d.created_at
      FROM coord_decisions d
      JOIN coord_agents a ON d.author_id = a.id
    `;

    if (keywords.length === 0) {
      // No useful keywords — return the N most recent decisions from other agents
      const sql = `${select} WHERE ${baseWhere} ORDER BY d.created_at DESC LIMIT ?`;
      return db.prepare(sql).all(selfName, safeLimit) as PeerDecision[];
    }

    // Build keyword filter: match any keyword in summary or tags
    const kwClauses = keywords.map(() => `(d.summary LIKE ? OR d.tags LIKE ?)`).join(' OR ');
    const sql = `${select} WHERE ${baseWhere} AND (${kwClauses}) ORDER BY d.created_at DESC LIMIT ?`;
    const kwParams = keywords.flatMap(kw => [`%${kw}%`, `%${kw}%`]);

    return db.prepare(sql).all(selfName, ...kwParams, safeLimit) as PeerDecision[];
  } catch {
    return []; // non-fatal — peer decisions are best-effort
  }
}

/**
 * Format peer decisions as a text section to append to memory_recall output.
 * Returns an empty string when there are no peer decisions.
 */
export function formatPeerDecisions(decisions: PeerDecision[], windowHours = 1): string {
  if (decisions.length === 0) return '';
  const label = windowHours === 1 ? '1h' : `${windowHours}h`;
  const lines = decisions.map(d => `[${d.author_name}] ${d.summary}`);
  return `\n--- Peer Decisions (last ${label}) ---\n${lines.join('\n')}`;
}
