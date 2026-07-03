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
import { resolve, join, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';
import { runOnboard, ONBOARD_SKILL } from './onboard/index.js';

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
  awm migrate --from <sqlite.db> --to <pglite-dir> [--dry-run] [--verbose]
                                                    Migrate SQLite DB to PGlite

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

  // Seed the onboarding skill so a cold store can teach the agent how to warm itself.
  const skillAction = await seedOnboardSkill(ctx.dbPath, ctx.agentId);

  console.log(`
AWM configured for ${adapter.name}${isGlobal ? ' (global)' : ''}

  Agent ID:    ${ctx.agentId}
  DB path:     ${ctx.dbPath}
  ${configAction}
  ${instructionsAction}
  ${hooksAction}
  ${skillAction}

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

// ─── BACKEND-AGNOSTIC STORE (export/import) ──────────────────────────────────
//
// export/import route through openStore() so they work on ANY backend (SQLite,
// PGlite, Postgres) — not just better-sqlite3. `--db <path>` maps to AWM_DB_PATH
// (a SQLite file or PGlite dir, by shape); for a Postgres target set
// AWM_STORE_BACKEND=postgres + AWM_DATABASE_URL (no --db). This is what lets you
// port a memory store INTO managed Postgres (the SQLite-hardcoded path could not).

function toISOStr(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

async function openCliStore(dbPath?: string): Promise<{ store: any; backend: string; close: () => Promise<void> }> {
  // --db sets the path only when the env doesn't already select a backend/path.
  if (dbPath && !process.env.AWM_DB_PATH && (process.env.AWM_STORE_BACKEND ?? '') !== 'postgres') {
    process.env.AWM_DB_PATH = dbPath;
  }
  const { openStore } = await import('./storage/factory.js');
  const { store, backend } = await openStore();
  return { store, backend, close: async () => { try { await store.close?.(); } catch { /* */ } } };
}

// ─── EXPORT ──────────────────────────────────────

async function exportMemories() {
  let dbPath = '';
  let agentFilter: string | null = null;
  let outputPath: string | null = null;
  let activeOnly = false;
  let allStages = false;
  let includeRetracted = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) dbPath = args[++i];
    else if (args[i] === '--agent' && args[i + 1]) agentFilter = args[++i];
    else if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
    else if (args[i] === '--active-only') activeOnly = true;
    else if (args[i] === '--all-stages') allStages = true;
    else if (args[i] === '--include-retracted') includeRetracted = true;
  }

  // --db must exist for a file/dir backend; a Postgres source is selected by env instead.
  const usingPostgres = (process.env.AWM_STORE_BACKEND ?? '').toLowerCase() === 'postgres';
  if (!usingPostgres) {
    if (!dbPath) { console.error('Error: --db <path> is required (or set AWM_STORE_BACKEND=postgres + AWM_DATABASE_URL)'); process.exit(1); }
    if (!existsSync(dbPath)) { console.error(`Error: database not found: ${dbPath}`); process.exit(1); }
  }

  const { store, backend, close } = await openCliStore(dbPath);
  try {
    const agentIds: string[] = agentFilter
      ? [agentFilter]
      : ((await store.getActiveAgents()) as any[]).map((a) => a.agentId);
    if (agentIds.length === 0) {
      console.error('Warning: no agents found to export. Pass --agent <id> if the store has no tracked activity yet.');
    }
    // Default to the meaningful memory set (active stage, non-retracted). --all-stages
    // widens to every stage; --include-retracted adds retracted (off with --active-only).
    const stage = allStages ? undefined : 'active';
    const wantRetracted = includeRetracted && !activeOnly;
    const engrams: any[] = (await store.getEngramsByAgents(agentIds, stage, wantRetracted)) ?? [];

    const memories = engrams.map((e: any) => ({
      id: e.id,
      agent_id: e.agentId,
      concept: e.concept,
      content: e.content,
      // Embeddings ARE included now (the old SQLite-only export stripped them, forcing a
      // re-embed after import) → a faithful, recall-ready port when source/target embed
      // models match. import skips them with --no-embeddings (then re-embed).
      embedding: Array.isArray(e.embedding) ? e.embedding : null,
      confidence: e.confidence,
      salience: e.salience,
      access_count: e.accessCount ?? 0,
      last_accessed: toISOStr(e.lastAccessed),
      created_at: toISOStr(e.createdAt),
      stage: e.stage ?? 'active',
      tags: Array.isArray(e.tags) ? e.tags : [],
      memory_class: e.memoryClass ?? 'working',
      memory_type: e.memoryType ?? 'unclassified',
      episode_id: e.episodeId ?? null,
      task_status: e.taskStatus ?? null,
      task_priority: e.taskPriority ?? null,
      supersedes: e.supersedes ?? null,
      superseded_by: e.supersededBy ?? null,
      retracted: e.retracted ? 1 : 0,
    }));

    const memIds = new Set(memories.map((m) => m.id));
    const seen = new Set<string>();
    const associations: any[] = [];
    for (const aid of agentIds) {
      for (const a of ((await store.getAllAssociations(aid)) as any[]) ?? []) {
        if (!memIds.has(a.fromEngramId) || !memIds.has(a.toEngramId)) continue;
        const k = `${a.fromEngramId}>${a.toEngramId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        associations.push({
          from_id: a.fromEngramId, to_id: a.toEngramId,
          weight: a.weight, type: a.type ?? 'hebbian',
          activation_count: a.activationCount ?? 0, confidence: a.confidence ?? 0.5,
        });
      }
    }

    const exportData = {
      version: VERSION,
      exported_at: new Date().toISOString(),
      source_backend: backend,
      agent_filter: agentFilter,
      embedding_model: process.env.AWM_EMBED_MODEL ?? null,
      memories,
      associations,
      stats: {
        total_memories: memories.length,
        total_associations: associations.length,
        agents: [...new Set(memories.map((m) => m.agent_id))],
      },
    };

    const json = JSON.stringify(exportData, null, 2);
    if (outputPath) {
      writeFileSync(outputPath, json + '\n');
      console.error(`Exported ${memories.length} memories, ${associations.length} associations → ${outputPath} (backend: ${backend})`);
    } else {
      process.stdout.write(json + '\n');
    }
  } finally {
    await close();
  }
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

  // --no-embeddings: skip importing embedding vectors (use when source/target embed models
  // differ → import without, then re-embed). Parsed alongside the existing flags above.
  const noEmbeddings = args.includes('--no-embeddings');

  if (!filePath) {
    console.error('Error: <file> is required');
    process.exit(1);
  }
  const usingPostgres = (process.env.AWM_STORE_BACKEND ?? '').toLowerCase() === 'postgres';
  if (!dbPath && !usingPostgres) {
    console.error('Error: --db <path> is required (or set AWM_STORE_BACKEND=postgres + AWM_DATABASE_URL)');
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

  const { store, backend, close } = await openCliStore(dbPath);
  try {
    // Dedupe against existing memories for the TARGET agent(s).
    const existingHashes = new Set<string>();
    if (dedupe) {
      const targetAgents = remapAgent
        ? [remapAgent]
        : [...new Set(importData.memories.map((m: any) => m.agent_id))] as string[];
      for (const aid of targetAgents) {
        for (const e of ((await store.getEngramsByAgent(aid, undefined, true)) as any[]) ?? []) {
          existingHashes.add(`${(e.concept ?? '').toLowerCase().trim()}||${(e.content ?? '').toLowerCase().trim()}`);
        }
      }
    }

    const idMap = new Map<string, string>(); // old export id → new store id
    let imported = 0, skippedDupes = 0, skippedRetracted = 0;

    // Pass 1 — create engrams (createEngram mints a fresh id; we capture it for remapping).
    // createdAt/accessCount normalize to import time (the contract's createEngram stamps
    // them) — see CHANGELOG; everything semantic (content/tags/confidence/salience/classes/
    // embedding) is preserved, so recall is faithful.
    for (const mem of importData.memories) {
      if (mem.retracted && !includeRetracted) { skippedRetracted++; continue; }
      if (dedupe) {
        const h = `${(mem.concept ?? '').toLowerCase().trim()}||${(mem.content ?? '').toLowerCase().trim()}`;
        if (existingHashes.has(h)) { skippedDupes++; continue; }
        existingHashes.add(h); // also catch duplicates WITHIN this import file, not just vs the target
      }
      // dry-run: still map the id so the association-count preview isn't always 0
      if (dryRun) { idMap.set(mem.id, mem.id); imported++; continue; }
      const created = await store.createEngram({
        agentId: remapAgent ?? mem.agent_id,
        concept: mem.concept,
        content: mem.content,
        tags: Array.isArray(mem.tags) ? mem.tags : [],
        embedding: (!noEmbeddings && Array.isArray(mem.embedding) && mem.embedding.length > 0) ? mem.embedding : undefined,
        confidence: mem.confidence ?? 0.5,
        salience: mem.salience ?? 0.5,
        memoryClass: mem.memory_class ?? 'working',
        memoryType: mem.memory_type ?? undefined,
        episodeId: mem.episode_id ?? undefined,
        taskStatus: mem.task_status ?? undefined,
        taskPriority: mem.task_priority ?? undefined,
      });
      idMap.set(mem.id, created.id);
      // Restore stage + retracted status. createEngram always mints an ACTIVE, non-retracted engram, so
      // without this an `--include-retracted` import RESURRECTS retracted memories as live, and every
      // non-active stage (staging/consolidated/archived/fading) silently flattens to active.
      if (typeof mem.stage === 'string' && mem.stage && mem.stage !== 'active') {
        try { await store.updateStage(created.id, mem.stage); } catch { /* best-effort */ }
      }
      if (mem.retracted) { // only reached when --include-retracted (retracted are skipped above otherwise)
        try { await store.retractEngram(created.id, (mem as { retracted_by?: string }).retracted_by ?? null); } catch { /* best-effort */ }
      }
      imported++;
    }

    // Pass 2 — re-link supersession with remapped ids (supersedeEngram sets both sides:
    // old.superseded_by = new, new.supersedes = old). Skipped in dry-run.
    if (!dryRun) {
      for (const mem of importData.memories) {
        const newId = idMap.get(mem.id);
        if (!newId || !mem.supersedes) continue;
        const supersededNew = idMap.get(mem.supersedes);
        if (supersededNew) { try { await store.supersedeEngram(supersededNew, newId); } catch { /* best-effort */ } }
      }
    }

    // Pass 3 — associations, remapped; skip any whose endpoints weren't imported.
    let assocImported = 0;
    for (const a of (importData.associations ?? [])) {
      const fromId = idMap.get(a.from_id), toId = idMap.get(a.to_id);
      if (!fromId || !toId) continue;
      if (!dryRun) { try { await store.upsertAssociation(fromId, toId, a.weight ?? 0.5, a.type ?? 'hebbian', a.confidence ?? 0.5); } catch { /* best-effort */ } }
      assocImported++;
    }

    const prefix = dryRun ? '[DRY RUN] Would import' : 'Imported';
    console.log(`${prefix} ${imported} memories, ${assocImported} associations` +
      (skippedDupes > 0 ? `, ${skippedDupes} skipped (dupes)` : '') +
      (skippedRetracted > 0 ? `, ${skippedRetracted} skipped (retracted)` : '') +
      (remapAgent ? ` (agent remapped to: ${remapAgent})` : '') +
      ` (backend: ${backend}${noEmbeddings ? ', embeddings skipped' : ''})`);
  } finally {
    await close();
  }
}

