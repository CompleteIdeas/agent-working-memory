// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP routes for the coordination module.
 * Ported from AgentSynapse packages/coordinator/src/routes/*.ts into a single file.
 * All tables use coord_ prefix to avoid collision with AWM core tables.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { EngramStore } from '../storage/sqlite.js';
import { randomUUID } from 'node:crypto';
import {
  checkinSchema, checkoutSchema, pulseSchema, nextSchema,
  assignCreateSchema, assignmentQuerySchema, assignmentClaimSchema, assignmentUpdateSchema, assignmentIdParamSchema, assignmentsListSchema, reassignSchema,
  lockAcquireSchema, lockReleaseSchema,
  commandCreateSchema, commandWaitQuerySchema,
  findingCreateSchema, findingsQuerySchema, findingIdParamSchema, findingUpdateSchema,
  decisionsQuerySchema, decisionCreateSchema,
  eventsQuerySchema, staleQuerySchema, workersQuerySchema,
  agentIdParamSchema,
} from './schemas.js';
import { detectStale, cleanupStale } from './stale.js';

/** Pretty timestamp for coordination logs. */
function ts(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

/** Log a coordination event in human-readable format. */
function coordLog(msg: string): void {
  console.log(`${ts()} [coord] ${msg}`);
}

export function registerCoordinationRoutes(app: FastifyInstance, db: Database.Database, store?: EngramStore): void {

  // Log errors and non-200 responses
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 400) {
      coordLog(`${request.method} ${request.url} → ${reply.statusCode}`);
    }
  });

  // ─── Checkin ────────────────────────────────────────────────────

  app.post('/checkin', async (req, reply) => {
    const parsed = checkinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { name, role, pid, metadata, capabilities, workspace } = parsed.data;
    const capsJson = capabilities ? JSON.stringify(capabilities) : null;

    // Look up ANY existing agent with same name+workspace — including dead ones (upsert)
    // Falls back to name-only to handle workspace changes between sessions
    let existing = workspace
      ? db.prepare(
          `SELECT id, status FROM coord_agents WHERE name = ? AND workspace = ? ORDER BY last_seen DESC LIMIT 1`
        ).get(name, workspace) as { id: string; status: string } | undefined
      : db.prepare(
          `SELECT id, status FROM coord_agents WHERE name = ? AND workspace IS NULL ORDER BY last_seen DESC LIMIT 1`
        ).get(name) as { id: string; status: string } | undefined;

    if (!existing) {
      existing = db.prepare(
        `SELECT id, status FROM coord_agents WHERE name = ? ORDER BY last_seen DESC LIMIT 1`
      ).get(name) as { id: string; status: string } | undefined;
    }

    if (existing) {
      const wasDead = existing.status === 'dead';
      db.prepare(
        `UPDATE coord_agents SET last_seen = datetime('now'), status = CASE WHEN status = 'dead' THEN 'idle' ELSE status END, pid = COALESCE(?, pid), capabilities = COALESCE(?, capabilities), workspace = COALESCE(?, workspace) WHERE id = ?`
      ).run(pid ?? null, capsJson, workspace ?? null, existing.id);

      const eventType = wasDead ? 'reconnected' : 'heartbeat';
      const detail = wasDead ? `${name} reconnected (was dead)` : `heartbeat from ${name}`;
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, ?, ?)`
      ).run(existing.id, eventType, detail);

      if (wasDead) coordLog(`${name} reconnected (reusing UUID ${existing.id.slice(0, 8)})`);
      const action = wasDead ? 'reconnected' : 'heartbeat';
      const status = wasDead ? 'idle' : existing.status;
      return reply.send({ agentId: existing.id, action, status, workspace });
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO coord_agents (id, name, role, pid, status, metadata, capabilities, workspace) VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)`
    ).run(id, name, role ?? 'worker', pid ?? null, metadata ? JSON.stringify(metadata) : null, capsJson, workspace ?? null);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'registered', ?)`
    ).run(id, `${name} joined as ${role ?? 'worker'}${workspace ? ' [' + workspace + ']' : ''}${capabilities ? ' [' + capabilities.join(', ') + ']' : ''}`);

    coordLog(`${name} registered (${role ?? 'worker'})${capabilities ? ' [' + capabilities.join(', ') + ']' : ''}`);
    return reply.code(201).send({ agentId: id, action: 'registered', status: 'idle', workspace });
  });

  app.post('/checkout', async (req, reply) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId } = parsed.data;

    db.prepare(`DELETE FROM coord_locks WHERE agent_id = ?`).run(agentId);
    db.prepare(
      `UPDATE coord_agents SET status = 'dead', last_seen = datetime('now') WHERE id = ?`
    ).run(agentId);
    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'checkout', 'agent signed off')`
    ).run(agentId);

    // Look up agent name for logging
    const agent = db.prepare(`SELECT name FROM coord_agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
    coordLog(`${agent?.name ?? agentId} checked out`);
    return reply.send({ ok: true });
  });

  // ─── Pulse (lightweight heartbeat — no event row) ──────────────

  app.patch('/pulse', async (req, reply) => {
    const parsed = pulseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId } = parsed.data;

    db.prepare(`UPDATE coord_agents SET last_seen = datetime('now') WHERE id = ?`).run(agentId);
    return reply.send({ ok: true });
  });

  // ─── Next (combined checkin + commands + assignment poll) ───────

  app.post('/next', async (req, reply) => {
    const parsed = nextSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { name, workspace, role, capabilities } = parsed.data;
    const capsJson = capabilities ? JSON.stringify(capabilities) : null;

    // Step 1: Upsert agent (checkin / heartbeat) — including dead agents (reuse UUID)
    // Try exact name+workspace match first, then fall back to name-only to handle
    // workspace changes between sessions (prevents orphaned assignments on old UUID)
    let existing = workspace
      ? db.prepare(
          `SELECT id, status FROM coord_agents WHERE name = ? AND workspace = ? ORDER BY last_seen DESC LIMIT 1`
        ).get(name, workspace) as { id: string; status: string } | undefined
      : db.prepare(
          `SELECT id, status FROM coord_agents WHERE name = ? AND workspace IS NULL ORDER BY last_seen DESC LIMIT 1`
        ).get(name) as { id: string; status: string } | undefined;

    // Fallback: name-only lookup if exact match failed (handles workspace change, e.g. NULL→PERSONAL)
    if (!existing) {
      existing = db.prepare(
        `SELECT id, status FROM coord_agents WHERE name = ? ORDER BY last_seen DESC LIMIT 1`
      ).get(name) as { id: string; status: string } | undefined;
    }

    let agentId: string;
    if (existing) {
      agentId = existing.id;
      const wasDead = existing.status === 'dead';
      db.prepare(
        `UPDATE coord_agents SET last_seen = datetime('now'), status = CASE WHEN status = 'dead' THEN 'idle' ELSE status END, capabilities = COALESCE(?, capabilities), workspace = COALESCE(?, workspace) WHERE id = ?`
      ).run(capsJson, workspace ?? null, agentId);
      const eventType = wasDead ? 'reconnected' : 'heartbeat';
      const detail = wasDead ? `${name} reconnected via /next` : `heartbeat from ${name}`;
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, ?, ?)`
      ).run(agentId, eventType, detail);
      if (wasDead) coordLog(`${name} reconnected via /next (reusing UUID ${agentId.slice(0, 8)})`);
    } else {
      agentId = randomUUID();
      db.prepare(
        `INSERT INTO coord_agents (id, name, role, pid, status, metadata, capabilities, workspace) VALUES (?, ?, ?, NULL, 'idle', NULL, ?, ?)`
      ).run(agentId, name, role ?? 'worker', capsJson, workspace ?? null);
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'registered', ?)`
      ).run(agentId, `${name} joined as ${role ?? 'worker'} via /next`);
      coordLog(`${name} registered via /next (${role ?? 'worker'})${capabilities ? ' [' + capabilities.join(', ') + ']' : ''}`);
    }

    // Step 2: Get active commands
    const activeCommands = workspace
      ? db.prepare(
          `SELECT id, command, reason, issued_by, issued_at, workspace
           FROM coord_commands WHERE cleared_at IS NULL AND (workspace = ? OR workspace IS NULL)
           ORDER BY issued_at DESC`
        ).all(workspace) as Array<{ id: number; command: string; reason: string; issued_by: string; issued_at: string; workspace: string | null }>
      : db.prepare(
          `SELECT id, command, reason, issued_by, issued_at, workspace
           FROM coord_commands WHERE cleared_at IS NULL
           ORDER BY issued_at DESC`
        ).all() as Array<{ id: number; command: string; reason: string; issued_by: string; issued_at: string; workspace: string | null }>;

    // Step 3: Get or auto-claim assignment
    let assignment = db.prepare(
      `SELECT * FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at DESC LIMIT 1`
    ).get(agentId) as Record<string, unknown> | undefined;

    if (!assignment) {
      const agentWorkspace = workspace ?? null;
      // Priority-ordered dispatch: higher priority first, then FIFO.
      // Skip assignments blocked by incomplete dependencies.
      const blockedFilter = `AND (blocked_by IS NULL OR blocked_by IN (SELECT id FROM coord_assignments WHERE status = 'completed'))`;

      // First, check for tasks reserved specifically for this agent
      const reserved = db.prepare(
        `SELECT * FROM coord_assignments WHERE status = 'pending' AND agent_id = ? ${blockedFilter} ORDER BY priority DESC, created_at ASC LIMIT 1`
      ).get(agentId) as { id: string } | undefined;

      // Then fall back to truly unassigned tasks (agent_id IS NULL)
      const pending = reserved ?? (agentWorkspace
        ? db.prepare(
            `SELECT * FROM coord_assignments WHERE status = 'pending' AND agent_id IS NULL AND (workspace = ? OR workspace IS NULL) ${blockedFilter} ORDER BY priority DESC, created_at ASC LIMIT 1`
          ).get(agentWorkspace) as { id: string } | undefined
        : db.prepare(
            `SELECT * FROM coord_assignments WHERE status = 'pending' AND agent_id IS NULL ${blockedFilter} ORDER BY priority DESC, created_at ASC LIMIT 1`
          ).get() as { id: string } | undefined);

      if (pending) {
        const claimed = db.prepare(
          `UPDATE coord_assignments SET agent_id = ?, status = 'assigned', started_at = datetime('now') WHERE id = ? AND status = 'pending'`
        ).run(agentId, pending.id);

        if (claimed.changes > 0) {
          db.prepare(
            `UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`
          ).run(pending.id, agentId);
          db.prepare(
            `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_claimed', ?)`
          ).run(agentId, `auto-claimed assignment ${pending.id} via /next`);
          assignment = db.prepare(`SELECT * FROM coord_assignments WHERE id = ?`).get(pending.id) as Record<string, unknown> | undefined;
        }
      }
    }

    // Read current agent status after all mutations
    const agentRow = db.prepare(`SELECT status FROM coord_agents WHERE id = ?`).get(agentId) as { status: string };

    return reply.send({
      agentId,
      status: agentRow.status,
      assignment: assignment ?? null,
      commands: activeCommands,
    });
  });

  // ─── Assignments ────────────────────────────────────────────────

  app.post('/assign', async (req, reply) => {
    const parsed = assignCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { task, description, workspace, priority, blocked_by, worker_name, context } = parsed.data;
    let { agentId } = parsed.data;

    // Resolve worker_name → agentId if agentId not provided
    if (!agentId && worker_name) {
      let found = workspace
        ? db.prepare(
            `SELECT id FROM coord_agents WHERE name = ? AND workspace = ? AND status != 'dead' ORDER BY last_seen DESC LIMIT 1`
          ).get(worker_name, workspace) as { id: string } | undefined
        : db.prepare(
            `SELECT id FROM coord_agents WHERE name = ? AND workspace IS NULL AND status != 'dead' ORDER BY last_seen DESC LIMIT 1`
          ).get(worker_name) as { id: string } | undefined;

      // Fallback: name-only lookup (handles workspace changes)
      if (!found) {
        found = db.prepare(
          `SELECT id FROM coord_agents WHERE name = ? AND status != 'dead' ORDER BY last_seen DESC LIMIT 1`
        ).get(worker_name) as { id: string } | undefined;
      }

      if (!found) {
        return reply.code(404).send({ error: `worker not found: ${worker_name}` });
      }
      agentId = found.id;
    }

    // Reject if agent already has an active assignment
    if (agentId) {
      const active = db.prepare(
        `SELECT id, task FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress') LIMIT 1`
      ).get(agentId) as { id: string; task: string } | undefined;
      if (active) {
        return reply.code(409).send({ error: `agent already has active assignment: ${active.id}`, active_task: active.task });
      }
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO coord_assignments (id, agent_id, task, description, status, priority, blocked_by, workspace, started_at, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, agentId ?? null, task, description ?? null, agentId ? 'assigned' : 'pending', priority, blocked_by ?? null, workspace ?? null, agentId ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null, context ?? null);

    if (agentId) {
      db.prepare(
        `UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`
      ).run(id, agentId);
    }

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_created', ?)`
    ).run(agentId ?? null, `task: ${task}`);

    // Bridge context to AWM engrams for cross-agent recall
    if (store && context) {
      try {
        const ctx = JSON.parse(context) as Record<string, unknown>;
        const parts: string[] = [];
        if (ctx.files) parts.push(`Files: ${JSON.stringify(ctx.files)}`);
        if (ctx.references) parts.push(`References: ${JSON.stringify(ctx.references)}`);
        if (ctx.decisions) parts.push(`Decisions: ${JSON.stringify(ctx.decisions)}`);
        if (ctx.acceptance_criteria) parts.push(`Acceptance criteria: ${JSON.stringify(ctx.acceptance_criteria)}`);
        // Include any remaining keys
        for (const [k, v] of Object.entries(ctx)) {
          if (!['files', 'references', 'decisions', 'acceptance_criteria'].includes(k) && v) {
            parts.push(`${k}: ${JSON.stringify(v)}`);
          }
        }
        if (parts.length > 0) {
          store.createEngram({
            agentId: agentId ?? 'coordinator',
            concept: `Task context: ${task.slice(0, 80)}`,
            content: parts.join('\n'),
            tags: ['shared', 'context', `task/${id}`],
            memoryClass: 'canonical',
          });
        }
      } catch {
        // Context is not valid JSON — skip engram bridge silently
      }
    }

    // Log assignment with agent name
    if (agentId) {
      const agent = db.prepare(`SELECT name FROM coord_agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
      coordLog(`assigned → ${agent?.name ?? 'unknown'}: ${task.slice(0, 80)}`);
    } else {
      coordLog(`assignment queued (pending): ${task.slice(0, 80)}`);
    }
    return reply.code(201).send({ assignmentId: id, status: agentId ? 'assigned' : 'pending' });
  });

  app.get('/assignment', async (req, reply) => {
    const q = assignmentQuerySchema.parse(req.query);
    let agentId = (req.headers['x-agent-id'] as string | undefined) ?? q.agentId;

    // Fallback: resolve agentId from name + workspace (with name-only fallback)
    if (!agentId && q.name) {
      let found = q.workspace
        ? db.prepare(
            `SELECT id FROM coord_agents WHERE name = ? AND workspace = ? AND status != 'dead'`
          ).get(q.name, q.workspace) as { id: string } | undefined
        : db.prepare(
            `SELECT id FROM coord_agents WHERE name = ? AND workspace IS NULL AND status != 'dead'`
          ).get(q.name) as { id: string } | undefined;
      if (!found) {
        found = db.prepare(
          `SELECT id FROM coord_agents WHERE name = ? AND status != 'dead' ORDER BY last_seen DESC LIMIT 1`
        ).get(q.name) as { id: string } | undefined;
      }
      agentId = found?.id;
    }

    if (!agentId) {
      return reply.send({ assignment: null });
    }

    const active = db.prepare(
      `SELECT * FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at DESC LIMIT 1`
    ).get(agentId);

    if (active) return reply.send({ assignment: active });

    const agentRow = db.prepare(`SELECT workspace FROM coord_agents WHERE id = ?`).get(agentId) as { workspace: string | null } | undefined;
    const agentWorkspace = agentRow?.workspace;

    const blockedFilter = `AND (blocked_by IS NULL OR blocked_by IN (SELECT id FROM coord_assignments WHERE status = 'completed'))`;

    // First, check for tasks reserved specifically for this agent
    const reserved = db.prepare(
      `SELECT * FROM coord_assignments WHERE status = 'pending' AND agent_id = ? ${blockedFilter} ORDER BY priority DESC, created_at ASC LIMIT 1`
    ).get(agentId) as { id: string } | undefined;

    // Then fall back to truly unassigned tasks (agent_id IS NULL)
    const pending = reserved ?? (agentWorkspace
      ? db.prepare(
          `SELECT * FROM coord_assignments WHERE status = 'pending' AND agent_id IS NULL AND (workspace = ? OR workspace IS NULL) ${blockedFilter} ORDER BY priority DESC, created_at ASC LIMIT 1`
        ).get(agentWorkspace) as { id: string } | undefined
      : db.prepare(
          `SELECT * FROM coord_assignments WHERE status = 'pending' AND agent_id IS NULL ${blockedFilter} ORDER BY priority DESC, created_at ASC LIMIT 1`
        ).get() as { id: string } | undefined);

    if (pending) {
      const claimed = db.prepare(
        `UPDATE coord_assignments SET agent_id = ?, status = 'assigned', started_at = datetime('now') WHERE id = ? AND status = 'pending'`
      ).run(agentId, pending.id);

      if (claimed.changes > 0) {
        db.prepare(
          `UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`
        ).run(pending.id, agentId);

        db.prepare(
          `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_claimed', ?)`
        ).run(agentId, `auto-claimed assignment ${pending.id}`);

        const assignment = db.prepare(`SELECT * FROM coord_assignments WHERE id = ?`).get(pending.id);
        return reply.send({ assignment });
      }
    }

    const busyCount = (db.prepare(
      `SELECT COUNT(*) as c FROM coord_agents WHERE status = 'working' AND last_seen > datetime('now', '-120 seconds')`
    ).get() as { c: number }).c;

    const retryAfter = busyCount > 0 ? 30 : 300;
    return reply.send({ assignment: null, retry_after_seconds: retryAfter });
  });

  app.post('/assignment/:id/claim', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const parsed = assignmentClaimSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId } = parsed.data;

    const result = db.prepare(
      `UPDATE coord_assignments SET agent_id = ?, status = 'assigned', started_at = datetime('now') WHERE id = ? AND status = 'pending'`
    ).run(agentId, id);

    if (result.changes === 0) {
      return reply.code(409).send({ error: 'assignment not available (already claimed or missing)' });
    }

    db.prepare(
      `UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`
    ).run(id, agentId);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_claimed', ?)`
    ).run(agentId, `claimed assignment ${id}`);

    return reply.send({ ok: true, assignmentId: id });
  });

  function handleAssignmentUpdate(id: string, status: string, result: string | undefined, commitSha: string | undefined): { error?: string } {
    // Verification gate: completed status requires structured proof of work
    if (status === 'completed') {
      if (!result || result.trim().length < 20) {
        return { error: 'completion requires a result summary — minimum 20 characters describing what was done' };
      }
      // Must mention at least one of: commit/SHA, build, audit, test, verified, fix, created, updated, implemented
      const actionWords = /\b(committed?|sha|[0-9a-f]{7,40}|builds?|audite?d?|teste?d?|verified|fixe?d?|created?|updated?|implemented?|added|refactored?|documented?|resolved|merged|deployed|removed|migrated|wrote|reviewed)\b/i;
      if (!actionWords.test(result)) {
        return { error: 'completion result must describe the work done — include what was committed, built, tested, or verified' };
      }
    }

    if (['completed', 'failed'].includes(status)) {
      db.prepare(
        `UPDATE coord_assignments SET status = ?, result = ?, commit_sha = ?, completed_at = datetime('now') WHERE id = ?`
      ).run(status, result ?? null, commitSha ?? null, id);
    } else {
      db.prepare(
        `UPDATE coord_assignments SET status = ?, result = ? WHERE id = ?`
      ).run(status, result ?? null, id);
    }

    if (['completed', 'failed'].includes(status)) {
      const assignment = db.prepare(`SELECT agent_id FROM coord_assignments WHERE id = ?`).get(id) as { agent_id: string } | undefined;
      if (assignment?.agent_id) {
        db.prepare(
          `UPDATE coord_agents SET status = 'idle', current_task = NULL WHERE id = ?`
        ).run(assignment.agent_id);
      }
    }

    const eventDetail = ['completed', 'failed'].includes(status)
      ? `${id} → ${status}${commitSha ? ' [' + commitSha + ']' : ''}: ${(result ?? '').slice(0, 300)}`
      : `${id} → ${status}`;
    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES ((SELECT agent_id FROM coord_assignments WHERE id = ?), 'assignment_update', ?)`
    ).run(id, eventDetail);

    // Log completion/failure with agent name and task
    if (['completed', 'failed'].includes(status)) {
      const info = db.prepare(
        `SELECT a.task, g.name AS agent_name FROM coord_assignments a LEFT JOIN coord_agents g ON a.agent_id = g.id WHERE a.id = ?`
      ).get(id) as { task: string; agent_name: string | null } | undefined;
      coordLog(`${info?.agent_name ?? 'unknown'} ${status}: ${info?.task?.slice(0, 80) ?? id}`);
    }

    return {};
  }

  app.get('/assignment/:id', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const assignment = db.prepare(
      `SELECT a.*, g.name AS agent_name FROM coord_assignments a LEFT JOIN coord_agents g ON a.agent_id = g.id WHERE a.id = ?`
    ).get(id);
    if (!assignment) return reply.code(404).send({ error: 'assignment not found' });
    return reply.send({ assignment });
  });

  // List assignments with optional filters and pagination
  app.get('/assignments', async (req, reply) => {
    const q = assignmentsListSchema.parse(req.query);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.status) {
      conditions.push('a.status = ?');
      params.push(q.status);
    }
    if (q.workspace) {
      conditions.push('(a.workspace = ? OR a.workspace IS NULL)');
      params.push(q.workspace);
    }
    if (q.agent_id) {
      conditions.push('a.agent_id = ?');
      params.push(q.agent_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = (db.prepare(
      `SELECT COUNT(*) AS count FROM coord_assignments a ${where}`
    ).get(...params) as { count: number }).count;

    const assignments = db.prepare(
      `SELECT a.*, g.name AS agent_name,
              CASE WHEN a.blocked_by IS NOT NULL AND a.blocked_by NOT IN (SELECT id FROM coord_assignments WHERE status = 'completed')
                   THEN 1 ELSE 0 END AS is_blocked
       FROM coord_assignments a
       LEFT JOIN coord_agents g ON a.agent_id = g.id
       ${where}
       ORDER BY a.priority DESC, a.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, q.limit, q.offset);

    return reply.send({ assignments, total });
  });

  app.post('/reassign', async (req, reply) => {
    const parsed = reassignSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { assignmentId, target_worker_name } = parsed.data;
    let { targetAgentId } = parsed.data;

    // Verify assignment exists and is active
    const assignment = db.prepare(
      `SELECT id, agent_id, task, status FROM coord_assignments WHERE id = ?`
    ).get(assignmentId) as { id: string; agent_id: string | null; task: string; status: string } | undefined;
    if (!assignment) return reply.code(404).send({ error: 'assignment not found' });
    if (['completed', 'failed'].includes(assignment.status)) {
      return reply.code(400).send({ error: `cannot reassign ${assignment.status} assignment` });
    }

    // Resolve target_worker_name → targetAgentId
    if (!targetAgentId && target_worker_name) {
      const found = db.prepare(
        `SELECT id FROM coord_agents WHERE name = ? AND status != 'dead' ORDER BY last_seen DESC LIMIT 1`
      ).get(target_worker_name) as { id: string } | undefined;
      if (!found) return reply.code(404).send({ error: `target worker not found: ${target_worker_name}` });
      targetAgentId = found.id;
    }

    // Release old agent: set idle, clear current_task, release locks
    if (assignment.agent_id) {
      db.prepare(
        `UPDATE coord_agents SET status = 'idle', current_task = NULL WHERE id = ?`
      ).run(assignment.agent_id);
      db.prepare(
        `DELETE FROM coord_locks WHERE agent_id = ?`
      ).run(assignment.agent_id);
    }

    if (targetAgentId) {
      // Reassign to target
      db.prepare(
        `UPDATE coord_assignments SET agent_id = ?, status = 'assigned', started_at = datetime('now') WHERE id = ?`
      ).run(targetAgentId, assignmentId);
      db.prepare(
        `UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`
      ).run(assignmentId, targetAgentId);
    } else {
      // No target — return to pending for auto-claim
      db.prepare(
        `UPDATE coord_assignments SET agent_id = NULL, status = 'pending', started_at = NULL WHERE id = ?`
      ).run(assignmentId);
    }

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'reassignment', ?)`
    ).run(assignment.agent_id ?? null, `${assignmentId} reassigned from ${assignment.agent_id ?? 'unassigned'} to ${targetAgentId ?? 'pending'}`);

    coordLog(`reassign: ${assignment.task.slice(0, 60)} → ${targetAgentId ?? 'pending'}`);
    return reply.send({ ok: true, assignmentId, newAgentId: targetAgentId ?? null, status: targetAgentId ? 'assigned' : 'pending' });
  });

  app.post('/assignment/:id/update', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const parsed = assignmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const gate = handleAssignmentUpdate(id, parsed.data.status, parsed.data.result, parsed.data.commit_sha);
    if (gate.error) return reply.code(400).send({ error: gate.error });
    return reply.send({ ok: true });
  });

  app.patch('/assignment/:id', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const parsed = assignmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const gate = handleAssignmentUpdate(id, parsed.data.status, parsed.data.result, parsed.data.commit_sha);
    if (gate.error) return reply.code(400).send({ error: gate.error });
    return reply.send({ ok: true });
  });

  app.put('/assignment/:id', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const parsed = assignmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const gate = handleAssignmentUpdate(id, parsed.data.status, parsed.data.result, parsed.data.commit_sha);
    if (gate.error) return reply.code(400).send({ error: gate.error });
    return reply.send({ ok: true });
  });

  // ─── Locks ──────────────────────────────────────────────────────

  app.post('/lock', async (req, reply) => {
    const parsed = lockAcquireSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId, filePath, reason } = parsed.data;

    const inserted = db.prepare(
      `INSERT OR IGNORE INTO coord_locks (file_path, agent_id, reason) VALUES (?, ?, ?)`
    ).run(filePath, agentId, reason ?? null);

    if (inserted.changes > 0) {
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'lock_acquired', ?)`
      ).run(agentId, filePath);
      return reply.send({ ok: true, action: 'acquired' });
    }

    const existing = db.prepare(
      `SELECT agent_id FROM coord_locks WHERE file_path = ?`
    ).get(filePath) as { agent_id: string } | undefined;

    if (existing?.agent_id === agentId) {
      db.prepare(`UPDATE coord_locks SET locked_at = datetime('now') WHERE file_path = ?`).run(filePath);
      return reply.send({ ok: true, action: 'refreshed' });
    }

    return reply.code(409).send({
      error: 'file locked by another agent',
      lockedBy: existing?.agent_id,
    });
  });

  app.delete('/lock', async (req, reply) => {
    const parsed = lockReleaseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId, filePath } = parsed.data;

    const result = db.prepare(
      `DELETE FROM coord_locks WHERE file_path = ? AND agent_id = ?`
    ).run(filePath, agentId);

    if (result.changes === 0) {
      return reply.code(404).send({ error: 'lock not found or not owned by this agent' });
    }

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'lock_released', ?)`
    ).run(agentId, filePath);

    return reply.send({ ok: true });
  });

  app.get('/locks', async (_req, reply) => {
    const locks = db.prepare(
      `SELECT l.file_path, l.agent_id, a.name AS agent_name, l.locked_at, l.reason
       FROM coord_locks l JOIN coord_agents a ON l.agent_id = a.id
       ORDER BY l.locked_at DESC`
    ).all();

    return reply.send({ locks });
  });

  // ─── Commands ───────────────────────────────────────────────────

  app.post('/command', async (req, reply) => {
    const parsed = commandCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { command, reason, issuedBy, workspace } = parsed.data;

    if (command === 'RESUME') {
      if (workspace) {
        db.prepare(
          `UPDATE coord_commands SET cleared_at = datetime('now') WHERE cleared_at IS NULL AND workspace = ?`
        ).run(workspace);
      } else {
        db.prepare(
          `UPDATE coord_commands SET cleared_at = datetime('now') WHERE cleared_at IS NULL`
        ).run();
      }

      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'command', ?)`
      ).run(issuedBy ?? null, `RESUME${workspace ? ' [' + workspace + ']' : ''} — commands cleared`);

      return reply.send({ ok: true, command: 'RESUME', workspace, message: workspace ? `commands cleared for ${workspace}` : 'all active commands cleared' });
    }

    db.prepare(
      `INSERT INTO coord_commands (command, reason, issued_by, workspace) VALUES (?, ?, ?, ?)`
    ).run(command, reason ?? null, issuedBy ?? null, workspace ?? null);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'command', ?)`
    ).run(issuedBy ?? null, `${command}${workspace ? ' [' + workspace + ']' : ''}: ${reason ?? 'no reason given'}`);

    coordLog(`COMMAND: ${command}${reason ? ' — ' + reason : ''}`);
    return reply.code(201).send({ ok: true, command, reason, workspace });
  });

  app.get('/command', async (req, reply) => {
    const workspace = (req.query as Record<string, string>).workspace;

    const active = workspace
      ? db.prepare(
          `SELECT id, command, reason, issued_by, issued_at, workspace
           FROM coord_commands WHERE cleared_at IS NULL AND (workspace = ? OR workspace IS NULL)
           ORDER BY issued_at DESC`
        ).all(workspace) as Array<{ id: number; command: string; reason: string; issued_by: string; issued_at: string; workspace: string | null }>
      : db.prepare(
          `SELECT id, command, reason, issued_by, issued_at, workspace
           FROM coord_commands WHERE cleared_at IS NULL
           ORDER BY issued_at DESC`
        ).all() as Array<{ id: number; command: string; reason: string; issued_by: string; issued_at: string; workspace: string | null }>;

    if (active.length === 0) {
      return reply.send({ active: false, commands: [] });
    }

    const priority: Record<string, number> = { SHUTDOWN: 3, BUILD_FREEZE: 2, PAUSE: 1 };
    active.sort((a, b) => (priority[b.command] ?? 0) - (priority[a.command] ?? 0));

    return reply.send({
      active: true,
      command: active[0].command,
      reason: active[0].reason,
      issued_at: active[0].issued_at,
      commands: active,
    });
  });

  app.delete('/command/:id', async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid command id' });

    const result = db.prepare(
      `UPDATE coord_commands SET cleared_at = datetime('now') WHERE id = ? AND cleared_at IS NULL`
    ).run(id);

    if (result.changes === 0) {
      return reply.code(404).send({ error: 'command not found or already cleared' });
    }

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (NULL, 'command', ?)`
    ).run(`command ${id} cleared via DELETE`);

    return reply.send({ ok: true });
  });

  app.get('/command/wait', async (req, reply) => {
    const q = commandWaitQuerySchema.safeParse(req.query);
    const { status: targetStatus, workspace } = q.success ? q.data : { status: 'idle', workspace: undefined };

    const agents = workspace
      ? db.prepare(
          `SELECT id, name, role, status, current_task, last_seen
           FROM coord_agents WHERE status NOT IN ('dead') AND workspace = ?
           ORDER BY name`
        ).all(workspace) as Array<{ id: string; name: string; role: string; status: string; current_task: string | null; last_seen: string }>
      : db.prepare(
          `SELECT id, name, role, status, current_task, last_seen
           FROM coord_agents WHERE status NOT IN ('dead')
           ORDER BY name`
        ).all() as Array<{ id: string; name: string; role: string; status: string; current_task: string | null; last_seen: string }>;

    const ready = agents.filter(a => a.status === targetStatus || a.role === 'orchestrator' || a.role === 'coordinator');
    const notReady = agents.filter(a => a.status !== targetStatus && a.role !== 'orchestrator' && a.role !== 'coordinator');

    return reply.send({
      allReady: notReady.length === 0,
      total: agents.length,
      ready: ready.map(a => ({ name: a.name, status: a.status })),
      waiting: notReady.map(a => ({ name: a.name, status: a.status, task: a.current_task })),
    });
  });

  // ─── Findings ───────────────────────────────────────────────────

  app.post('/finding', async (req, reply) => {
    const parsed = findingCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId, category, severity, filePath, lineNumber, description, suggestion } = parsed.data;

    db.prepare(
      `INSERT INTO coord_findings (agent_id, category, severity, file_path, line_number, description, suggestion)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(agentId, category, severity ?? 'info', filePath ?? null, lineNumber ?? null, description, suggestion ?? null);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'finding', ?)`
    ).run(agentId, `[${severity ?? 'info'}] ${category}: ${description.slice(0, 100)}`);

    return reply.code(201).send({ ok: true });
  });

  app.get('/findings', async (req, reply) => {
    const q = findingsQuerySchema.safeParse(req.query);
    const { category, severity, status, limit } = q.success ? q.data : { category: undefined, severity: undefined, status: undefined, limit: 50 };

    let sql = `
      SELECT f.id, f.category, f.severity, f.file_path, f.line_number,
             f.description, f.suggestion, f.status, f.created_at,
             a.name AS agent_name
      FROM coord_findings f JOIN coord_agents a ON f.agent_id = a.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (category) { sql += ` AND f.category = ?`; params.push(category); }
    if (severity) { sql += ` AND f.severity = ?`; params.push(severity); }
    if (status) { sql += ` AND f.status = ?`; params.push(status); }

    sql += ` ORDER BY
      CASE f.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
      f.created_at DESC
      LIMIT ?`;
    params.push(limit);

    const findings = db.prepare(sql).all(...params);

    const stats = db.prepare(
      `SELECT severity, COUNT(*) as count FROM coord_findings WHERE status = 'open' GROUP BY severity`
    ).all();

    return reply.send({ findings, stats });
  });

  app.post('/finding/:id/resolve', async (req, reply) => {
    const { id } = findingIdParamSchema.parse(req.params);
    db.prepare(
      `UPDATE coord_findings SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`
    ).run(id);
    return reply.send({ ok: true });
  });

  app.patch('/finding/:id', async (req, reply) => {
    const { id } = findingIdParamSchema.parse(req.params);
    const parsed = findingUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { status, suggestion } = parsed.data;

    const existing = db.prepare(`SELECT id FROM coord_findings WHERE id = ?`).get(id);
    if (!existing) return reply.code(404).send({ error: 'finding not found' });

    const sets: string[] = [];
    const params: unknown[] = [];

    if (status) {
      sets.push('status = ?');
      params.push(status);
      if (status === 'resolved') {
        sets.push("resolved_at = datetime('now')");
      }
    }
    if (suggestion !== undefined) {
      sets.push('suggestion = ?');
      params.push(suggestion);
    }

    if (sets.length === 0) return reply.send({ ok: true, changed: false });

    params.push(id);
    db.prepare(`UPDATE coord_findings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return reply.send({ ok: true, changed: true });
  });

  app.get('/findings/summary', async (_req, reply) => {
    const bySeverity = db.prepare(
      `SELECT severity, COUNT(*) as count FROM coord_findings WHERE status = 'open' GROUP BY severity`
    ).all();

    const byCategory = db.prepare(
      `SELECT category, COUNT(*) as count FROM coord_findings WHERE status = 'open' GROUP BY category ORDER BY count DESC`
    ).all();

    const total = db.prepare(
      `SELECT COUNT(*) as total FROM coord_findings WHERE status = 'open'`
    ).get() as { total: number };

    return reply.send({ total: total.total, bySeverity, byCategory });
  });

  // ─── Decisions (cross-agent propagation) ────────────────────────

  app.get('/decisions', async (req, reply) => {
    const q = decisionsQuerySchema.safeParse(req.query);
    const { since_id, assignment_id, limit } = q.success ? q.data : { since_id: 0, assignment_id: undefined, limit: 20 };

    let sql = `
      SELECT d.id, d.author_id, a.name AS author_name, d.assignment_id, d.tags, d.summary, d.created_at
      FROM coord_decisions d JOIN coord_agents a ON d.author_id = a.id
      WHERE d.id > ?
    `;
    const params: unknown[] = [since_id];

    if (assignment_id) {
      sql += ` AND d.assignment_id = ?`;
      params.push(assignment_id);
    }

    sql += ` ORDER BY d.created_at ASC LIMIT ?`;
    params.push(limit);

    const decisions = db.prepare(sql).all(...params);
    return reply.send({ decisions });
  });

  app.post('/decisions', async (req, reply) => {
    const { agentId, assignment_id, tags, summary } = decisionCreateSchema.parse(req.body);

    // Verify agent exists
    const agent = db.prepare(`SELECT id FROM coord_agents WHERE id = ?`).get(agentId) as { id: string } | undefined;
    if (!agent) return reply.code(404).send({ error: 'agent not found' });

    db.prepare(
      `INSERT INTO coord_decisions (author_id, assignment_id, tags, summary) VALUES (?, ?, ?, ?)`
    ).run(agentId, assignment_id ?? null, tags ?? null, summary);

    const row = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
    return reply.code(201).send({ ok: true, id: row.id });
  });

  // ─── Status ─────────────────────────────────────────────────────

  app.get('/status', async (_req, reply) => {
    const agents = db.prepare(
      `SELECT id, name, role, status, current_task, last_seen,
              ROUND((julianday('now') - julianday(last_seen)) * 86400) AS seconds_since_seen
       FROM coord_agents WHERE status != 'dead'
       ORDER BY role, name`
    ).all();

    const assignments = db.prepare(
      `SELECT a.id, a.task, a.description, a.status, a.agent_id, ag.name AS agent_name,
              a.created_at, a.started_at, a.completed_at
       FROM coord_assignments a LEFT JOIN coord_agents ag ON a.agent_id = ag.id
       WHERE a.status NOT IN ('completed', 'failed')
       ORDER BY a.created_at`
    ).all();

    const locks = db.prepare(
      `SELECT l.file_path, l.agent_id, a.name AS agent_name, l.locked_at, l.reason
       FROM coord_locks l JOIN coord_agents a ON l.agent_id = a.id`
    ).all();

    const stats = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM coord_agents WHERE status != 'dead') AS alive_agents,
         (SELECT COUNT(*) FROM coord_agents WHERE status = 'working') AS busy_agents,
         (SELECT COUNT(*) FROM coord_assignments WHERE status = 'pending') AS pending_tasks,
         (SELECT COUNT(*) FROM coord_assignments WHERE status IN ('assigned', 'in_progress')) AS active_tasks,
         (SELECT COUNT(*) FROM coord_locks) AS active_locks,
         (SELECT COUNT(*) FROM coord_findings WHERE status = 'open') AS open_findings,
         (SELECT COUNT(*) FROM coord_findings WHERE status = 'open' AND severity IN ('critical', 'error')) AS urgent_findings`
    ).get();

    const recentFindings = db.prepare(
      `SELECT f.id, f.category, f.severity, f.file_path, f.description, a.name AS agent_name, f.created_at
       FROM coord_findings f JOIN coord_agents a ON f.agent_id = a.id
       WHERE f.status = 'open'
       ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
                f.created_at DESC
       LIMIT 10`
    ).all();

    return reply.send({ agents, assignments, locks, stats, recentFindings });
  });

  app.get('/workers', async (req, reply) => {
    const q = workersQuerySchema.safeParse(req.query);
    const { capability, status: filterStatus, workspace } = q.success ? q.data : { capability: undefined, status: undefined, workspace: undefined };

    let workers = workspace
      ? db.prepare(
          `SELECT id, name, role, status, current_task, capabilities, workspace, last_seen,
                  ROUND((julianday('now') - julianday(last_seen)) * 86400) AS seconds_since_seen
           FROM coord_agents
           WHERE status != 'dead' AND role NOT IN ('orchestrator', 'coordinator') AND workspace = ?
           ORDER BY name`
        ).all(workspace) as Array<{
          id: string; name: string; role: string; status: string;
          current_task: string | null; capabilities: string | null;
          workspace: string | null; last_seen: string; seconds_since_seen: number;
        }>
      : db.prepare(
          `SELECT id, name, role, status, current_task, capabilities, workspace, last_seen,
                  ROUND((julianday('now') - julianday(last_seen)) * 86400) AS seconds_since_seen
           FROM coord_agents
           WHERE status != 'dead' AND role NOT IN ('orchestrator', 'coordinator')
           ORDER BY name`
        ).all() as Array<{
          id: string; name: string; role: string; status: string;
          current_task: string | null; capabilities: string | null;
          workspace: string | null; last_seen: string; seconds_since_seen: number;
        }>;

    if (capability) {
      workers = workers.filter(w => {
        if (!w.capabilities) return false;
        try {
          const caps = JSON.parse(w.capabilities) as string[];
          return caps.includes(capability);
        } catch {
          return false;
        }
      });
    }

    if (filterStatus) {
      workers = workers.filter(w => w.status === filterStatus);
    }

    const result = workers.map(w => ({
      id: w.id,
      name: w.name,
      role: w.role,
      status: w.status,
      currentTask: w.current_task,
      capabilities: w.capabilities ? JSON.parse(w.capabilities) : [],
      workspace: w.workspace,
      lastSeen: w.last_seen,
      secondsSinceSeen: w.seconds_since_seen,
      alive: w.seconds_since_seen < 120,
    }));

    return reply.send({
      count: result.length,
      idle: result.filter(w => w.status === 'idle').length,
      working: result.filter(w => w.status === 'working').length,
      workers: result,
    });
  });

  app.get('/events', async (req, reply) => {
    const q = eventsQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0].message });
    const { since_id, agent_id, event_type, limit } = q.data;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (since_id > 0) {
      conditions.push('e.id > ?');
      params.push(since_id);
    }
    if (agent_id) {
      conditions.push('e.agent_id = ?');
      params.push(agent_id);
    }
    if (event_type) {
      conditions.push('e.event_type = ?');
      params.push(event_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const events = db.prepare(
      `SELECT e.id, e.agent_id, a.name AS agent_name, e.event_type, e.detail, e.created_at
       FROM coord_events e LEFT JOIN coord_agents a ON e.agent_id = a.id
       ${where}
       ORDER BY e.id ASC LIMIT ?`
    ).all(...params);

    const last_id = events.length > 0 ? (events[events.length - 1] as { id: number }).id : since_id;

    return reply.send({ events, last_id });
  });

  app.get('/stale', async (req, reply) => {
    const q = staleQuerySchema.safeParse(req.query);
    const threshold = q.success ? q.data.seconds : 120;
    const cleanup = q.success ? q.data.cleanup : undefined;

    const stale = detectStale(db, threshold);

    if (cleanup === '1' || cleanup === 'true') {
      const { cleaned } = cleanupStale(db, threshold);
      return reply.send({ stale, threshold_seconds: threshold, cleaned });
    }

    return reply.send({ stale, threshold_seconds: threshold });
  });

  app.post('/stale/cleanup', async (req, reply) => {
    const q = staleQuerySchema.safeParse(req.query);
    const threshold = q.success ? q.data.seconds : 120;

    const { stale, cleaned } = cleanupStale(db, threshold);
    return reply.send({ stale, threshold_seconds: threshold, cleaned });
  });

  // ─── Agent Management ───────────────────────────────────────────

  app.get('/agent/:id', async (req, reply) => {
    const params = agentIdParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.issues[0].message });
    const { id } = params.data;

    const agent = db.prepare(
      `SELECT id, name, role, status, current_task, pid, capabilities, workspace, metadata, last_seen, started_at,
              ROUND((julianday('now') - julianday(last_seen)) * 86400) AS seconds_since_seen
       FROM coord_agents WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;

    if (!agent) return reply.code(404).send({ error: 'agent not found' });

    // Include active assignment and locks
    const assignment = db.prepare(
      `SELECT id, task, status, priority, created_at FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at DESC LIMIT 1`
    ).get(id) as Record<string, unknown> | undefined;

    const locks = db.prepare(
      `SELECT file_path, locked_at, reason FROM coord_locks WHERE agent_id = ?`
    ).all(id);

    return reply.send({ agent, assignment: assignment ?? null, locks });
  });

  app.delete('/agent/:id', async (req, reply) => {
    const params = agentIdParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.issues[0].message });
    const { id } = params.data;

    const agent = db.prepare(`SELECT id, name, status FROM coord_agents WHERE id = ?`).get(id) as { id: string; name: string; status: string } | undefined;
    if (!agent) return reply.code(404).send({ error: 'agent not found' });
    if (agent.status === 'dead') return reply.send({ ok: true, action: 'already_dead', agent_name: agent.name });

    // Fail active assignments
    const failedAssignments = db.prepare(
      `UPDATE coord_assignments SET status = 'failed', result = 'agent killed by coordinator', completed_at = datetime('now')
       WHERE agent_id = ? AND status IN ('assigned', 'in_progress')`
    ).run(id);

    if (failedAssignments.changes > 0) {
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_failed', ?)`
      ).run(id, `killed: failed ${failedAssignments.changes} active assignment(s)`);
    }

    // Release locks
    const releasedLocks = db.prepare(`DELETE FROM coord_locks WHERE agent_id = ?`).run(id);

    // Mark dead
    db.prepare(`UPDATE coord_agents SET status = 'dead', current_task = NULL WHERE id = ?`).run(id);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'agent_killed', ?)`
    ).run(id, `${agent.name} killed: failed ${failedAssignments.changes} assignment(s), released ${releasedLocks.changes} lock(s)`);

    coordLog(`${agent.name} killed — failed ${failedAssignments.changes} assignment(s), released ${releasedLocks.changes} lock(s)`);

    return reply.send({
      ok: true,
      action: 'killed',
      agent_name: agent.name,
      failed_assignments: failedAssignments.changes,
      released_locks: releasedLocks.changes,
    });
  });

  // ─── Stats ──────────────────────────────────────────────────────

  app.get('/stats', async (_req, reply) => {
    const workers = db.prepare(`
      SELECT
        COUNT(*)                                    AS total,
        SUM(CASE WHEN status != 'dead' THEN 1 ELSE 0 END)  AS alive,
        SUM(CASE WHEN status = 'idle' THEN 1 ELSE 0 END)   AS idle,
        SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) AS working
      FROM coord_agents
    `).get() as { total: number; alive: number; idle: number; working: number };

    const tasks = db.prepare(`
      SELECT
        COUNT(*)                                         AS total_assigned,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)    AS failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)   AS pending,
        AVG(CASE
          WHEN status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
          THEN ROUND((julianday(completed_at) - julianday(started_at)) * 86400)
          ELSE NULL
        END) AS avg_completion_seconds
      FROM coord_assignments
    `).get() as { total_assigned: number; completed: number; failed: number; pending: number; avg_completion_seconds: number | null };

    const decisions = db.prepare(`
      SELECT
        COALESCE(COUNT(*), 0)                                                              AS total,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 hour') THEN 1 ELSE 0 END), 0) AS last_hour
      FROM coord_decisions
    `).get() as { total: number; last_hour: number };

    // Uptime = seconds since the earliest non-dead agent started
    const uptime = db.prepare(`
      SELECT ROUND((julianday('now') - julianday(MIN(started_at))) * 86400) AS uptime_seconds
      FROM coord_agents WHERE status != 'dead'
    `).get() as { uptime_seconds: number | null };

    return reply.send({
      workers,
      tasks: {
        ...tasks,
        avg_completion_seconds: tasks.avg_completion_seconds != null
          ? Math.round(tasks.avg_completion_seconds)
          : null,
      },
      decisions,
      uptime_seconds: uptime.uptime_seconds ?? 0,
    });
  });
}
