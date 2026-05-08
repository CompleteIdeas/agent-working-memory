// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared utilities for CLI adapters.
 *
 * Extracted from the original setup() in cli.ts — path resolution, secrets,
 * environment variables, MCP command building, and the AWM instruction snippet.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir as osHomedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { SetupContext } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the AWM package root (where src/ and dist/ live). */
export function resolvePackageRoot(): string {
  // __dirname is src/adapters/ at dev time, dist/adapters/ at build time
  return resolve(__dirname, '..', '..');
}

/** Resolve the database path — default to <packageRoot>/data/memory.db. */
export function resolveDbPath(packageRoot: string, explicit?: string | null): string {
  const dbPath = explicit ?? join(packageRoot, 'data', 'memory.db');
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  return dbPath;
}

/** Read or generate the hook secret token. */
export function resolveHookSecret(dbPath: string): string {
  const secretPath = join(dirname(dbPath), '.awm-hook-secret');
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf-8').trim();
    if (existing) return existing;
  }
  const secret = randomBytes(32).toString('hex');
  mkdirSync(dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, secret + '\n');
  return secret;
}

/** Build environment variables for the MCP server process. */
export function buildEnvVars(
  dbPath: string,
  agentId: string,
  hookPort: string,
  hookSecret: string,
  isWindows: boolean,
): Record<string, string> {
  return {
    AWM_DB_PATH: isWindows ? dbPath.replace(/\\/g, '/') : dbPath,
    AWM_AGENT_ID: agentId,
    AWM_HOOK_PORT: hookPort,
    AWM_HOOK_SECRET: hookSecret,
  };
}

/**
 * Resolve the MCP server command + args.
 *
 * Prefers absolute path to dist/mcp.js (works from any cwd).
 * Falls back to npx tsx src/mcp.ts for dev mode.
 */
export function resolveMcpCommand(ctx: SetupContext): {
  command: string;
  args: string[];
} {
  if (ctx.hasDist) {
    return {
      command: 'node',
      args: [ctx.mcpDist.replace(/\\/g, '/')],
    };
  }
  // Dev fallback
  if (ctx.isWindows) {
    return {
      command: 'cmd',
      args: ['/c', 'npx', 'tsx', ctx.mcpScript.replace(/\\/g, '/')],
    };
  }
  return {
    command: 'npx',
    args: ['tsx', ctx.mcpScript],
  };
}

/** Build a full SetupContext from parsed CLI flags. */
export function buildSetupContext(opts: {
  agentId?: string;
  dbPath?: string | null;
  isGlobal: boolean;
  hookPort: string;
}): SetupContext {
  const cwd = process.cwd();
  const projectName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const packageRoot = resolvePackageRoot();
  const mcpScript = join(packageRoot, 'src', 'mcp.ts');
  const mcpDist = join(packageRoot, 'dist', 'mcp.js');
  const hasDist = existsSync(mcpDist);
  const isWindows = process.platform === 'win32';

  const agentId = opts.agentId ?? (opts.isGlobal ? 'claude' : projectName);
  const dbPath = resolveDbPath(packageRoot, opts.dbPath);
  const hookSecret = resolveHookSecret(dbPath);
  const envVars = buildEnvVars(dbPath, agentId, opts.hookPort, hookSecret, isWindows);

  return {
    cwd,
    projectName,
    agentId,
    dbPath,
    packageRoot,
    mcpDist,
    mcpScript,
    hasDist,
    hookSecret,
    hookPort: opts.hookPort,
    isGlobal: opts.isGlobal,
    isWindows,
    envVars,
  };
}

/** Home directory. */
export function homedir(): string {
  return osHomedir();
}

// ─── Instruction content ────────────────────────────────

/**
 * Core AWM instruction snippet — shared across all adapters.
 * Each adapter wraps this in the appropriate file format.
 */
export const AWM_INSTRUCTION_CONTENT = `
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

### When writing, include metadata for better recall:
- \`project\`: current project name (e.g., "EquiHub", "AWM")
- \`topic\`: subject area (e.g., "database-migration", "auth-flow")
- \`session_id\`: conversation grouping ID — associates related memories
- \`source\`: how acquired (code-reading, debugging, discussion, research, testing, observation)
- \`confidence_level\`: verified (tested), observed (read in code), assumed (reasoning)
- \`intent\`: decision, finding, todo, question, or context

### Memory classes (controls how strictly the salience filter gates the write)
- \`memory_class: canonical\` — source-of-truth memories. Floor 0.7 salience, never staged.
  Use for: user-stated decisions, project requirements, verified architectural facts,
  cross-agent shared context. **In a hive (multi-agent) setup, always use \`canonical\`
  for writes that other agents must be able to recall** — the default \`working\` class
  may get filtered.
- \`memory_class: working\` (default) — observations and findings. Salience-gated.
- \`memory_class: ephemeral\` — short-lived context that should decay quickly.

### Salience auto-promotion (defense in depth)
The salience filter automatically promotes certain content patterns even if you forget
to set \`memory_class\` explicitly:
- **User feedback** — content starting with "Robert said…", "Katherine directed…",
  "Nancy decided…" etc. auto-promotes to canonical. So quoting the user verbatim
  always preserves the decision.
- **Verified operational records** — content with an action verb (Submitted, Finalized,
  Completed, Reconciled, Triaged, Posted, Resolved, Stamped, Pushed, Deployed, Migrated,
  Imported, Exported, Backfilled) plus 2+ concrete identifiers (ISO date \`YYYY-MM-DD\`,
  or contextual numeric IDs like "event 18969", "ticket #18330", "USEF 341980") gets
  a 0.45 salience floor. So batch summaries with real IDs survive even when topic
  terms repeat.

If neither pattern applies and you want a memory to definitely survive, set
\`memory_class: canonical\` explicitly. Don't rely on auto-promotion for important writes.

### Recall memory when:
- **BEFORE stating ANY fact about how a system works** — recall first; if AWM doesn't
  have it, read the code. Never guess and present it as fact.
- **BEFORE searching the filesystem** — recall first; AWM is faster and has cross-session
  knowledge that file search doesn't.
- Starting work on a new task or subsystem
- Re-entering code you haven't touched recently
- After a failed attempt — check if there's prior knowledge
- Before refactoring or making architectural changes
- When a topic comes up that you might have prior context on

Recall is fast (~1s typical). Use it freely.

### Keep memory fresh
- After recalling a memory, if you observe the real state is different → call
  \`memory_supersede\` immediately with the corrected version.
- After using a recalled memory: call \`memory_feedback\` (useful/not-useful) so the
  activation engine learns what's valuable.
- If you discover a memory is factually wrong: \`memory_retract\` to remove it.

### Also:
- To track work items: memory_task_add, memory_task_update, memory_task_list, memory_task_next
- AWM is shared across all agents in real time. When any agent writes or supersedes a
  memory, every other agent can recall it immediately.

### Diagnostics / escape hatches (env vars, only if you know why)
- \`AWM_DISABLE_POOL_FILTER=1\` — disables the candidate pool reduction in recall (added
  in 0.7.7 for ~50% speedup). Reverts to scoring all candidates. Use only if you suspect
  a recall regression and want to A/B test against the pre-0.7.7 path.
`.trimStart();
