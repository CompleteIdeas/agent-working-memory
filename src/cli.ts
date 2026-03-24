#!/usr/bin/env node
// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI entrypoint for AgentWorkingMemory.
 *
 * Commands:
 *   awm setup    — configure MCP for the current project
 *   awm mcp      — start the MCP server (called by Claude Code)
 *   awm serve    — start the HTTP API server
 *   awm health   — check if a running server is healthy
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename, join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir as osHomedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env if present
try {
  const envPath = resolve(process.cwd(), '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* No .env file */ }

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
AgentWorkingMemory — Cognitive memory for AI agents

Usage:
  awm setup [--global] [--agent-id <id>] [--db-path <path>] [--no-claude-md]
            [--no-hooks] [--hook-port <port>]       Configure MCP for Claude Code
  awm mcp                                           Start MCP server (used by Claude Code)
  awm serve [--port <port>]                         Start HTTP API server
  awm health [--port <port>]                        Check server health
  awm export --db <path> [--agent <id>] [--output <file>] [--active-only]
                                                    Export memories to JSON
  awm import <file> --db <path> [--remap-agent <id>] [--dedupe] [--dry-run]
                                                    Import memories from JSON

Setup:
  awm setup --global     Recommended. Writes ~/.mcp.json so AWM is available
                         in every project — one brain across all your work.

  awm setup              Project-level. Writes .mcp.json in the current directory
                         and appends workflow instructions to CLAUDE.md.

  --no-claude-md    Skip CLAUDE.md modification
  --no-hooks        Skip hook installation (no auto-checkpoint)
  --hook-port PORT  Sidecar port for hooks (default: 8401)

  Restart Claude Code after setup to pick up the new MCP server.
`.trim());
}

// ─── SETUP ──────────────────────────────────────

function setup() {
  const cwd = process.cwd();
  const projectName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Parse flags
  let agentId = projectName;
  let dbPath: string | null = null;
  let skipClaudeMd = false;
  let isGlobal = false;
  let skipHooks = false;
  let hookPort = '8401';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--agent-id' && args[i + 1]) {
      agentId = args[++i];
    } else if (args[i] === '--db-path' && args[i + 1]) {
      dbPath = args[++i];
    } else if (args[i] === '--no-claude-md') {
      skipClaudeMd = true;
    } else if (args[i] === '--no-hooks') {
      skipHooks = true;
    } else if (args[i] === '--hook-port' && args[i + 1]) {
      hookPort = args[++i];
    } else if (args[i] === '--global') {
      isGlobal = true;
      agentId = 'claude'; // unified agent ID for global setup
    }
  }

  // Find the package root (where src/mcp.ts lives)
  const packageRoot = resolve(__dirname, '..');
  const mcpScript = join(packageRoot, 'src', 'mcp.ts');
  const mcpDist = join(packageRoot, 'dist', 'mcp.js');

  // Determine DB path — default to <awm-root>/data/memory.db (shared across projects)
  if (!dbPath) {
    dbPath = join(packageRoot, 'data', 'memory.db');
  }
  const dbDir = dirname(dbPath);

  // Ensure data directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    console.log(`Created data directory: ${dbDir}`);
  }

  // Generate hook secret (or reuse existing one)
  let hookSecret = '';
  const secretPath = join(dirname(dbPath!), '.awm-hook-secret');
  if (existsSync(secretPath)) {
    hookSecret = readFileSync(secretPath, 'utf-8').trim();
  }
  if (!hookSecret) {
    hookSecret = randomBytes(32).toString('hex');
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, hookSecret + '\n');
  }

  // Determine command based on platform and whether dist exists
  const isWindows = process.platform === 'win32';
  const hasDist = existsSync(mcpDist);

  const envVars: Record<string, string> = {
    AWM_DB_PATH: (isWindows ? dbPath!.replace(/\\/g, '/') : dbPath!),
    AWM_AGENT_ID: agentId,
    AWM_HOOK_PORT: hookPort,
    AWM_HOOK_SECRET: hookSecret,
  };

  let mcpConfig: { command: string; args: string[]; env: Record<string, string> };

  if (hasDist) {
    mcpConfig = {
      command: 'node',
      args: [mcpDist.replace(/\\/g, '/')],
      env: envVars,
    };
  } else if (isWindows) {
    mcpConfig = {
      command: 'cmd',
      args: ['/c', 'npx', 'tsx', mcpScript.replace(/\\/g, '/')],
      env: envVars,
    };
  } else {
    mcpConfig = {
      command: 'npx',
      args: ['tsx', mcpScript],
      env: envVars,
    };
  }

  // Read or create .mcp.json
  const mcpJsonPath = isGlobal ? join(osHomedir(), '.mcp.json') : join(cwd, '.mcp.json');
  let existing: any = { mcpServers: {} };
  if (existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (!existing.mcpServers) existing.mcpServers = {};
    } catch {
      existing = { mcpServers: {} };
    }
  }

  existing.mcpServers['agent-working-memory'] = mcpConfig;
  writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');

  // Auto-append CLAUDE.md snippet unless --no-claude-md
  let claudeMdAction = '';
  const claudeMdSnippet = `

## Memory (AWM)
You have persistent memory via the agent-working-memory MCP server.

### Lifecycle (always do these)
- Session start: call memory_restore to recover previous context
- Starting a task: call memory_task_begin (checkpoints + recalls relevant memories)
- Finishing a task: call memory_task_end with a summary
- Auto-checkpoint: hooks handle compaction, session end, and 15-min timer (no action needed)

### Write memory when:
- A project decision is made or changed
- A root cause is discovered after debugging
- A reusable implementation pattern is established
- A user preference, constraint, or requirement is clarified
- A prior assumption is found to be wrong
- A significant piece of work is completed

### Recall memory when:
- Starting work on a new task or subsystem
- Re-entering code you haven't touched recently
- After a failed attempt — check if there's prior knowledge
- Before refactoring or making architectural changes
- When a topic comes up that you might have prior context on

### Also:
- After using a recalled memory: call memory_feedback (useful/not-useful)
- To correct wrong info: call memory_retract
- To track work items: memory_task_add, memory_task_update, memory_task_list, memory_task_next
`;

  // For global: write to ~/.claude/CLAUDE.md (loaded by Claude Code in every session)
  // For project: write to ./CLAUDE.md in the current directory
  const claudeMdPath = isGlobal
    ? join(osHomedir(), '.claude', 'CLAUDE.md')
    : join(cwd, 'CLAUDE.md');

  // Ensure parent directory exists (for ~/.claude/CLAUDE.md)
  const claudeMdDir = dirname(claudeMdPath);
  if (!existsSync(claudeMdDir)) {
    mkdirSync(claudeMdDir, { recursive: true });
  }

  if (skipClaudeMd) {
    claudeMdAction = '  CLAUDE.md: skipped (--no-claude-md)';
  } else if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf-8');
    if (content.includes('## Memory (AWM)')) {
      claudeMdAction = '  CLAUDE.md: already has AWM section (skipped)';
    } else {
      writeFileSync(claudeMdPath, content.trimEnd() + '\n' + claudeMdSnippet);
      claudeMdAction = '  CLAUDE.md: appended AWM workflow section';
    }
  } else {
    const title = isGlobal ? '# Global Instructions' : `# ${basename(cwd)}`;
    writeFileSync(claudeMdPath, `${title}\n${claudeMdSnippet}`);
    claudeMdAction = '  CLAUDE.md: created with AWM workflow section';
  }

  // --- Hook configuration ---
  let hookAction = '';
  if (skipHooks) {
    hookAction = '  Hooks: skipped (--no-hooks)';
  } else {
    // Write hooks to Claude Code settings (~/.claude/settings.json)
    const settingsPath = join(osHomedir(), '.claude', 'settings.json');
    let settings: any = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch {
        settings = {};
      }
    }

    if (!settings.hooks) settings.hooks = {};

    const hookUrl = `http://127.0.0.1:${hookPort}/hooks/checkpoint`;

    // Stop — remind Claude to write/recall/switch tasks after each response
    settings.hooks.Stop = [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'echo "MEMORY: (1) Did you learn anything new? Call memory_write. (2) Are you about to work on a topic you might have prior knowledge about? Call memory_recall. (3) Switching tasks? Call memory_task_begin."',
        timeout: 5,
        async: true,
      }],
    }];

    // Build hook command with multi-port fallback for separate memory pools.
    // When users have work (port 8401) and personal (port 8402) pools via
    // per-folder .mcp.json, the hook needs to try both ports since the global
    // settings.json can't know which pool is active in the current session.
    const altPort = hookPort === '8401' ? '8402' : '8401';
    const hookUrlAlt = `http://127.0.0.1:${altPort}/hooks/checkpoint`;
    const buildHookCmd = (event: string, maxTime: number) => {
      const primary = `curl -sf -X POST ${hookUrl} -H "Content-Type: application/json" -H "Authorization: Bearer ${hookSecret}" -d "{\\"hook_event_name\\":\\"${event}\\"}" --max-time ${maxTime}`;
      const fallback = `curl -sf -X POST ${hookUrlAlt} -H "Content-Type: application/json" -H "Authorization: Bearer ${hookSecret}" -d "{\\"hook_event_name\\":\\"${event}\\"}" --max-time ${maxTime}`;
      return `${primary} || ${fallback}`;
    };

    // PreCompact — auto-checkpoint before context compaction
    settings.hooks.PreCompact = [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: buildHookCmd('PreCompact', 5),
        timeout: 10,
      }],
    }];

    // SessionEnd — auto-checkpoint on session close (fast timeout to avoid cancellation)
    settings.hooks.SessionEnd = [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: buildHookCmd('SessionEnd', 2),
        timeout: 5,
      }],
    }];

    // Ensure settings directory exists
    const settingsDir = dirname(settingsPath);
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true });
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    hookAction = `  Hooks: Stop (memory reminder) + PreCompact + SessionEnd → auto-checkpoint (port ${hookPort})`;
  }

  const scope = isGlobal ? 'globally (all projects)' : cwd;
  console.log(`
AWM configured ${isGlobal ? 'globally' : 'for: ' + cwd}

  Agent ID:    ${agentId}
  DB path:     ${dbPath}
  MCP config:  ${mcpJsonPath}
  Hook port:   ${hookPort}
  Hook secret: ${hookSecret.slice(0, 8)}...
${claudeMdAction}
${hookAction}

Next steps:
  1. Restart Claude Code to pick up the MCP server
  2. The memory tools will appear automatically
  3. Hooks auto-checkpoint on context compaction and session end${isGlobal ? '\n  4. One brain across all your projects — no per-project setup needed' : ''}
`.trim());
}

