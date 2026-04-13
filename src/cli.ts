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
import { resolve, join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
  awm setup [target] [options]                      Configure AWM for an AI CLI
  awm doctor [target|--all]                         Validate AWM integrations
  awm mcp                                           Start MCP server (stdio)
  awm serve [--port <port>]                         Start HTTP API server
  awm health [--port <port>]                        Check server health
  awm export --db <path> [--agent <id>] [--output <file>] [--active-only]
                                                    Export memories to JSON
  awm import <file> --db <path> [--remap-agent <id>] [--dedupe] [--dry-run]
                                                    Import memories from JSON
  awm merge --target <db> --source <db> [--source ...]
            [--remap uuid=name] [--remap-all-uuids <name>]
            [--dedupe] [--dry-run]                  Merge multiple memory DBs

Setup targets:
  claude-code (default)   .mcp.json + CLAUDE.md + hooks
  codex                   ~/.codex/config.toml + AGENTS.md
  cursor                  .cursor/mcp.json + .cursorrules
  http                    Connection info for HTTP API

Setup options:
  --global            Use global scope (recommended for claude-code)
  --agent-id <id>     Agent identifier (default: project name)
  --db-path <path>    Database path (default: <awm>/data/memory.db)
  --no-instructions   Skip instruction file (CLAUDE.md, AGENTS.md, etc.)
  --no-claude-md      Alias for --no-instructions
  --no-hooks          Skip hook installation
  --hook-port PORT    Sidecar port for hooks (default: 8401)

Examples:
  awm setup --global              Claude Code, global (recommended)
  awm setup codex                 Codex CLI
  awm setup cursor                Cursor IDE
  awm setup http                  Generic HTTP integration
  awm doctor --all                Check all configured targets
`.trim());
}

// ─── SETUP ──────────────────────────────────────

async function setup() {
  // Parse flags
  let target = 'claude-code';
  let agentId: string | undefined;
  let dbPath: string | null = null;
  let skipInstructions = false;
  let isGlobal = false;
  let skipHooks = false;
  let hookPort = '8401';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--agent-id' && args[i + 1]) {
      agentId = args[++i];
    } else if (args[i] === '--db-path' && args[i + 1]) {
      dbPath = args[++i];
    } else if (args[i] === '--no-claude-md' || args[i] === '--no-instructions') {
      skipInstructions = true;
    } else if (args[i] === '--no-hooks') {
      skipHooks = true;
    } else if (args[i] === '--hook-port' && args[i + 1]) {
      hookPort = args[++i];
    } else if (args[i] === '--global') {
      isGlobal = true;
    } else if (!args[i].startsWith('--')) {
      // Positional arg = target
      target = args[i];
    }
  }

  // Load adapter
  const { getAdapter } = await import('./adapters/index.js');
  const { buildSetupContext } = await import('./adapters/common.js');

  let adapter;
  try {
    adapter = await getAdapter(target);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  // Force global for adapters that don't support project scope
  if (!adapter.supportsProjectScope && !isGlobal) {
    isGlobal = true;
  }

  // Build context
  const ctx = buildSetupContext({ agentId, dbPath, isGlobal, hookPort });

  // Run adapter
  const configAction = adapter.writeMcpConfig(ctx);
  const instructionsAction = adapter.writeInstructions(ctx, skipInstructions);
  const hooksAction = adapter.writeHooks(ctx, skipHooks);

  console.log(`
AWM configured for ${adapter.name}${isGlobal ? ' (global)' : ''}

  Agent ID:    ${ctx.agentId}
  DB path:     ${ctx.dbPath}
  ${configAction}
  ${instructionsAction}
  ${hooksAction}

Next steps:
  1. Restart ${adapter.name} to pick up the MCP server
  2. Memory tools will appear automatically${adapter.id === 'codex' ? ' (verify with /mcp)' : ''}
`.trim());
}

// ─── DOCTOR ──────────────────────────────────────

async function doctor() {
  const { getAdapter, listAdapters } = await import('./adapters/index.js');
  const { buildSetupContext } = await import('./adapters/common.js');

  let targets: string[] = [];
  let checkAll = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--all') {
      checkAll = true;
    } else if (!args[i].startsWith('--')) {
      targets.push(args[i]);
    }
  }

  if (checkAll) {
    targets = listAdapters();
  } else if (targets.length === 0) {
    targets = listAdapters();
  }

  const ctx = buildSetupContext({ isGlobal: true, hookPort: '8401' });

  console.log('AWM Doctor\n');

  for (const targetId of targets) {
    let adapter;
    try {
      adapter = await getAdapter(targetId);
    } catch {
      console.log(`  ? ${targetId}: unknown target (skipped)`);
      continue;
    }

    console.log(`  ${adapter.name}:`);
    const results = adapter.diagnose(ctx);
    for (const r of results) {
      const icon = r.status === 'ok' ? '+' : r.status === 'warn' ? '~' : 'x';
      console.log(`    [${icon}] ${r.check}: ${r.message}`);
      if (r.fix) {
        console.log(`        Fix: ${r.fix}`);
      }
    }
    console.log();
  }
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

async function exportMemories() {
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
  const Database = (await import('better-sqlite3')).default;
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
    version: '0.7.2',
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

async function importMemories() {
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

  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);

  // Ensure tables exist in target
  db.exec(`
    CREATE TABLE IF NOT EXISTS engrams (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, concept TEXT NOT NULL, content TEXT NOT NULL,
      embedding BLOB, confidence REAL NOT NULL DEFAULT 0.5, salience REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT NOT NULL, created_at TEXT NOT NULL,
      salience_features TEXT NOT NULL DEFAULT '{}', reason_codes TEXT NOT NULL DEFAULT '[]',
      stage TEXT NOT NULL DEFAULT 'active', ttl INTEGER, retracted INTEGER NOT NULL DEFAULT 0,
      retracted_by TEXT, retracted_at TEXT, tags TEXT NOT NULL DEFAULT '[]',
      episode_id TEXT, task_status TEXT, task_priority TEXT, blocked_by TEXT,
      memory_class TEXT NOT NULL DEFAULT 'working', superseded_by TEXT, supersedes TEXT
    );
    CREATE TABLE IF NOT EXISTS associations (
      id TEXT PRIMARY KEY, from_engram_id TEXT NOT NULL, to_engram_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.1, confidence REAL NOT NULL DEFAULT 0.5,
      type TEXT NOT NULL DEFAULT 'hebbian', activation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_activated TEXT
    );
  `);

  // Build dedup set if needed
  const existingHashes = new Set<string>();
  if (dedupe) {
    const existing = db.prepare('SELECT concept, content FROM engrams').all() as any[];
    for (const row of existing) {
      const hash = (row.concept ?? '').toLowerCase().trim() + '||' + (row.content ?? '').toLowerCase().trim();
      existingHashes.add(hash);
    }
  }
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

// ─── MERGE ──────────────────────────────────────

async function mergeMemories() {
  const Database = (await import('better-sqlite3')).default;
  const { createHash, randomUUID } = await import('node:crypto');

  let target = '';
  const sources: string[] = [];
  const remapEntries = new Map<string, string>();
  let remapAllUuids = '';
  let dedupe = false;
  let dryRun = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) {
      target = args[++i];
    } else if (args[i] === '--source' && args[i + 1]) {
      sources.push(args[++i]);
    } else if (args[i] === '--remap' && args[i + 1]) {
      const val = args[++i];
      const eqIdx = val.indexOf('=');
      if (eqIdx > 0) remapEntries.set(val.slice(0, eqIdx), val.slice(eqIdx + 1));
    } else if (args[i] === '--remap-all-uuids' && args[i + 1]) {
      remapAllUuids = args[++i];
    } else if (args[i] === '--dedupe') {
      dedupe = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  if (!target || sources.length === 0) {
    console.error('Usage: awm merge --target <path> --source <path> [--source <path>...] [--remap uuid=name] [--remap-all-uuids name] [--dedupe] [--dry-run]');
    process.exit(1);
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function remapAgentId(agentId: string): string {
    if (remapEntries.has(agentId)) return remapEntries.get(agentId)!;
    if (remapAllUuids && UUID_RE.test(agentId)) return remapAllUuids;
    return agentId;
  }

  function contentHash(concept: string, content: string): string {
    return createHash('sha256').update((concept + '\n' + content).toLowerCase().trim()).digest('hex');
  }

  console.log(`Target: ${target}${dryRun ? ' (DRY RUN)' : ''}`);

  const targetDb = new Database(target);
  targetDb.pragma('journal_mode = WAL');
  targetDb.pragma('foreign_keys = ON');

  // Ensure tables exist in target
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS engrams (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, concept TEXT NOT NULL, content TEXT NOT NULL,
      embedding BLOB, confidence REAL NOT NULL DEFAULT 0.5, salience REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT NOT NULL, created_at TEXT NOT NULL,
      salience_features TEXT NOT NULL DEFAULT '{}', reason_codes TEXT NOT NULL DEFAULT '[]',
      stage TEXT NOT NULL DEFAULT 'active', ttl INTEGER, retracted INTEGER NOT NULL DEFAULT 0,
      retracted_by TEXT, retracted_at TEXT, tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS associations (
      id TEXT PRIMARY KEY, from_engram_id TEXT NOT NULL, to_engram_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.1, confidence REAL NOT NULL DEFAULT 0.5,
      type TEXT NOT NULL DEFAULT 'hebbian', activation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_activated TEXT NOT NULL
    );
  `);

  // Build dedupe hash set from existing target memories
  const existingHashes = new Set<string>();
  if (dedupe) {
    const rows = targetDb.prepare('SELECT concept, content FROM engrams').all() as { concept: string; content: string }[];
    for (const row of rows) existingHashes.add(contentHash(row.concept, row.content));
    console.log(`Target has ${existingHashes.size} unique memories (for dedupe)\n`);
  }

  const insertEngram = targetDb.prepare(`
    INSERT OR IGNORE INTO engrams (id, agent_id, concept, content, confidence, salience, access_count,
      last_accessed, created_at, salience_features, reason_codes, stage, ttl,
      retracted, retracted_by, retracted_at, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAssoc = targetDb.prepare(`
    INSERT OR IGNORE INTO associations (id, from_engram_id, to_engram_id, weight, confidence, type,
      activation_count, created_at, last_activated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalMemories = 0, totalAssociations = 0, totalSkipped = 0;

  for (const sourcePath of sources) {
    if (!existsSync(sourcePath)) {
      console.error(`  Source not found: ${sourcePath}`);
      continue;
    }

    const sourceDb = new Database(sourcePath, { readonly: true });
    const engrams = sourceDb.prepare(
      `SELECT id, agent_id, concept, content, confidence, salience, access_count,
        last_accessed, created_at, salience_features, reason_codes, stage, ttl,
        retracted, retracted_by, retracted_at, tags FROM engrams`
    ).all() as any[];
    const assocs = sourceDb.prepare(
      `SELECT id, from_engram_id, to_engram_id, weight, confidence, type,
        activation_count, created_at, last_activated FROM associations`
    ).all() as any[];

    const idMap = new Map<string, string>();
    const skippedIds = new Set<string>();

    const result = targetDb.transaction(() => {
      let imported = 0, skipped = 0;
      for (const e of engrams) {
        const hash = contentHash(e.concept, e.content);
        if (dedupe && existingHashes.has(hash)) { skippedIds.add(e.id); skipped++; continue; }
        const newId = randomUUID();
        idMap.set(e.id, newId);
        existingHashes.add(hash);
        if (!dryRun) {
          insertEngram.run(newId, remapAgentId(e.agent_id), e.concept, e.content, e.confidence,
            e.salience, e.access_count, e.last_accessed, e.created_at, e.salience_features,
            e.reason_codes, e.stage, e.ttl, e.retracted, e.retracted_by, e.retracted_at, e.tags);
        }
        imported++;
      }
      let assocImported = 0;
      for (const a of assocs) {
        if (skippedIds.has(a.from_engram_id) || skippedIds.has(a.to_engram_id)) continue;
        const fromId = idMap.get(a.from_engram_id);
        const toId = idMap.get(a.to_engram_id);
        if (!fromId || !toId) continue;
        if (!dryRun) {
          insertAssoc.run(randomUUID(), fromId, toId, a.weight, a.confidence, a.type,
            a.activation_count, a.created_at, a.last_activated);
        }
        assocImported++;
      }
      return { imported, skipped, assocImported };
    })();

    sourceDb.close();

    const agentSet = new Set(engrams.map((e: any) => remapAgentId(e.agent_id)));
    console.log(`  Source: ${sourcePath}`);
    console.log(`    Engrams: ${engrams.length} total, ${result.imported} imported, ${result.skipped} skipped`);
    console.log(`    Associations: ${assocs.length} total, ${result.assocImported} imported`);
    console.log(`    Agents: ${agentSet.size} (${[...agentSet].slice(0, 5).join(', ')}${agentSet.size > 5 ? '...' : ''})\n`);

    totalMemories += result.imported;
    totalAssociations += result.assocImported;
    totalSkipped += result.skipped;
  }

  targetDb.close();
  console.log(`\nTotal: ${totalMemories} memories, ${totalAssociations} associations imported. ${totalSkipped} skipped.`);
  if (dryRun) console.log('(dry run — no data written)');
}

// ─── Dispatch ──────────────────────────────────────

switch (command) {
  case 'setup':
    await setup();
    break;
  case 'doctor':
    await doctor();
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
  case 'merge':
    mergeMemories();
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
