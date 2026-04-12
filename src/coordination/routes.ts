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
  agentIdParamSchema, timelineQuerySchema,
  channelRegisterSchema, channelDeregisterSchema, channelPushSchema,
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

/**
 * Optional session-token check.
 * If X-Session-Token header is present and doesn't match the stored token → returns false (caller should 403).
 * If header is absent, or no token stored (old agent row) → returns true (pass through).
 */
function sessionTokenOk(db: Database.Database, agentId: string, req: import('fastify').FastifyRequest): boolean {
  const provided = req.headers['x-session-token'];
  if (!provided) return true;
  const row = db.prepare(`SELECT session_token FROM coord_agents WHERE id = ?`).get(agentId) as { session_token: string | null } | undefined;
  if (!row || !row.session_token) return true; // not found or no token stored — backward compat
  return row.session_token === provided;
}

export function registerCoordinationRoutes(app: FastifyInstance, db: Database.Database, store?: EngramStore, eventBus?: import('./events.js').CoordinationEventBus): void {

  // Request logging — one line per request with method, url, status, response time
  app.addHook('onRequest', async (request) => {
    (request as any)._startTime = Date.now();
  });
  app.addHook('onResponse', async (request, reply) => {
    const ms = Date.now() - ((request as any)._startTime ?? Date.now());
    // Skip noisy polling endpoints at 2xx to reduce log spam
    const isPolling = (request.url === '/next' || request.url === '/pulse' || request.url === '/health') && reply.statusCode < 300;
    if (!isPolling) {
      coordLog(`${request.method} ${request.url} ${reply.statusCode} ${ms}ms`);
    }
  });

  // Pulse coalescing — skip DB write if last pulse was <10s ago
  const PULSE_COALESCE_MS = 10_000;
  const lastPulseTime = new Map<string, number>();

  // Rate limiting — 300 requests/minute per agent (sliding window)
  // Hive agents poll frequently + synapse-push polls /events every 2s
  const RATE_LIMIT = 300;
  const RATE_WINDOW_MS = 60_000;
  const rateBuckets = new Map<string, number[]>();

  // Cleanup stale buckets every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [key, timestamps] of rateBuckets) {
      const fresh = timestamps.filter(t => t > cutoff);
      if (fresh.length === 0) rateBuckets.delete(key);
      else rateBuckets.set(key, fresh);
    }
  }, 300_000).unref();

  app.addHook('preHandler', async (request, reply) => {
    if (request.url === '/health') return; // exempt

    // Identify agent by name from body or query, or agentId
    const body = request.body as Record<string, unknown> | undefined;
    const query = request.query as Record<string, unknown> | undefined;
    const key = (body?.name ?? body?.agentId ?? query?.agentId ?? query?.name ?? request.ip) as string;
    if (!key) return;

    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    const timestamps = rateBuckets.get(key) ?? [];
    const recent = timestamps.filter(t => t > cutoff);
    recent.push(now);
    rateBuckets.set(key, recent);

    if (recent.length > RATE_LIMIT) {
      return reply.code(429).send({ error: `rate limit exceeded — max ${RATE_LIMIT} requests/minute` });
    }
  });

  // ─── Checkin ────────────────────────────────────────────────────

  app.post('/checkin', async (req, reply) => {
    const parsed = checkinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { name, role, pid, metadata, capabilities, workspace, channelUrl } = parsed.data;
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
      // Issue a fresh token on reconnect; reuse existing token for live heartbeats
      const sessionToken = wasDead ? randomUUID() : (
        (db.prepare(`SELECT session_token FROM coord_agents WHERE id = ?`).get(existing.id) as { session_token: string | null }).session_token ?? randomUUID()
      );
      db.prepare(
        `UPDATE coord_agents SET last_seen = datetime('now'), status = CASE WHEN status = 'dead' THEN 'idle' ELSE status END, pid = COALESCE(?, pid), capabilities = COALESCE(?, capabilities), workspace = COALESCE(?, workspace), session_token = ? WHERE id = ?`
      ).run(pid ?? null, capsJson, workspace ?? null, sessionToken, existing.id);

      const eventType = wasDead ? 'reconnected' : 'heartbeat';
      const detail = wasDead ? `${name} reconnected (was dead)` : `heartbeat from ${name}`;
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, ?, ?)`
      ).run(existing.id, eventType, detail);

      if (wasDead) coordLog(`${name} reconnected (reusing UUID ${existing.id.slice(0, 8)})`);
      // Auto-register channel session if channelUrl provided
      if (channelUrl) {
        db.prepare(`
          INSERT INTO coord_channel_sessions (agent_id, channel_id, connected_at, status)
          VALUES (?, ?, datetime('now'), 'connected')
          ON CONFLICT(agent_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            connected_at = datetime('now'),
            status = 'connected',
            push_count = 0,
            last_push_at = NULL
        `).run(existing.id, channelUrl);
        coordLog(`channel auto-registered: ${name} (${existing.id.slice(0, 8)}) → ${channelUrl}`);
      }
      const action = wasDead ? 'reconnected' : 'heartbeat';
      const status = wasDead ? 'idle' : existing.status;
      return reply.send({ agentId: existing.id, sessionToken, action, status, workspace });
    }

    const id = randomUUID();
    const sessionToken = randomUUID();
    db.prepare(
      `INSERT INTO coord_agents (id, name, role, pid, status, metadata, capabilities, workspace, session_token) VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?)`
    ).run(id, name, role ?? 'worker', pid ?? null, metadata ? JSON.stringify(metadata) : null, capsJson, workspace ?? null, sessionToken);

    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'registered', ?)`
    ).run(id, `${name} joined as ${role ?? 'worker'}${workspace ? ' [' + workspace + ']' : ''}${capabilities ? ' [' + capabilities.join(', ') + ']' : ''}`);

    // Auto-register channel session if channelUrl provided
    if (channelUrl) {
      db.prepare(`
        INSERT INTO coord_channel_sessions (agent_id, channel_id, connected_at, status)
        VALUES (?, ?, datetime('now'), 'connected')
        ON CONFLICT(agent_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          connected_at = datetime('now'),
          status = 'connected',
          push_count = 0,
          last_push_at = NULL
      `).run(id, channelUrl);
      coordLog(`channel auto-registered: ${name} (${id.slice(0, 8)}) → ${channelUrl}`);
    }

    coordLog(`${name} registered (${role ?? 'worker'})${capabilities ? ' [' + capabilities.join(', ') + ']' : ''}`);
    eventBus?.emit('agent.checkin', { agentId: id, name, role: role ?? 'worker', workspace: workspace ?? undefined });
    return reply.code(201).send({ agentId: id, sessionToken, action: 'registered', status: 'idle', workspace });
  });

  // ─── Shutdown (graceful coordination teardown) ─────────────────

  app.post('/shutdown', async (_req, reply) => {
    // Mark all live agents as dead
    const alive = db.prepare(
      `SELECT id, name FROM coord_agents WHERE status != 'dead'`
    ).all() as Array<{ id: string; name: string }>;

    const shutdownTx = db.transaction(() => {
      for (const agent of alive) {
        db.prepare(`DELETE FROM coord_locks WHERE agent_id = ?`).run(agent.id);
        db.prepare(`UPDATE coord_agents SET status = 'dead', current_task = NULL WHERE id = ?`).run(agent.id);
        db.prepare(
          `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'shutdown', 'graceful shutdown')`
        ).run(agent.id);
      }
    });
    shutdownTx();

    // Flush WAL before caller terminates the process
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* non-fatal if DB is closing */ }

    coordLog(`Graceful shutdown: ${alive.length} agent(s) marked offline`);
    return reply.send({ ok: true, agents_marked_offline: alive.length });
  });

  app.post('/checkout', async (req, reply) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId } = parsed.data;

    if (!sessionTokenOk(db, agentId, req)) return reply.code(403).send({ error: 'invalid session token' });

    // Atomic transaction: delete locks + channel session + update agent + event
    const checkoutTx = db.transaction(() => {
      db.prepare(`DELETE FROM coord_locks WHERE agent_id = ?`).run(agentId);
      db.prepare(`DELETE FROM coord_channel_sessions WHERE agent_id = ?`).run(agentId);
      db.prepare(
        `UPDATE coord_agents SET status = 'dead', last_seen = datetime('now') WHERE id = ?`
      ).run(agentId);
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'checkout', 'agent signed off')`
      ).run(agentId);
    });
    checkoutTx();

    // Look up agent name for logging (outside tx — read-only)
    const agent = db.prepare(`SELECT name FROM coord_agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
    coordLog(`${agent?.name ?? agentId} checked out`);
    eventBus?.emit('agent.checkout', { agentId, name: agent?.name ?? agentId });
    return reply.send({ ok: true });
  });

  // ─── Pulse (lightweight heartbeat — no event row) ──────────────

  app.patch('/pulse', async (req, reply) => {
    const parsed = pulseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId } = parsed.data;

    if (!sessionTokenOk(db, agentId, req)) return reply.code(403).send({ error: 'invalid session token' });

    // Coalesce: skip DB write if last pulse was <10s ago
    const now = Date.now();
    const lastTime = lastPulseTime.get(agentId) ?? 0;
    if (now - lastTime < PULSE_COALESCE_MS) {
      return reply.send({ ok: true, coalesced: true });
    }

    lastPulseTime.set(agentId, now);
    db.prepare(`UPDATE coord_agents SET last_seen = datetime('now') WHERE id = ?`).run(agentId);
    return reply.send({ ok: true });
  });

  // ─── Next (combined checkin + commands + assignment poll) ───────

  app.post('/next', async (req, reply) => {
    const parsed = nextSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { name, workspace, role, capabilities, channelUrl } = parsed.data;
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
    let sessionToken: string;
    if (existing) {
      agentId = existing.id;
      const wasDead = existing.status === 'dead';
      // Fresh token on reconnect; reuse existing on heartbeat
      const existingToken = (db.prepare(`SELECT session_token FROM coord_agents WHERE id = ?`).get(agentId) as { session_token: string | null }).session_token;
      sessionToken = wasDead ? randomUUID() : (existingToken ?? randomUUID());
      db.prepare(
        `UPDATE coord_agents SET last_seen = datetime('now'), status = CASE WHEN status = 'dead' THEN 'idle' ELSE status END, capabilities = COALESCE(?, capabilities), workspace = COALESCE(?, workspace), session_token = ? WHERE id = ?`
      ).run(capsJson, workspace ?? null, sessionToken, agentId);
      const eventType = wasDead ? 'reconnected' : 'heartbeat';
      const detail = wasDead ? `${name} reconnected via /next` : `heartbeat from ${name}`;
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, ?, ?)`
      ).run(agentId, eventType, detail);
      if (wasDead) coordLog(`${name} reconnected via /next (reusing UUID ${agentId.slice(0, 8)})`);
    } else {
      agentId = randomUUID();
      sessionToken = randomUUID();
      db.prepare(
        `INSERT INTO coord_agents (id, name, role, pid, status, metadata, capabilities, workspace, session_token) VALUES (?, ?, ?, NULL, 'idle', NULL, ?, ?, ?)`
      ).run(agentId, name, role ?? 'worker', capsJson, workspace ?? null, sessionToken);
      db.prepare(
        `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'registered', ?)`
      ).run(agentId, `${name} joined as ${role ?? 'worker'} via /next`);
      coordLog(`${name} registered via /next (${role ?? 'worker'})${capabilities ? ' [' + capabilities.join(', ') + ']' : ''}`);
    }

    // Auto-register channel session if channelUrl provided
    if (channelUrl) {
      db.prepare(`
        INSERT INTO coord_channel_sessions (agent_id, channel_id, connected_at, status)
        VALUES (?, ?, datetime('now'), 'connected')
        ON CONFLICT(agent_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          connected_at = datetime('now'),
          status = 'connected',
          push_count = 0,
          last_push_at = NULL
      `).run(agentId, channelUrl);
      coordLog(`channel auto-registered via /next: ${name} (${agentId.slice(0, 8)}) → ${channelUrl}`);
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

    // Cross-UUID fallback: check if this agent name has assignments under a different UUID
    // (happens when POST /assign resolved worker_name to a stale/alternate UUID)
    if (!assignment) {
      const altIds = db.prepare(
        `SELECT id FROM coord_agents WHERE name = ? AND id != ? AND status != 'dead'`
      ).all(name, agentId) as Array<{ id: string }>;

      for (const alt of altIds) {
        const altActive = db.prepare(
          `SELECT * FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at DESC LIMIT 1`
        ).get(alt.id) as Record<string, unknown> | undefined;
        if (altActive) {
          // Migrate assignment to the current agent UUID
          db.prepare(`UPDATE coord_assignments SET agent_id = ? WHERE id = ?`).run(agentId, altActive.id as string);
          db.prepare(`UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`).run(altActive.id as string, agentId);
          altActive.agent_id = agentId;
          coordLog(`assignment ${(altActive.id as string).slice(0, 8)} migrated from alt UUID ${alt.id.slice(0, 8)} to ${agentId.slice(0, 8)} (same agent: ${name})`);
          assignment = altActive;
          break;
        }
      }
    }

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

    // If agent has an active assignment, ensure status is 'working'
    if (assignment) {
      db.prepare(`UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ? AND status != 'working'`).run(assignment.id as string, agentId);
    }

    // Read current agent status after all mutations
    const agentRow = db.prepare(`SELECT status FROM coord_agents WHERE id = ?`).get(agentId) as { status: string };

    // Deliver queued mailbox messages (persistent messages that survived disconnects/restarts)
    const mailbox = db.prepare(
      `SELECT id, message, source, created_at FROM coord_mailbox
       WHERE worker_name = ? AND delivered_at IS NULL
       AND (workspace = ? OR workspace IS NULL)
       ORDER BY created_at ASC LIMIT 10`
    ).all(name, workspace ?? null) as Array<{ id: number; message: string; source: string; created_at: string }>;

    if (mailbox.length > 0) {
      const ids = mailbox.map(m => m.id);
      db.prepare(
        `UPDATE coord_mailbox SET delivered_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`
      ).run(...ids);
      coordLog(`mailbox: delivered ${mailbox.length} queued message(s) to ${name}`);
    }

    return reply.send({
      agentId,
      sessionToken,
      status: agentRow.status,
      assignment: assignment ?? null,
      commands: activeCommands,
      mailbox: mailbox.length > 0 ? mailbox.map(m => ({ message: m.message, source: m.source, queued_at: m.created_at })) : undefined,
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
    let pushed = false;

    // Atomic transaction: assignment insert + agent status + event + channel push
    const assignTx = db.transaction(() => {
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

      // Record channel push intent in the DB (stats + event)
      if (agentId) {
        const session = db.prepare(
          `SELECT agent_id, channel_id FROM coord_channel_sessions WHERE agent_id = ? AND status = 'connected'`
        ).get(agentId) as { agent_id: string; channel_id: string } | undefined;
        if (session) {
          // Record channel_push event so agent sees it on next poll/restore
          const pushMsg = `NEW ASSIGNMENT: ${task}${description ? ' — ' + description.slice(0, 200) : ''}`;
          db.prepare(
            `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'channel_push', ?)`
          ).run(agentId, pushMsg.slice(0, 500));
          pushed = true;
        }
      }
    });
    assignTx();

    // Actually deliver the push to the worker's channel HTTP endpoint (outside DB transaction)
    let delivered = false;
    if (pushed && agentId) {
      const session = db.prepare(
        `SELECT channel_id FROM coord_channel_sessions WHERE agent_id = ? AND status = 'connected'`
      ).get(agentId) as { channel_id: string } | undefined;
      if (session) {
        const pushMsg = `NEW ASSIGNMENT: ${task}${description ? ' — ' + description.slice(0, 200) : ''}`;
        const agent = db.prepare(`SELECT name FROM coord_agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
        const result = await deliverToChannel(
          agentId, session.channel_id, pushMsg,
          { source: 'coordinator', agent: agent?.name ?? agentId, assignmentId: id }
        );
        delivered = result.delivered;
        if (delivered) {
          db.prepare(
            `UPDATE coord_channel_sessions SET last_push_at = datetime('now'), push_count = push_count + 1 WHERE agent_id = ?`
          ).run(agentId);
        }
      }
    }

    // Bridge context to AWM engrams (outside transaction — engram store has its own DB)
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

    // If push failed or no channel, queue to mailbox so worker gets it on next /next poll
    let queued = false;
    if (agentId && !delivered) {
      const agent = db.prepare(`SELECT name, workspace FROM coord_agents WHERE id = ?`).get(agentId) as { name: string; workspace: string | null } | undefined;
      if (agent) {
        const mailMsg = `NEW ASSIGNMENT [${id.slice(0, 8)}]: ${task.slice(0, 500)}`;
        db.prepare(
          `INSERT INTO coord_mailbox (worker_name, workspace, message, source) VALUES (?, ?, ?, 'coordinator')`
        ).run(agent.name, agent.workspace, mailMsg);
        queued = true;
        coordLog(`mailbox/queue → ${agent.name}: assignment ${id.slice(0, 8)} (live push unavailable)`);
      }
    }

    // Log assignment with agent name
    if (agentId) {
      const agent = db.prepare(`SELECT name FROM coord_agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
      coordLog(`assigned → ${agent?.name ?? 'unknown'}: ${task.slice(0, 80)}${delivered ? ' (pushed+delivered)' : queued ? ' (queued to mailbox)' : ''}`);
    } else {
      coordLog(`assignment queued (pending): ${task.slice(0, 80)}`);
    }
    eventBus?.emit('assignment.created', { assignmentId: id, agentId: agentId ?? '', task, workspace: workspace ?? undefined });
    return reply.code(201).send({ assignmentId: id, status: agentId ? 'assigned' : 'pending', pushed, delivered, queued });
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

    // Cross-UUID fallback: if the agent has other UUIDs (e.g., from workspace changes or reconnects
    // that created a new row), check those too. This fixes the case where POST /assign resolved
    // worker_name to a different UUID than the one the worker is currently using.
    const agentRow = db.prepare(`SELECT name, workspace FROM coord_agents WHERE id = ?`).get(agentId) as { name: string; workspace: string | null } | undefined;
    if (agentRow) {
      const altIds = db.prepare(
        `SELECT id FROM coord_agents WHERE name = ? AND id != ? AND status != 'dead'`
      ).all(agentRow.name, agentId) as Array<{ id: string }>;

      for (const alt of altIds) {
        const altActive = db.prepare(
          `SELECT * FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at DESC LIMIT 1`
        ).get(alt.id) as Record<string, unknown> | undefined;
        if (altActive) {
          // Reassign to the current agent UUID so future lookups work directly
          db.prepare(`UPDATE coord_assignments SET agent_id = ? WHERE id = ?`).run(agentId, altActive.id as string);
          db.prepare(`UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`).run(altActive.id as string, agentId);
          altActive.agent_id = agentId;
          coordLog(`assignment ${(altActive.id as string).slice(0, 8)} migrated from alt UUID ${alt.id.slice(0, 8)} to ${agentId.slice(0, 8)} (same agent: ${agentRow.name})`);
          return reply.send({ assignment: altActive });
        }
      }
    }

    const agentWorkspace = agentRow?.workspace ?? null;

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
      `SELECT COUNT(*) as c FROM coord_agents WHERE status = 'working' AND last_seen > datetime('now', '-300 seconds')`
    ).get() as { c: number }).c;

    const retryAfter = busyCount > 0 ? 30 : 300;
    return reply.send({ assignment: null, retry_after_seconds: retryAfter });
  });

  app.post('/assignment/:id/claim', async (req, reply) => {
    const { id } = assignmentIdParamSchema.parse(req.params);
    const parsed = assignmentClaimSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { agentId } = parsed.data;

    if (!sessionTokenOk(db, agentId, req)) return reply.code(403).send({ error: 'invalid session token' });

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

  const VALID_TRANSITIONS: Record<string, string[]> = {
    assigned: ['in_progress', 'failed'],
    in_progress: ['completed', 'failed', 'blocked'],
    blocked: ['in_progress', 'failed'],
  };

  function handleAssignmentUpdate(id: string, status: string, result: string | undefined, commitSha: string | undefined): { error?: string } {
    // Status transition validation
    const current = db.prepare(`SELECT status FROM coord_assignments WHERE id = ?`).get(id) as { status: string } | undefined;
    if (!current) return { error: 'assignment not found' };

    const allowed = VALID_TRANSITIONS[current.status];
    if (allowed && !allowed.includes(status)) {
      return { error: `invalid transition: ${current.status} → ${status}. Valid: ${allowed.join(', ')}` };
    }
    if (!allowed && ['completed', 'failed'].includes(current.status)) {
      return { error: `cannot update ${current.status} assignment` };
    }

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

    // Atomic transaction: assignment update + agent status + event
    const updateTx = db.transaction(() => {
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
    });
    updateTx();

    // Log completion/failure with agent name and task (outside tx — read-only)
    const assignInfo = db.prepare(
      `SELECT a.agent_id, a.task, g.name AS agent_name FROM coord_assignments a LEFT JOIN coord_agents g ON a.agent_id = g.id WHERE a.id = ?`
    ).get(id) as { agent_id: string | null; task: string; agent_name: string | null } | undefined;
    if (['completed', 'failed'].includes(status)) {
      coordLog(`${assignInfo?.agent_name ?? 'unknown'} ${status}: ${assignInfo?.task?.slice(0, 80) ?? id}`);
    }

    // Emit events
    eventBus?.emit('assignment.updated', { assignmentId: id, agentId: assignInfo?.agent_id ?? null, status, result });
    if (status === 'completed') {
      eventBus?.emit('assignment.completed', { assignmentId: id, agentId: assignInfo?.agent_id ?? null, result: result ?? null });
    }

    // Auto-unblock: when an assignment completes, unblock any assignments that depend on it
    if (status === 'completed') {
      const blocked = db.prepare(
        `SELECT id, agent_id, task FROM coord_assignments WHERE blocked_by = ? AND status = 'blocked'`
      ).all(id) as Array<{ id: string; agent_id: string | null; task: string }>;

      if (blocked.length > 0) {
        const unblockTx = db.transaction(() => {
          for (const dep of blocked) {
            db.prepare(
              `UPDATE coord_assignments SET blocked_by = NULL, status = 'assigned' WHERE id = ?`
            ).run(dep.id);
            db.prepare(
              `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_unblocked', ?)`
            ).run(dep.agent_id, `unblocked by completion of ${id}: ${dep.task.slice(0, 80)}`);
          }
        });
        unblockTx();

        for (const dep of blocked) {
          coordLog(`auto-unblocked: ${dep.task.slice(0, 60)} (was blocked by ${id})`);
          eventBus?.emit('assignment.updated', { assignmentId: dep.id, agentId: dep.agent_id, status: 'assigned', result: undefined });
        }
      }
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

    // Verify targetAgentId exists
    if (targetAgentId) {
      const target = db.prepare(`SELECT id FROM coord_agents WHERE id = ?`).get(targetAgentId) as { id: string } | undefined;
      if (!target) return reply.code(404).send({ error: 'target agent not found' });
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

    if (!sessionTokenOk(db, agentId, req)) return reply.code(403).send({ error: 'invalid session token' });

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

    if (!sessionTokenOk(db, agentId, req)) return reply.code(403).send({ error: 'invalid session token' });

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
       ORDER BY l.locked_at DESC LIMIT 200`
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
        // Clear commands targeting this workspace AND global commands (workspace IS NULL).
        // Global commands (e.g. SHUTDOWN with no workspace) apply to all workspaces,
        // so RESUME for a workspace must also clear them — otherwise they persist forever.
        db.prepare(
          `UPDATE coord_commands SET cleared_at = datetime('now') WHERE cleared_at IS NULL AND (workspace = ? OR workspace IS NULL)`
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

    if (!sessionTokenOk(db, agentId, req)) return reply.code(403).send({ error: 'invalid session token' });

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
    const { since_id, assignment_id, workspace, limit } = q.success ? q.data : { since_id: 0, assignment_id: undefined, workspace: undefined, limit: 20 };

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

    if (workspace) {
      sql += ` AND (a.workspace = ? OR a.workspace IS NULL)`;
      params.push(workspace);
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

    if (!sessionTokenOk(db, agentId, req)) return reply.code(403).send({ error: 'invalid session token' });

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
       ORDER BY role, name LIMIT 200`
    ).all();

    const assignments = db.prepare(
      `SELECT a.id, a.task, a.description, a.status, a.agent_id, ag.name AS agent_name,
              a.created_at, a.started_at, a.completed_at
       FROM coord_assignments a LEFT JOIN coord_agents ag ON a.agent_id = ag.id
       WHERE a.status NOT IN ('completed', 'failed')
       ORDER BY a.created_at LIMIT 200`
    ).all();

    const locks = db.prepare(
      `SELECT l.file_path, l.agent_id, a.name AS agent_name, l.locked_at, l.reason
       FROM coord_locks l JOIN coord_agents a ON l.agent_id = a.id LIMIT 200`
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
           ORDER BY name LIMIT 200`
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
           ORDER BY name LIMIT 200`
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
      alive: w.seconds_since_seen < 300,
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
    const threshold = q.success ? q.data.seconds : 300;
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
    const threshold = q.success ? q.data.seconds : 300;

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

  // ─── Timeline ─────────────────────────────────────────────────────

  app.get('/timeline', async (req, reply) => {
    const q = timelineQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0].message });
    const { limit, since } = q.data;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (since) {
      conditions.push('e.created_at >= ?');
      params.push(since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const timeline = db.prepare(
      `SELECT e.created_at AS timestamp, a.name AS agent_name, e.event_type, e.detail,
              t.task AS assignment_task
       FROM coord_events e
       LEFT JOIN coord_agents a ON e.agent_id = a.id
       LEFT JOIN coord_assignments t ON a.current_task = t.id
       ${where}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`
    ).all(...params);

    return reply.send({ timeline });
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

  // ─── Prometheus Metrics ────────────────────────────────────────

  app.get('/metrics', async (_req, reply) => {
    const agentsByStatus = db.prepare(
      `SELECT status, COUNT(*) AS count FROM coord_agents GROUP BY status`
    ).all() as Array<{ status: string; count: number }>;

    const assignmentsByStatus = db.prepare(
      `SELECT status, COUNT(*) AS count FROM coord_assignments GROUP BY status`
    ).all() as Array<{ status: string; count: number }>;

    const locksActive = (db.prepare(
      `SELECT COUNT(*) AS count FROM coord_locks`
    ).get() as { count: number }).count;

    const findingsBySeverity = db.prepare(
      `SELECT severity, COUNT(*) AS count FROM coord_findings WHERE status = 'open' GROUP BY severity`
    ).all() as Array<{ severity: string; count: number }>;

    const eventsTotal = (db.prepare(
      `SELECT COUNT(*) AS count FROM coord_events`
    ).get() as { count: number }).count;

    const uptime = (db.prepare(
      `SELECT ROUND((julianday('now') - julianday(MIN(started_at))) * 86400) AS seconds FROM coord_agents WHERE status != 'dead'`
    ).get() as { seconds: number | null }).seconds ?? 0;

    const lines: string[] = [
      '# HELP coord_agents_total Number of agents by status',
      '# TYPE coord_agents_total gauge',
    ];
    for (const row of agentsByStatus) {
      lines.push(`coord_agents_total{status="${row.status}"} ${row.count}`);
    }

    lines.push('# HELP coord_assignments_total Number of assignments by status');
    lines.push('# TYPE coord_assignments_total gauge');
    for (const row of assignmentsByStatus) {
      lines.push(`coord_assignments_total{status="${row.status}"} ${row.count}`);
    }

    lines.push('# HELP coord_locks_active Number of active file locks');
    lines.push('# TYPE coord_locks_active gauge');
    lines.push(`coord_locks_active ${locksActive}`);

    lines.push('# HELP coord_findings_total Open findings by severity');
    lines.push('# TYPE coord_findings_total gauge');
    for (const row of findingsBySeverity) {
      lines.push(`coord_findings_total{severity="${row.severity}"} ${row.count}`);
    }

    lines.push('# HELP coord_events_total Total coordination events');
    lines.push('# TYPE coord_events_total counter');
    lines.push(`coord_events_total ${eventsTotal}`);

    lines.push('# HELP coord_uptime_seconds Seconds since first agent registered');
    lines.push('# TYPE coord_uptime_seconds gauge');
    lines.push(`coord_uptime_seconds ${uptime}`);

    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
  });

  // ─── Deep Health ───────────────────────────────────────────────

  app.get('/health/deep', async (_req, reply) => {
    const dbHealthy = store ? store.integrityCheck().ok : true;

    const agents = db.prepare(
      `SELECT COUNT(*) AS alive FROM coord_agents WHERE status != 'dead'`
    ).get() as { alive: number };

    const staleThreshold = 300;
    const staleCount = (db.prepare(
      `SELECT COUNT(*) AS c FROM coord_agents
       WHERE status != 'dead'
         AND (julianday('now') - julianday(last_seen)) * 86400 > ?`
    ).get(staleThreshold) as { c: number }).c;

    const pending = (db.prepare(
      `SELECT COUNT(*) AS c FROM coord_assignments WHERE status IN ('pending', 'assigned', 'in_progress')`
    ).get() as { c: number }).c;

    const uptimeRow = db.prepare(
      `SELECT ROUND((julianday('now') - julianday(MIN(started_at))) * 86400) AS s
       FROM coord_agents WHERE status != 'dead'`
    ).get() as { s: number | null };

    // WAL file size and autocheckpoint setting
    let walSizeBytes: number | null = null;
    let walAutocheckpoint: number | null = null;
    try {
      const fs = require('fs');
      const walPath = db.name + '-wal';
      const stat = fs.statSync(walPath);
      walSizeBytes = stat.size;
    } catch { /* WAL file may not exist */ }
    try {
      const acRow = db.pragma('wal_autocheckpoint') as Array<{ wal_autocheckpoint: number }>;
      walAutocheckpoint = acRow[0]?.wal_autocheckpoint ?? null;
    } catch { /* pragma read failed */ }

    const status = (!dbHealthy || staleCount > 2) ? 'degraded' : 'ok';

    return reply.send({
      status,
      db_healthy: dbHealthy,
      agents_alive: agents.alive,
      stale_agents: staleCount,
      pending_tasks: pending,
      uptime_seconds: uptimeRow.s ?? 0,
      wal_size_bytes: walSizeBytes,
      wal_autocheckpoint: walAutocheckpoint,
    });
  });

  // ─── Channel Sessions ───────────────────────────────────────────

  /** POST /channel/register — Register or update a channel session for an agent. */
  app.post('/channel/register', async (request, reply) => {
    const parsed = channelRegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { agentId, channelId } = parsed.data;

    const agent = db.prepare('SELECT id FROM coord_agents WHERE id = ?').get(agentId) as { id: string } | undefined;
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    db.prepare(`
      INSERT INTO coord_channel_sessions (agent_id, channel_id, connected_at, status)
      VALUES (?, ?, datetime('now'), 'connected')
      ON CONFLICT(agent_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        connected_at = datetime('now'),
        status = 'connected',
        push_count = 0,
        last_push_at = NULL
    `).run(agentId, channelId);

    db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'channel_register', ?)`).run(
      agentId, JSON.stringify({ channelId })
    );

    coordLog(`channel/register: ${agentId} → ${channelId}`);
    eventBus?.emit('session.started', { agentId, channelId });
    return reply.send({ ok: true });
  });

  /** DELETE /channel/register — Deregister a channel session for an agent. */
  app.delete('/channel/register', async (request, reply) => {
    const parsed = channelDeregisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { agentId } = parsed.data;

    const result = db.prepare('DELETE FROM coord_channel_sessions WHERE agent_id = ?').run(agentId);

    db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'channel_deregister', NULL)`).run(agentId);

    coordLog(`channel/deregister: ${agentId} (rows: ${result.changes})`);
    eventBus?.emit('session.closed', { agentId, channelId: '' });
    return reply.send({ ok: true });
  });

  /**
   * Deliver a message to a worker's channel HTTP endpoint.
   * Returns { delivered, error? }. On connection failure, marks session dead.
   */
  async function deliverToChannel(
    agentId: string, channelUrl: string, content: string, meta?: Record<string, string>
  ): Promise<{ delivered: boolean; error?: string }> {
    try {
      const res = await fetch(`${channelUrl}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, meta: meta ?? {} }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { delivered: false, error: `channel returned ${res.status}` };
      }
      return { delivered: true };
    } catch (err) {
      // Connection refused / timeout → worker process is dead, mark session disconnected
      db.prepare(
        `UPDATE coord_channel_sessions SET status = 'disconnected' WHERE agent_id = ?`
      ).run(agentId);
      const agent = db.prepare(`SELECT name FROM coord_agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
      coordLog(`channel/deliver FAILED → ${agent?.name ?? agentId}: ${err instanceof Error ? err.message : err} — session marked disconnected`);
      return { delivered: false, error: `worker unreachable: ${err instanceof Error ? err.message : err}` };
    }
  }

  /** POST /channel/push — Push a message to an agent. Tries live delivery first, falls back to mailbox queue. */
  app.post('/channel/push', async (request, reply) => {
    const parsed = channelPushSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { agentId, message } = parsed.data;

    const agent = db.prepare(`SELECT name, workspace FROM coord_agents WHERE id = ?`).get(agentId) as { name: string; workspace: string | null } | undefined;
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    // Try live channel delivery first
    const session = db.prepare(
      `SELECT agent_id, channel_id FROM coord_channel_sessions WHERE agent_id = ? AND status = 'connected'`
    ).get(agentId) as { agent_id: string; channel_id: string } | undefined;

    if (session) {
      const { delivered } = await deliverToChannel(
        agentId, session.channel_id, message,
        { source: 'coordinator', agent: agent.name }
      );

      if (delivered) {
        db.prepare(
          `UPDATE coord_channel_sessions SET last_push_at = datetime('now'), push_count = push_count + 1 WHERE agent_id = ?`
        ).run(agentId);
        db.prepare(
          `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'channel_push', ?)`
        ).run(agentId, message.slice(0, 500));
        coordLog(`channel/push → ${agent.name}: ${message.slice(0, 80)}`);
        return reply.send({ ok: true, delivered: true, channelId: session.channel_id });
      }
      // Live delivery failed — fall through to mailbox
    }

    // Queue to mailbox (delivered on next /next poll)
    db.prepare(
      `INSERT INTO coord_mailbox (worker_name, workspace, message, source) VALUES (?, ?, ?, 'coordinator')`
    ).run(agent.name, agent.workspace, message);
    db.prepare(
      `INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'mailbox_queued', ?)`
    ).run(agentId, `queued for ${agent.name}: ${message.slice(0, 200)}`);
    coordLog(`mailbox/queue → ${agent.name}: ${message.slice(0, 80)} (live delivery unavailable)`);
    return reply.send({ ok: true, delivered: false, queued: true, hint: 'Message queued in mailbox — will be delivered on next /next poll' });
  });

  /** GET /channel/sessions — List all active channel sessions with agent names. */
  app.get('/channel/sessions', async (_request, reply) => {
    const sessions = db.prepare(`
      SELECT cs.agent_id, a.name AS agent_name, cs.channel_id,
             cs.connected_at, cs.last_push_at, cs.push_count, cs.status
      FROM coord_channel_sessions cs
      JOIN coord_agents a ON a.id = cs.agent_id
      WHERE cs.status = 'connected'
      ORDER BY cs.connected_at DESC
    `).all();

    return reply.send({ sessions });
  });

  /** POST /channel/probe — Probe all connected channel sessions, mark dead ones as disconnected. */
  app.post('/channel/probe', async (_request, reply) => {
    const sessions = db.prepare(
      `SELECT cs.agent_id, a.name AS agent_name, cs.channel_id
       FROM coord_channel_sessions cs
       JOIN coord_agents a ON a.id = cs.agent_id
       WHERE cs.status = 'connected'`
    ).all() as Array<{ agent_id: string; agent_name: string; channel_id: string }>;

    const results: Array<{ agent: string; alive: boolean; error?: string }> = [];

    for (const session of sessions) {
      try {
        const res = await fetch(`${session.channel_id}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          results.push({ agent: session.agent_name, alive: true });
        } else {
          db.prepare(`UPDATE coord_channel_sessions SET status = 'disconnected' WHERE agent_id = ?`).run(session.agent_id);
          results.push({ agent: session.agent_name, alive: false, error: `health returned ${res.status}` });
        }
      } catch (err) {
        db.prepare(`UPDATE coord_channel_sessions SET status = 'disconnected' WHERE agent_id = ?`).run(session.agent_id);
        results.push({ agent: session.agent_name, alive: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const alive = results.filter(r => r.alive).length;
    const dead = results.filter(r => !r.alive).length;
    if (dead > 0) coordLog(`channel/probe: ${alive} alive, ${dead} dead — dead sessions marked disconnected`);

    return reply.send({ probed: results.length, alive, dead, results });
  });
}