// ─── MCP ──────────────────────────────────────

async function mcp() {
  // Dynamic import to avoid loading heavy deps for setup/health commands
  await import('./mcp.js');
}

// ─── SERVE ──────────────────────────────────────

async function serve() {
  // Parse --port flag
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      process.env.AWM_PORT = args[++i];
    }
  }
  await import('./index.js');
}

// ─── HEALTH ──────────────────────────────────────

function health() {
  let port = '8400';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = args[++i];
    }
  }

  try {
    const result = execSync(`curl -sf http://localhost:${port}/health`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    const data = JSON.parse(result);
    console.log(`OK — v${data.version} (${data.timestamp})`);
  } catch {
    console.error(`Cannot reach AWM server on port ${port}`);
    process.exit(1);
  }
}

// ─── EXPORT ──────────────────────────────────────

function exportMemories() {
  let dbPath = '';
  let agentFilter: string | null = null;
  let outputPath: string | null = null;
  let activeOnly = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) dbPath = args[++i];
    else if (args[i] === '--agent' && args[i + 1]) agentFilter = args[++i];
    else if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
    else if (args[i] === '--active-only') activeOnly = true;
  }

  if (!dbPath) {
    console.error('Error: --db <path> is required');
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    console.error(`Error: database not found: ${dbPath}`);
    process.exit(1);
  }

  // Dynamic import to avoid loading better-sqlite3 for other commands
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  // Build memory query
  let memQuery = 'SELECT * FROM engrams';
  const conditions: string[] = [];
  const params: any[] = [];

  if (agentFilter) {
    conditions.push('agent_id = ?');
    params.push(agentFilter);
  }
  if (activeOnly) {
    conditions.push('retracted = 0');
  }

  if (conditions.length > 0) {
    memQuery += ' WHERE ' + conditions.join(' AND ');
  }
  memQuery += ' ORDER BY created_at ASC';

  const rows = db.prepare(memQuery).all(...params) as any[];

  // Build memory objects (exclude embedding blobs)
  const memories = rows.map((r: any) => ({
    id: r.id,
    agent_id: r.agent_id,
    concept: r.concept,
    content: r.content,
    confidence: r.confidence,
    salience: r.salience,
    access_count: r.access_count,
    last_accessed: r.last_accessed,
    created_at: r.created_at,
    stage: r.stage,
    tags: r.tags ? JSON.parse(r.tags) : [],
    memory_class: r.memory_class ?? 'working',
    episode_id: r.episode_id ?? null,
    task_status: r.task_status ?? null,
    task_priority: r.task_priority ?? null,
    supersedes: r.supersedes ?? null,
    superseded_by: r.superseded_by ?? null,
    retracted: r.retracted ?? 0,
  }));

  // Get memory IDs for association filtering
  const memIds = new Set(memories.map((m: any) => m.id));

  // Build associations
  let assocQuery = 'SELECT * FROM associations';
  const allAssocs = db.prepare(assocQuery).all() as any[];
  const associations = allAssocs
    .filter((a: any) => memIds.has(a.from_engram_id) && memIds.has(a.to_engram_id))
    .map((a: any) => ({
      from_id: a.from_engram_id,
      to_id: a.to_engram_id,
      weight: a.weight,
      type: a.type ?? 'hebbian',
      activation_count: a.activation_count ?? 0,
    }));

  // Collect unique agents
  const agents = [...new Set(memories.map((m: any) => m.agent_id))];

  const exportData = {
    version: '0.5.6',
    exported_at: new Date().toISOString(),
    source_db: dbPath,
    agent_filter: agentFilter,
    memories,
    associations,
    stats: {
      total_memories: memories.length,
      total_associations: associations.length,
      agents,
    },
  };

  const json = JSON.stringify(exportData, null, 2);

  if (outputPath) {
    writeFileSync(outputPath, json + '\n');
    console.error(`Exported ${memories.length} memories, ${associations.length} associations → ${outputPath}`);
  } else {
    process.stdout.write(json + '\n');
  }

  db.close();
}