// ─── MERGE ──────────────────────────────────────

async function mergeMemories() {
  const Database = (await import('better-sqlite3')).default;
  const { EngramStore } = await import('./storage/sqlite.js');
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

  // Open the target through the REAL store so it has the full, current schema (all columns) + the FTS
  // triggers. The previous hand-rolled schema dropped embedding/memory_class/memory_type/supersession/
  // task columns and never created engrams_fts — so merged rows lost vector recall, class, AND BM25.
  const store: any = new EngramStore(target);
  const targetDb = store.db as import('better-sqlite3').Database; // the store's better-sqlite3 handle

  const blobToArr = (b: unknown): number[] | undefined => {
    const buf = b as Buffer | null | undefined;
    return buf && buf.length ? Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4))) : undefined;
  };
  const parseJson = <T>(s: unknown, fallback: T): T => { try { return s ? JSON.parse(String(s)) as T : fallback; } catch { return fallback; } };

  // Build dedupe hash set from existing target memories (cross-agent read via the store's handle)
  const existingHashes = new Set<string>();
  if (dedupe) {
    const rows = targetDb.prepare('SELECT concept, content FROM engrams').all() as { concept: string; content: string }[];
    for (const row of rows) existingHashes.add(contentHash(row.concept, row.content));
    console.log(`Target has ${existingHashes.size} unique memories (for dedupe)\n`);
  }

  const insertAssoc = targetDb.prepare(`
    INSERT OR IGNORE INTO associations (id, from_engram_id, to_engram_id, weight, confidence, type,
      activation_count, created_at, last_activated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalMemories = 0, totalAssociations = 0, totalSkipped = 0;

  try {
  for (const sourcePath of sources) {
    if (!existsSync(sourcePath)) {
      console.error(`  Source not found: ${sourcePath}`);
      continue;
    }

    const sourceDb = new Database(sourcePath, { readonly: true });
    // SELECT * is robust to older source schemas — a column a source predates just reads back undefined
    // and createEngram fills the default.
    const engrams = sourceDb.prepare('SELECT * FROM engrams').all() as any[];
    const assocs = sourceDb.prepare('SELECT * FROM associations').all() as any[];
    sourceDb.close(); // reads done — release the source handle before any (throwing) write work

    const idMap = new Map<string, string>();
    const skippedIds = new Set<string>();
    let imported = 0, skipped = 0, assocImported = 0;

    for (const e of engrams) {
      const hash = contentHash(e.concept, e.content);
      if (dedupe && existingHashes.has(hash)) { skippedIds.add(e.id); skipped++; continue; }
      existingHashes.add(hash);
      if (dryRun) { idMap.set(e.id, e.id); imported++; continue; }
      // Route each engram through the store's createEngram so EVERY column (embedding, memory_class,
      // memory_type, task fields, sequence, references) AND the FTS index are populated correctly.
      const created = store.createEngram({
        agentId: remapAgentId(e.agent_id),
        concept: e.concept, content: e.content,
        embedding: blobToArr(e.embedding),
        confidence: e.confidence ?? 0.5, salience: e.salience ?? 0.5,
        salienceFeatures: parseJson(e.salience_features, undefined),
        reasonCodes: parseJson(e.reason_codes, undefined),
        tags: parseJson<string[]>(e.tags, []),
        memoryClass: e.memory_class ?? 'working',
        memoryType: e.memory_type ?? undefined,
        episodeId: e.episode_id ?? undefined,
        taskStatus: e.task_status ?? undefined,
        taskPriority: e.task_priority ?? undefined,
        blockedBy: e.blocked_by ?? undefined,
        ttl: e.ttl ?? undefined,
        sequence: e.sequence ?? undefined,
        references: parseJson(e.references_json, undefined),
      });
      idMap.set(e.id, created.id);
      // preserve stage + retracted (createEngram always mints active/non-retracted)
      if (typeof e.stage === 'string' && e.stage && e.stage !== 'active') { try { store.updateStage(created.id, e.stage); } catch { /* */ } }
      if (e.retracted) { try { store.retractEngram(created.id, e.retracted_by ?? null); } catch { /* */ } }
      imported++;
    }
    // second pass — re-link supersession with remapped ids
    if (!dryRun) {
      for (const e of engrams) {
        const newId = idMap.get(e.id);
        if (!newId || !e.supersedes) continue;
        const supNew = idMap.get(e.supersedes);
        if (supNew) { try { store.supersedeEngram(supNew, newId); } catch { /* */ } }
      }
    }
    for (const a of assocs) {
      if (skippedIds.has(a.from_engram_id) || skippedIds.has(a.to_engram_id)) continue;
      const fromId = idMap.get(a.from_engram_id);
      const toId = idMap.get(a.to_engram_id);
      if (!fromId || !toId) continue;
      if (!dryRun) {
        try {
          insertAssoc.run(randomUUID(), fromId, toId, a.weight, a.confidence, a.type,
            a.activation_count, a.created_at, a.last_activated);
        } catch { /* skip an association whose source row has an unbindable/undefined column */ }
      }
      assocImported++;
    }

    const agentSet = new Set(engrams.map((e: any) => remapAgentId(e.agent_id)));
    console.log(`  Source: ${sourcePath}`);
    console.log(`    Engrams: ${engrams.length} total, ${imported} imported, ${skipped} skipped`);
    console.log(`    Associations: ${assocs.length} total, ${assocImported} imported`);
    console.log(`    Agents: ${agentSet.size} (${[...agentSet].slice(0, 5).join(', ')}${agentSet.size > 5 ? '...' : ''})\n`);

    totalMemories += imported;
    totalAssociations += assocImported;
    totalSkipped += skipped;
  }

  } finally {
    try { store.close(); } catch { /* */ }
  }
  console.log(`\nTotal: ${totalMemories} memories, ${totalAssociations} associations imported. ${totalSkipped} skipped.`);
  if (dryRun) console.log('(dry run — no data written)');
}

async function migrateCmd() {
  let from = '';
  let to = '';
  let dryRun = false;
  let verbose = false;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--from') { from = args[++i]; }
    else if (a === '--to') { to = args[++i]; }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--verbose' || a === '-v') { verbose = true; }
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }

  if (!from || !to) {
    console.error('Usage: awm migrate --from <sqlite.db> --to <pglite-dir> [--dry-run] [--verbose]');
    process.exit(1);
  }

  const { migrate, printStats } = await import('./cli/migrate.js');
  try {
    console.log(`Migrating ${from} → ${to}${dryRun ? ' (dry run)' : ''}`);
    const stats = await migrate({ from, to, dryRun, verbose });
    printStats(stats, dryRun);
  } catch (err) {
    console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ─── ONBOARD ──────────────────────────────────────

/**
 * Seed the onboarding skill as a canonical memory (idempotent). This is what lets
 * a cold store teach the host agent how to warm-start itself — the agent recalls
 * the skill and follows it. Best-effort: a seeding failure never fails `awm setup`.
 */
async function seedOnboardSkill(dbPath: string, agentId: string): Promise<string> {
  try {
    const { store, close } = await openCliStore(dbPath);
    try {
      const existing = await store.findActiveMatchByConcept(agentId, ONBOARD_SKILL.concept);
      if (existing) return 'Onboarding skill: already present';
      await store.createEngram({
        agentId, concept: ONBOARD_SKILL.concept, content: ONBOARD_SKILL.content,
        tags: ONBOARD_SKILL.tags, confidence: 0.9, salience: 0.9, memoryClass: 'canonical',
      });
      return 'Onboarding skill: seeded (recall it on a cold store to warm-start)';
    } finally {
      await close();
    }
  } catch (e: any) {
    return `Onboarding skill: skipped (${e?.message ?? 'store unavailable'})`;
  }
}

function onboardCmd() {
  const docs: string[] = [];
  let repo: string | undefined;
  let project = '';
  let agentId = '';
  let purpose: string | undefined;
  let outDir = resolve(process.cwd(), '.awm');

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo' && args[i + 1]) repo = args[++i];
    else if (a === '--project' && args[i + 1]) project = args[++i];
    else if (a === '--agent' && args[i + 1]) agentId = args[++i];
    else if (a === '--purpose' && args[i + 1]) purpose = args[++i];
    else if (a === '--out' && args[i + 1]) outDir = resolve(args[++i]);
    else if (!a.startsWith('--')) docs.push(a);
  }

  // Default docs to the repo (or cwd) so a bare `awm onboard --repo .` works.
  if (docs.length === 0) docs.push(repo ?? process.cwd());
  if (!project) project = basename(repo ? resolve(repo) : (docs[0] ? resolve(docs[0]) : process.cwd()));
  if (!agentId) agentId = project;

  const { packPath, reviewPath, count } = runOnboard({ docs, repo, project, agentId, purpose, outDir });
  console.log(`
AWM onboard — warm-start pack for "${project}"

  Scanned:   ${docs.join(', ')}${repo ? `  (+repo ${repo})` : ''}
  Extracted: ${count} candidate memories (agent: ${agentId})

  Review:    ${reviewPath}
  Pack:      ${packPath}

Next:
  1. Edit the review file / pack as needed (delete noise, answer the interview questions).
  2. Load it:  awm import ${packPath} --db <path> --dedupe
     (embeddings backfill on the first consolidation — recall is warm immediately after)
`.trimEnd());
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
  case 'migrate':
    await migrateCmd();
    break;
  case 'onboard':
    onboardCmd();
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
