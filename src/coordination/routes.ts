// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP routes for the coordination module.
 * Ported from AgentSynapse packages/coordinator/src/routes/*.ts into a single file.
 * All tables use coord_ prefix to avoid collision with AWM core tables.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  checkinSchema, checkoutSchema, pulseSchema,
  assignCreateSchema, assignmentQuerySchema, assignmentClaimSchema, assignmentUpdateSchema, assignmentIdParamSchema,
  lockAcquireSchema, lockReleaseSchema,
  commandCreateSchema, commandWaitQuerySchema,
  findingCreateSchema, findingsQuerySchema, findingIdParamSchema,
  eventsQuerySchema, staleQuerySchema, workersQuerySchema,
} from './schemas.js';
import { detectStale, cleanupStale } from './stale.js';

export function registerCoordinationRoutes(app: FastifyInstance, db: Database.Database): void {

  // ─── Checkin ────────────────────────────────────────────────────

  app.post('/checkin', async (req, reply) => {
    const parsed = checkinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { name, role, pid, metadata, capabilities, workspace } = parsed.data;
    const capsJson = capabilities ? JSON.stringify(capabilities) : null;

    const existing = workspace
      ? db.prepare(
          `SELECT id, status FROM coord_agents WHERE name = ? AND workspace = ? AND status != 'dead'`
        ).get(name, workspace) as { id: string; status: string } | undefined
      : db.prepare(
          `SELECT id, status FROM coord_agents WHERE name = ? AND workspace IS NULL AND status != 'dead'`
        ).get(name) as { id: string; status: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE coord_agents SET last_seen = datetime('now'), status = CASE WHEN status = 'dead' THEN 'idle' ELSE status END, pid = COALESCE(?, pid), capabilities = COALESCE(?, capabilities) WHERE id = ?`
      ).run(pid ?? null, capsJson, existing.id);

      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'heartbeat', ?)`
      ).run(existing.id, `heartbeat from ${name}`);

      return reply.send({ agentId: existing.id, action: 'heartbeat', status: existing.status, workspace });
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO coord_agents (id, name, role, pid, status, metadata, capabilities, workspace) VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)`
    ).run(id, name, role ?? 'worker', pid ?? null, metadata ? JSON.stringify(metadata) : null, capsJson, workspace ?? null);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'registered', ?)`
    ).run(id, `${name} joined as ${role ?? 'worker'}${workspace ? ' [' + workspace + ']' : ''}${capabilities ? ' [' + capabilities.join(', ') + ']' : ''}`);

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

  // ─── Assignments ────────────────────────────────────────────────

  app.post('/assign', async (req, reply) => {
    const parsed = assignCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId, task, description, workspace } = parsed.data;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO coord_assignments (id, agent_id, task, description, status, workspace) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, agentId ?? null, task, description ?? null, agentId ? 'assigned' : 'pending', workspace ?? null);

    if (agentId) {
      db.prepare(
        `UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`
      ).run(id, agentId);
    }

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_created', ?)`
    ).run(agentId ?? null, `task: ${task}`);

    return reply.code(201).send({ assignmentId: id, status: agentId ? 'assigned' : 'pending' });
  });

  app.get('/assignment', async (req, reply) => {
    const agentId = (req.headers['x-agent-id'] as string | undefined) ?? assignmentQuerySchema.parse(req.query).agentId;

    if (!agentId) {
      return reply.send({ assignment: null });
    }

    const active = db.prepare(
      `SELECT * FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at DESC LIMIT 1`
    ).get(agentId);

    if (active) return reply.send({ assignment: active });

    const agentRow = db.prepare(`SELECT workspace FROM coord_agents WHERE id = ?`).get(agentId) as { workspace: string | null } | undefined;
    const agentWorkspace = agentRow?.workspace;

    const pending = agentWorkspace
      ? db.prepare(
          `SELECT * FROM coord_assignments WHERE status = 'pending' AND (workspace = ? OR workspace IS NULL) ORDER BY created_at ASC LIMIT 1`
        ).get(agentWorkspace) as { id: string } | undefined
      : db.prepare(
          `SELECT * FROM coord_assignments WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
        ).get() as { id: string } | undefined;

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

  function handleAssignmentUpdate(id: string, status: string, result: string | undefined) {
    if (['completed', 'failed'].includes(status)) {
      db.prepare(
        `UPDATE coord_assignments SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`
      ).run(status, result ?? null, id);
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

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES ((SELECT agent_id FROM coord_assignments WHERE id = ?), 'assignment_update', ?)`
    ).run(id, `${id} → ${status}`);
  }

  app.post('/assignment/:id/update', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const parsed = assignmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    handleAssignmentUpdate(id, parsed.data.status, parsed.data.result);
    return reply.send({ ok: true });
  });

  app.patch('/assignment/:id', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const parsed = assignmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    handleAssignmentUpdate(id, parsed.data.status, parsed.data.result);
    return reply.send({ ok: true });
  });

  app.put('/assignment/:id', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const parsed = assignmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    handleAssignmentUpdate(id, parsed.data.status, parsed.data.result);
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

    const ready = agents.filter(a => a.status === targetStatus || a.role === 'orchestrator');
    const notReady = agents.filter(a => a.status !== targetStatus && a.role !== 'orchestrator');

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
           WHERE status != 'dead' AND role != 'orchestrator' AND workspace = ?
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
           WHERE status != 'dead' AND role != 'orchestrator'
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
    const limit = q.success ? q.data.limit : 50;

    const events = db.prepare(
      `SELECT e.id, e.agent_id, a.name AS agent_name, e.event_type, e.detail, e.created_at
       FROM coord_events e LEFT JOIN coord_agents a ON e.agent_id = a.id
       ORDER BY e.created_at DESC LIMIT ?`
    ).all(limit);

    return reply.send({ events });
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
}