// ─── IMPORT ──────────────────────────────────────

function importMemories() {
  let filePath = '';
  let dbPath = '';
  let remapAgent: string | null = null;
  let dedupe = false;
  let dryRun = false;
  let includeRetracted = false;

  // First non-flag arg after 'import' is the file path
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) dbPath = args[++i];
    else if (args[i] === '--remap-agent' && args[i + 1]) remapAgent = args[++i];
    else if (args[i] === '--dedupe') dedupe = true;
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--include-retracted') includeRetracted = true;
    else if (!args[i].startsWith('--') && !filePath) filePath = args[i];
  }

  if (!filePath) {
    console.error('Error: <file> is required');
    process.exit(1);
  }
  if (!dbPath) {
    console.error('Error: --db <path> is required');
    process.exit(1);
  }
  if (!existsSync(filePath)) {
    console.error(`Error: import file not found: ${filePath}`);
    process.exit(1);
  }

  const importData = JSON.parse(readFileSync(filePath, 'utf-8'));
  if (!importData.memories || !Array.isArray(importData.memories)) {
    console.error('Error: invalid export file — missing memories array');
    process.exit(1);
  }

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);

  // Build dedup set if needed
  const existingHashes = new Set<string>();
  if (dedupe) {
    const existing = db.prepare('SELECT concept, content FROM engrams').all() as any[];
    for (const row of existing) {
      const hash = (row.concept ?? '').toLowerCase().trim() + '||' + (row.content ?? '').toLowerCase().trim();
      existingHashes.add(hash);
    }
  }

  // Build old-id → new-id map
  const { randomUUID } = require('node:crypto');
  const idMap = new Map<string, string>();
  let imported = 0;
  let skippedDupes = 0;
  let skippedRetracted = 0;

  const insertMem = db.prepare(`
    INSERT INTO engrams (id, agent_id, concept, content, confidence, salience,
      access_count, last_accessed, created_at, stage, tags, memory_class,
      episode_id, task_status, task_priority, supersedes, superseded_by, retracted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAssoc = db.prepare(`
    INSERT INTO associations (id, from_engram_id, to_engram_id, weight, type, activation_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const importTx = db.transaction(() => {
    // Import memories
    for (const mem of importData.memories) {
      // Skip retracted unless --include-retracted
      if (mem.retracted && !includeRetracted) {
        skippedRetracted++;
        continue;
      }

      // Dedupe check
      if (dedupe) {
        const hash = (mem.concept ?? '').toLowerCase().trim() + '||' + (mem.content ?? '').toLowerCase().trim();
        if (existingHashes.has(hash)) {
          skippedDupes++;
          continue;
        }
      }

      const newId = randomUUID();
      idMap.set(mem.id, newId);

      const agentId = remapAgent ?? mem.agent_id;
      const tags = Array.isArray(mem.tags) ? JSON.stringify(mem.tags) : (mem.tags ?? '[]');

      if (!dryRun) {
        insertMem.run(
          newId, agentId, mem.concept, mem.content,
          mem.confidence ?? 0.5, mem.salience ?? 0.5,
          mem.access_count ?? 0, mem.last_accessed ?? mem.created_at,
          mem.created_at, mem.stage ?? 'active', tags,
          mem.memory_class ?? 'working', mem.episode_id ?? null,
          mem.task_status ?? null, mem.task_priority ?? null,
          mem.supersedes ?? null, mem.superseded_by ?? null,
          mem.retracted ?? 0
        );
      }
      imported++;
    }

    // Import associations (using remapped IDs)
    let assocImported = 0;
    const associations = importData.associations ?? [];
    for (const assoc of associations) {
      const fromId = idMap.get(assoc.from_id);
      const toId = idMap.get(assoc.to_id);
      if (!fromId || !toId) continue; // skip if either memory was skipped

      if (!dryRun) {
        insertAssoc.run(
          randomUUID(), fromId, toId,
          assoc.weight ?? 0.5, assoc.type ?? 'hebbian',
          assoc.activation_count ?? 0
        );
      }
      assocImported++;
    }

    return assocImported;
  });

  const assocCount = importTx();

  const prefix = dryRun ? '[DRY RUN] Would import' : 'Imported';
  console.log(`${prefix} ${imported} memories, ${assocCount} associations` +
    (skippedDupes > 0 ? `, ${skippedDupes} skipped (dupes)` : '') +
    (skippedRetracted > 0 ? `, ${skippedRetracted} skipped (retracted)` : '') +
    (remapAgent ? ` (agent remapped to: ${remapAgent})` : ''));

  db.close();
}

// ─── Dispatch ──────────────────────────────────────

switch (command) {
  case 'setup':
    setup();
    break;
  case 'mcp':
    mcp();
    break;
  case 'serve':
    serve();
    break;
  case 'health':
    health();
    break;
  case 'export':
    exportMemories();
    break;
  case 'import':
    importMemories();
    break;
  case '--help':
  case '-h':
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
