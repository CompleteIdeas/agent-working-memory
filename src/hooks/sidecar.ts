// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Hook Sidecar — lightweight HTTP server that runs alongside the MCP process.
 *
 * Claude Code hooks (PreCompact, SessionEnd, etc.) send POST requests here.
 * Since we share the same process as the MCP server, there's zero SQLite
 * contention — we use the same store/engines directly.
 *
 * Endpoints:
 *   POST /hooks/checkpoint   — auto-checkpoint (called by PreCompact, SessionEnd hooks)
 *   GET  /health             — health check
 *
 * Security:
 *   - Binds to 127.0.0.1 only (localhost)
 *   - Bearer token auth via AWM_HOOK_SECRET
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import type { EngramStore } from '../storage/sqlite.js';
import type { ConsciousState } from '../types/checkpoint.js';
import { log, getLogPath } from '../core/logger.js';

export interface SidecarDeps {
  store: EngramStore;
  agentId: string;
  secret: string | null;
  port: number;
  onConsolidate?: (agentId: string, reason: string) => void;
}

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface TranscriptContext {
  currentTask: string;
  activeFiles: string[];
  recentTools: string[];
  lastUserMessage: string;
}

/**
 * Parse the Claude Code transcript to extract context for auto-checkpointing.
 * Reads the JSONL transcript file and extracts recent tool calls, files, and user messages.
 */
