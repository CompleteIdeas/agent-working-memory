// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * MCP tool definitions for the coordination module.
 * 13 coord_* tools — only registered when AWM_COORDINATION=true.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { detectStale, cleanupStale } from './stale.js';

export function registerCoordinationTools(server: McpServer, db: Database.Database): void {

  // ─── coord_checkin ──────────────────────────────────────────────
  server.tool(
    'coord_checkin',
    'Register or heartbeat an agent in the hive. Call at session start and periodically.',
    {
      agent_name: z.string().min(1).max(50).describe('Your agent name (e.g. "Worker-A", "Dev-Lead")'),
      role: z.enum(['worker', 'orchestrator', 'dev-lead']).default('worker').describe('Agent role'),
      pid: z.number().int().positive().optional().describe('Process ID'),
      capabilities: z.array(z.string()).optional().describe('What this agent can do'),
      workspace: z.string().max(50).optional().describe('Project workspace scope'),
    },
    async ({ agent_name, role, pid, capabilities, workspace }) => {
      const capsJson = capabilities ? JSON.stringify(capabilities) : null;

      // Look up ANY existing agent with same name+workspace — including dead ones (upsert, reuse UUID)
      const existing = workspace
        ? db.prepare(`SELECT id, status FROM coord_agents WHERE name = ? AND workspace = ? ORDER BY last_seen DESC LIMIT 1`).get(agent_name, workspace) as { id: string; status: string } | undefined
        : db.prepare(`SELECT id, status FROM coord_agents WHERE name = ? AND workspace IS NULL ORDER BY last_seen DESC LIMIT 1`).get(agent_name) as { id: string; status: string } | undefined;

      if (existing) {
        const wasDead = existing.status === 'dead';
        db.prepare(`UPDATE coord_agents SET last_seen = datetime('now'), status = CASE WHEN status = 'dead' THEN 'idle' ELSE status END, pid = COALESCE(?, pid), capabilities = COALESCE(?, capabilities) WHERE id = ?`).run(pid ?? null, capsJson, existing.id);
        const action = wasDead ? 'reconnected' : 'heartbeat';
        const eventType = wasDead ? 'reconnected' : 'heartbeat';
        const detail = wasDead ? `${agent_name} reconnected via MCP (was dead)` : `heartbeat from ${agent_name}`;
        db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, ?, ?)`).run(existing.id, eventType, detail);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ agentId: existing.id, action, status: wasDead ? 'idle' : existing.status }) }] };
      }

      const id = randomUUID();
      db.prepare(`INSERT INTO coord_agents (id, name, role, pid, status, metadata, capabilities, workspace) VALUES (?, ?, ?, ?, 'idle', NULL, ?, ?)`).run(id, agent_name, role, pid ?? null, capsJson, workspace ?? null);
      db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'registered', ?)`).run(id, `${agent_name} joined as ${role}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ agentId: id, action: 'registered', status: 'idle' }) }] };
    }
  );

  // ─── coord_checkout ─────────────────────────────────────────────
  server.tool(
    'coord_checkout',
    'Sign off from the hive. Releases all locks and marks agent as dead. Call at session end.',
    {
      agent_id: z.string().uuid().describe('Your agent ID from coord_checkin'),
    },
    async ({ agent_id }) => {
      db.prepare(`DELETE FROM coord_locks WHERE agent_id = ?`).run(agent_id);
      db.prepare(`UPDATE coord_agents SET status = 'dead', last_seen = datetime('now') WHERE id = ?`).run(agent_id);
      db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'checkout', 'agent signed off')`).run(agent_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
    }
  );

  // ─── coord_assign ───────────────────────────────────────────────
  server.tool(
    'coord_assign',
    'Create a task assignment. Orchestrator uses this to dispatch work to agents.',
    {
      task: z.string().min(1).max(1000).describe('Task title/summary'),
      description: z.string().max(5000).optional().describe('Detailed task description'),
      agent_id: z.string().uuid().optional().describe('Assign directly to this agent (optional)'),
      workspace: z.string().max(50).optional().describe('Workspace scope'),
    },
    async ({ task, description, agent_id, workspace }) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO coord_assignments (id, agent_id, task, description, status, workspace) VALUES (?, ?, ?, ?, ?, ?)`).run(id, agent_id ?? null, task, description ?? null, agent_id ? 'assigned' : 'pending', workspace ?? null);

      if (agent_id) {
        db.prepare(`UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`).run(id, agent_id);
      }

      db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_created', ?)`).run(agent_id ?? null, `task: ${task}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ assignmentId: id, status: agent_id ? 'assigned' : 'pending' }) }] };
    }
  );

  // ─── coord_assignment ───────────────────────────────────────────
  server.tool(
    'coord_assignment',
    'Get your current assignment, or auto-claim the next pending task. Call this to find out what to work on.',
    {
      agent_id: z.string().uuid().describe('Your agent ID'),
    },
    async ({ agent_id }) => {
      const active = db.prepare(`SELECT * FROM coord_assignments WHERE agent_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at DESC LIMIT 1`).get(agent_id);
      if (active) return { content: [{ type: 'text' as const, text: JSON.stringify({ assignment: active }) }] };

      const agentRow = db.prepare(`SELECT workspace FROM coord_agents WHERE id = ?`).get(agent_id) as { workspace: string | null } | undefined;
      const ws = agentRow?.workspace;

      const pending = ws
        ? db.prepare(`SELECT * FROM coord_assignments WHERE status = 'pending' AND (workspace = ? OR workspace IS NULL) ORDER BY created_at ASC LIMIT 1`).get(ws) as { id: string } | undefined
        : db.prepare(`SELECT * FROM coord_assignments WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`).get() as { id: string } | undefined;

      if (pending) {
        const claimed = db.prepare(`UPDATE coord_assignments SET agent_id = ?, status = 'assigned', started_at = datetime('now') WHERE id = ? AND status = 'pending'`).run(agent_id, pending.id);
        if (claimed.changes > 0) {
          db.prepare(`UPDATE coord_agents SET status = 'working', current_task = ? WHERE id = ?`).run(pending.id, agent_id);
          db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'assignment_claimed', ?)`).run(agent_id, `auto-claimed ${pending.id}`);
          const assignment = db.prepare(`SELECT * FROM coord_assignments WHERE id = ?`).get(pending.id);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ assignment }) }] };
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ assignment: null, retry_after_seconds: 30 }) }] };
    }
  );

  // ─── coord_assignment_update ────────────────────────────────────
  server.tool(
    'coord_assignment_update',
    'Report progress or completion of an assignment. Set status to in_progress, completed, failed, or blocked.',
    {
      assignment_id: z.string().uuid().describe('The assignment ID'),
      status: z.enum(['in_progress', 'completed', 'failed', 'blocked']).describe('New status'),
      result: z.string().max(10000).optional().describe('Result summary or error message'),
    },
    async ({ assignment_id, status, result }) => {
      if (['completed', 'failed'].includes(status)) {
        db.prepare(`UPDATE coord_assignments SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`).run(status, result ?? null, assignment_id);
        const assignment = db.prepare(`SELECT agent_id FROM coord_assignments WHERE id = ?`).get(assignment_id) as { agent_id: string } | undefined;
        if (assignment?.agent_id) {
          db.prepare(`UPDATE coord_agents SET status = 'idle', current_task = NULL WHERE id = ?`).run(assignment.agent_id);
        }
      } else {
        db.prepare(`UPDATE coord_assignments SET status = ?, result = ? WHERE id = ?`).run(status, result ?? null, assignment_id);
      }

      db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES ((SELECT agent_id FROM coord_assignments WHERE id = ?), 'assignment_update', ?)`).run(assignment_id, `${assignment_id} → ${status}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
    }
  );

  // ─── coord_lock ─────────────────────────────────────────────────
  server.tool(
    'coord_lock',
    'Acquire a file lock to prevent concurrent edits by other agents.',
    {
      agent_id: z.string().uuid().describe('Your agent ID'),
      file_path: z.string().min(1).max(500).describe('Path to lock'),
      reason: z.string().max(500).optional().describe('Why you need this lock'),
    },
    async ({ agent_id, file_path, reason }) => {
      const inserted = db.prepare(`INSERT OR IGNORE INTO coord_locks (file_path, agent_id, reason) VALUES (?, ?, ?)`).run(file_path, agent_id, reason ?? null);

      if (inserted.changes > 0) {
        db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'lock_acquired', ?)`).run(agent_id, file_path);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, action: 'acquired' }) }] };
      }

      const existing = db.prepare(`SELECT agent_id FROM coord_locks WHERE file_path = ?`).get(file_path) as { agent_id: string } | undefined;
      if (existing?.agent_id === agent_id) {
        db.prepare(`UPDATE coord_locks SET locked_at = datetime('now') WHERE file_path = ?`).run(file_path);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, action: 'refreshed' }) }] };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'file locked by another agent', lockedBy: existing?.agent_id }) }] };
    }
  );

  // ─── coord_unlock ───────────────────────────────────────────────
  server.tool(
    'coord_unlock',
    'Release a file lock you hold.',
    {
      agent_id: z.string().uuid().describe('Your agent ID'),
      file_path: z.string().min(1).max(500).describe('Path to unlock'),
    },
    async ({ agent_id, file_path }) => {
      const result = db.prepare(`DELETE FROM coord_locks WHERE file_path = ? AND agent_id = ?`).run(file_path, agent_id);
      if (result.changes === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'lock not found or not owned' }) }] };
      }
      db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'lock_released', ?)`).run(agent_id, file_path);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
    }
  );

  // ─── coord_locks ────────────────────────────────────────────────
  server.tool(
    'coord_locks',
    'List all currently held file locks across all agents.',
    {},
    async () => {
      const locks = db.prepare(
        `SELECT l.file_path, l.agent_id, a.name AS agent_name, l.locked_at, l.reason
         FROM coord_locks l JOIN coord_agents a ON l.agent_id = a.id
         ORDER BY l.locked_at DESC`
      ).all();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ locks }) }] };
    }
  );

  // ─── coord_command ──────────────────────────────────────────────
  server.tool(
    'coord_command',
    'Issue a broadcast command to all agents. Orchestrator only. Commands: BUILD_FREEZE, PAUSE, RESUME, SHUTDOWN.',
    {
      command: z.enum(['BUILD_FREEZE', 'PAUSE', 'RESUME', 'SHUTDOWN']).describe('Command to broadcast'),
      reason: z.string().max(1000).optional().describe('Why this command is being issued'),
      workspace: z.string().max(50).optional().describe('Scope to workspace (optional)'),
    },
    async ({ command, reason, workspace }) => {
      if (command === 'RESUME') {
        if (workspace) {
          db.prepare(`UPDATE coord_commands SET cleared_at = datetime('now') WHERE cleared_at IS NULL AND workspace = ?`).run(workspace);
        } else {
          db.prepare(`UPDATE coord_commands SET cleared_at = datetime('now') WHERE cleared_at IS NULL`).run();
        }
        db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (NULL, 'command', ?)`).run(`RESUME — commands cleared`);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, command: 'RESUME' }) }] };
      }

      db.prepare(`INSERT INTO coord_commands (command, reason, issued_by, workspace) VALUES (?, ?, NULL, ?)`).run(command, reason ?? null, workspace ?? null);
      db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (NULL, 'command', ?)`).run(`${command}: ${reason ?? 'no reason'}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, command, reason }) }] };
    }
  );

  // ─── coord_command_poll ─────────────────────────────────────────
  server.tool(
    'coord_command_poll',
    'Check for active commands from the orchestrator. Call periodically to stay responsive to BUILD_FREEZE, PAUSE, etc.',
    {
      workspace: z.string().max(50).optional().describe('Filter by workspace'),
    },
    async ({ workspace }) => {
      const active = workspace
        ? db.prepare(`SELECT id, command, reason, issued_at FROM coord_commands WHERE cleared_at IS NULL AND (workspace = ? OR workspace IS NULL) ORDER BY issued_at DESC`).all(workspace)
        : db.prepare(`SELECT id, command, reason, issued_at FROM coord_commands WHERE cleared_at IS NULL ORDER BY issued_at DESC`).all();

      if (active.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ active: false, commands: [] }) }] };
      }

      const priority: Record<string, number> = { SHUTDOWN: 3, BUILD_FREEZE: 2, PAUSE: 1 };
      (active as Array<{ command: string }>).sort((a, b) => (priority[b.command] ?? 0) - (priority[a.command] ?? 0));

      return { content: [{ type: 'text' as const, text: JSON.stringify({ active: true, command: (active[0] as { command: string }).command, commands: active }) }] };
    }
  );

  // ─── coord_workers ──────────────────────────────────────────────
  server.tool(
    'coord_workers',
    'List available workers in the hive. Filterable by capability, status, and workspace.',
    {
      capability: z.string().max(50).optional().describe('Filter by capability'),
      status: z.enum(['idle', 'working', 'dead']).optional().describe('Filter by status'),
      workspace: z.string().max(50).optional().describe('Filter by workspace'),
    },
    async ({ capability, status: filterStatus, workspace }) => {
      let workers = (workspace
        ? db.prepare(`SELECT id, name, role, status, current_task, capabilities, workspace, last_seen, ROUND((julianday('now') - julianday(last_seen)) * 86400) AS seconds_since_seen FROM coord_agents WHERE status != 'dead' AND role != 'orchestrator' AND workspace = ? ORDER BY name`).all(workspace)
        : db.prepare(`SELECT id, name, role, status, current_task, capabilities, workspace, last_seen, ROUND((julianday('now') - julianday(last_seen)) * 86400) AS seconds_since_seen FROM coord_agents WHERE status != 'dead' AND role != 'orchestrator' ORDER BY name`).all()
      ) as Array<{ id: string; name: string; role: string; status: string; current_task: string | null; capabilities: string | null; workspace: string | null; last_seen: string; seconds_since_seen: number }>;

      if (capability) {
        workers = workers.filter(w => {
          try { return w.capabilities ? (JSON.parse(w.capabilities) as string[]).includes(capability) : false; } catch { return false; }
        });
      }
      if (filterStatus) workers = workers.filter(w => w.status === filterStatus);

      const result = workers.map(w => ({ ...w, capabilities: w.capabilities ? JSON.parse(w.capabilities) : [], alive: w.seconds_since_seen < 120 }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ count: result.length, idle: result.filter(w => w.status === 'idle').length, working: result.filter(w => w.status === 'working').length, workers: result }) }] };
    }
  );

  // ─── coord_finding ──────────────────────────────────────────────
  server.tool(
    'coord_finding',
    'Report a finding (bug, issue, suggestion) discovered during work.',
    {
      agent_id: z.string().uuid().describe('Your agent ID'),
      category: z.enum(['typecheck', 'lint', 'test-failure', 'security', 'performance', 'dead-code', 'todo', 'bug', 'ux', 'a11y', 'sql', 'convention', 'freshdesk', 'data-quality', 'other']).describe('Finding category'),
      severity: z.enum(['critical', 'error', 'warn', 'info']).default('info').describe('Severity level'),
      description: z.string().min(1).max(5000).describe('What you found'),
      file_path: z.string().max(500).optional().describe('File where the finding is'),
      suggestion: z.string().max(5000).optional().describe('Suggested fix'),
    },
    async ({ agent_id, category, severity, description, file_path, suggestion }) => {
      db.prepare(`INSERT INTO coord_findings (agent_id, category, severity, file_path, description, suggestion) VALUES (?, ?, ?, ?, ?, ?)`).run(agent_id, category, severity, file_path ?? null, description, suggestion ?? null);
      db.prepare(`INSERT INTO coord_events (agent_id, event_type, detail) VALUES (?, 'finding', ?)`).run(agent_id, `[${severity}] ${category}: ${description.slice(0, 100)}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
    }
  );

  // ─── coord_status ───────────────────────────────────────────────
  server.tool(
    'coord_status',
    'Get a full dashboard view of the hive: agents, assignments, locks, findings, and stats.',
    {},
    async () => {
      const agents = db.prepare(`SELECT id, name, role, status, current_task, last_seen, ROUND((julianday('now') - julianday(last_seen)) * 86400) AS seconds_since_seen FROM coord_agents WHERE status != 'dead' ORDER BY role, name`).all();
      const assignments = db.prepare(`SELECT a.id, a.task, a.status, a.agent_id, ag.name AS agent_name, a.created_at FROM coord_assignments a LEFT JOIN coord_agents ag ON a.agent_id = ag.id WHERE a.status NOT IN ('completed', 'failed') ORDER BY a.created_at`).all();
      const locks = db.prepare(`SELECT l.file_path, l.agent_id, a.name AS agent_name, l.locked_at FROM coord_locks l JOIN coord_agents a ON l.agent_id = a.id`).all();
      const stats = db.prepare(`SELECT (SELECT COUNT(*) FROM coord_agents WHERE status != 'dead') AS alive_agents, (SELECT COUNT(*) FROM coord_agents WHERE status = 'working') AS busy_agents, (SELECT COUNT(*) FROM coord_assignments WHERE status = 'pending') AS pending_tasks, (SELECT COUNT(*) FROM coord_locks) AS active_locks, (SELECT COUNT(*) FROM coord_findings WHERE status = 'open') AS open_findings`).get();

      return { content: [{ type: 'text' as const, text: JSON.stringify({ agents, assignments, locks, stats }) }] };
    }
  );

  console.error('AWM: coordination MCP tools registered (13 coord_* tools)');
}