function parseTranscript(transcriptPath: string): TranscriptContext {
  const ctx: TranscriptContext = {
    currentTask: '',
    activeFiles: [],
    recentTools: [],
    lastUserMessage: '',
  };

  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    const files = new Set<string>();
    const tools: string[] = [];
    let lastUserMsg = '';

    // Parse last 100 lines max to avoid huge transcripts
    const recent = lines.slice(-100);

    for (const line of recent) {
      try {
        const entry = JSON.parse(line);

        // Extract user messages
        if (entry.role === 'user' && typeof entry.content === 'string') {
          lastUserMsg = entry.content.slice(0, 200);
        }
        if (entry.role === 'user' && Array.isArray(entry.content)) {
          for (const part of entry.content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              lastUserMsg = part.text.slice(0, 200);
            }
          }
        }

        // Extract tool uses
        if (entry.role === 'assistant' && Array.isArray(entry.content)) {
          for (const part of entry.content) {
            if (part.type === 'tool_use') {
              tools.push(part.name);
              // Extract file paths from tool inputs
              const input = part.input;
              if (input?.file_path) files.add(String(input.file_path));
              if (input?.path) files.add(String(input.path));
              if (input?.command && typeof input.command === 'string') {
                // Try to extract file paths from bash commands
                const pathMatch = input.command.match(/["']?([A-Z]:[/\\][^"'\s]+|\/[^\s"']+\.\w+)["']?/g);
                if (pathMatch) pathMatch.forEach((p: string) => files.add(p.replace(/["']/g, '')));
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    ctx.lastUserMessage = lastUserMsg;
    ctx.activeFiles = [...files].slice(-20); // Last 20 unique files
    ctx.recentTools = tools.slice(-30); // Last 30 tool calls
    ctx.currentTask = lastUserMsg || 'Unknown task (auto-checkpoint)';
  } catch {
    ctx.currentTask = 'Auto-checkpoint (transcript unavailable)';
  }

  return ctx;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const AUTO_CHECKPOINT_INTERVAL_MS = 15 * 60_000; // 15 minutes

export function startSidecar(deps: SidecarDeps): { close: () => void } {
  const { store, agentId, secret, port, onConsolidate } = deps;

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — no auth required
    if (req.url === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok', sidecar: true, agentId });
      return;
    }

    // Auth check
    if (secret) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${secret}`) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    // GET /stats — daily activity counts from the log (no auth required)
    if (req.url === '/stats' && req.method === 'GET') {
      try {
        const lp = getLogPath();
        if (!lp || !existsSync(lp)) {
          json(res, 200, { error: 'No log file', writes: 0, recalls: 0, restores: 0, hooks: 0, total: 0 });
          return;
        }
        const raw = readFileSync(lp, 'utf-8');
        const today = new Date().toISOString().slice(0, 10);
        const todayLines = raw.split('\n').filter(l => l.startsWith(today));
        let writes = 0, recalls = 0, restores = 0, hooks = 0, checkpoints = 0;
        for (const line of todayLines) {
          if (line.includes('| write:')) writes++;
          else if (line.includes('| recall')) recalls++;
          else if (line.includes('| restore')) restores++;
          else if (line.includes('| hook:')) hooks++;
          else if (line.includes('| checkpoint')) checkpoints++;
        }
        const total = writes + recalls + restores + hooks + checkpoints;
        json(res, 200, { date: today, agentId, writes, recalls, restores, hooks, checkpoints, total });
      } catch {
        json(res, 500, { error: 'Failed to read log' });
      }
      return;
    }

    // POST /hooks/checkpoint — auto-checkpoint from hook events
    if (req.url === '/hooks/checkpoint' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const hookInput: HookInput = body ? JSON.parse(body) : {};
        const event = hookInput.hook_event_name ?? 'unknown';

        // Parse transcript for rich context
        let ctx: TranscriptContext | null = null;
        if (hookInput.transcript_path) {
          ctx = parseTranscript(hookInput.transcript_path);
        }

        // Build checkpoint state
        const state: ConsciousState = {
          currentTask: ctx?.currentTask ?? `Auto-checkpoint (${event})`,
          decisions: [],
          activeFiles: ctx?.activeFiles ?? [],
          nextSteps: [],
          relatedMemoryIds: [],
          notes: `Auto-saved by ${event} hook.${ctx?.recentTools.length ? ` Recent tools: ${[...new Set(ctx.recentTools)].join(', ')}` : ''}`,
          episodeId: null,
        };

        store.saveCheckpoint(agentId, state);
        log(agentId, `hook:${event}`, `auto-checkpoint files=${state.activeFiles.length} task="${state.currentTask.slice(0, 80)}"`);

        // On SessionEnd: run full consolidation (sleep cycle) before process dies
        let consolidated = false;
        if (event === 'SessionEnd' && onConsolidate) {
          try {
            onConsolidate(agentId, `SessionEnd hook (graceful exit)`);
            consolidated = true;
            log(agentId, 'consolidation', 'full sleep cycle on graceful exit');
          } catch { /* consolidation failure is non-fatal */ }
        }

        // Return context for Claude (stdout from hooks is visible)
        json(res, 200, {
          status: 'checkpointed',
          event,
          task: state.currentTask,
          files: state.activeFiles.length,
          consolidated,
        });
      } catch (err) {
        json(res, 500, { error: 'Checkpoint failed', detail: String(err) });
      }
      return;
    }

    // 404
    json(res, 404, { error: 'Not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`AWM hook sidecar listening on 127.0.0.1:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`AWM hook sidecar: port ${port} in use, hooks disabled`);
    } else {
      console.error('AWM hook sidecar error:', err.message);
    }
  });

  // --- Silent auto-checkpoint every 15 minutes ---
  const autoCheckpointTimer = setInterval(() => {
    try {
      const checkpoint = store.getCheckpoint(agentId);
      if (!checkpoint) return; // No state to save yet

      // Only checkpoint if there's been activity since last auto-checkpoint
      const lastActivity = checkpoint.auto.lastActivityAt?.getTime() ?? 0;
      const sinceActivity = Date.now() - lastActivity;
      if (sinceActivity > AUTO_CHECKPOINT_INTERVAL_MS) return; // Idle — skip

      const state: ConsciousState = {
        currentTask: checkpoint.executionState?.currentTask ?? 'Active session (auto-checkpoint)',
        decisions: checkpoint.executionState?.decisions ?? [],
        activeFiles: checkpoint.executionState?.activeFiles ?? [],
        nextSteps: checkpoint.executionState?.nextSteps ?? [],
        relatedMemoryIds: checkpoint.executionState?.relatedMemoryIds ?? [],
        notes: `Auto-checkpoint (15min timer). Last activity: ${Math.round(sinceActivity / 60_000)}min ago.`,
        episodeId: checkpoint.executionState?.episodeId ?? null,
      };

      store.saveCheckpoint(agentId, state);
      log(agentId, 'hook:timer', `auto-checkpoint (${Math.round(sinceActivity / 60_000)}min since activity)`);
    } catch { /* timer failure is non-fatal */ }
  }, AUTO_CHECKPOINT_INTERVAL_MS);

  return {
    close: () => {
      clearInterval(autoCheckpointTimer);
      server.close();
    },
  };
}
