// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code adapter — writes .mcp.json, CLAUDE.md, and hooks.
 *
 * This is a direct extraction of the original setup() behavior.
 * Zero behavioral change from the monolithic version.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { CLIAdapter, SetupContext, DiagnosticResult } from './types.js';
import { resolveMcpCommand, homedir, AWM_INSTRUCTION_CONTENT, upsertAwmSection } from './common.js';
import { HOOK_SCRIPTS, AWM_HOOKS_VERSION, PRIME_DISABLE_FILE, type HooksRecord } from './hook-scripts.js';
import { request as httpRequest } from 'node:http';

/**
 * DB-mutation reminder hook (PostToolUse on Bash|PowerShell).
 * Fires when a shell command runs sqlcmd/mysql/psql with mutation keywords and
 * injects a reminder that the mutation must be recorded via memory_write.
 * Origin: 2026-07-29 tblOSCMPImportDivisionMatch incident — an unrecorded
 * script INSERT broke a production upload six days later, and no recall could
 * surface a cause that was never written.
 */
const DB_MUTATION_HOOK_SCRIPT = `#!/usr/bin/env node
// AWM DB-mutation reminder hook (PostToolUse on Bash|PowerShell). Installed by awm setup.
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw || '{}');
    const cmd = (j.tool_input && j.tool_input.command) || '';
    const isDbClient = /\\b(sqlcmd|mysql|psql)\\b/i.test(cmd) || /(sqlcmd|mysql|psql)\\.exe/i.test(cmd);
    const isMutation = /\\b(INSERT|UPDATE|DELETE|ALTER|TRUNCATE|DROP|MERGE)\\b/i.test(cmd);
    if (isDbClient && isMutation) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            'AWM REMINDER: this command contains a production DB mutation (INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE/MERGE). ' +
            'The change is NOT complete until it is recorded: call memory_write NOW with the table, what changed, row counts, date, and why ' +
            '(memory_class canonical if other agents must recall it), and confirm a rollback/backup exists. ' +
            'If the keywords were only in a string/comment or on temp tables (#...), no write is needed.',
        },
      }));
    }
  } catch (e) { /* never block the tool result */ }
  process.exit(0);
});
`;

const SERVER_NAME = 'agent-working-memory';

/** Where this adapter keeps the AWM server entry for a scope. */
function mcpJsonPathFor(isGlobal: boolean, cwd: string): string {
  // Global: ~/.mcp.json (standard MCP location, all projects)
  // Project: .claude/mcp.json (Claude Code's native project scope)
  return isGlobal ? join(homedir(), '.mcp.json') : join(cwd, '.claude', 'mcp.json');
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

/**
 * Exactly the hook scripts `awm setup` installs. Used to recognise our own groups in
 * settings.json so they can be replaced on a re-run.
 *
 * This list must stay TIGHT. It was briefly a loose `awm-*.cjs` pattern, and on a real
 * install that silently deleted the owner's own `awm-dev-log.cjs` and
 * `awm-recall-stamp.cjs` hooks, which merely share the prefix. Anything not installed by
 * this adapter belongs to the user.
 */
const OWNED_HOOK_FILES = [
  ...HOOK_SCRIPTS.map(h => h.file),
  'awm-db-mutation-reminder.cjs',
];

/** True for a settings.json hook group that `awm setup` wrote, in any version. */
function isAwmHookGroup(group: any): boolean {
  const text = JSON.stringify(group ?? {});
  return OWNED_HOOK_FILES.some(f => text.includes(f))    // 0.14.6 scripts
    || /curl[^"]*\/hooks\/checkpoint/.test(text)         // pre-0.14.6 inline curl
    || text.includes('MEMORY: (1) Did you learn');        // the Stop reminder
}

/** Merge one hook group for `event`: drop every AWM-owned group, keep the user's, append ours. */
function setHookGroup(settings: any, event: string, group: any | null): void {
  const others = (settings.hooks[event] || []).filter((g: any) => !isAwmHookGroup(g));
  settings.hooks[event] = group ? [...others, group] : others;
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}

interface LiveSidecar { port: number; agentId: string | null; version: string; pid: number | null }

/** GET /health on one sidecar port; null when nothing answers or it is not a sidecar. */
function probeSidecar(port: number, timeoutMs = 400): Promise<LiveSidecar | null> {
  return new Promise(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j && j.sidecar ? { port, agentId: j.agentId ?? null, version: j.version ?? '0.0.0', pid: j.pid ?? null } : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const adapter: CLIAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  supportsProjectScope: true,
  supportsGlobalScope: true,

  readExistingEnv(isGlobal: boolean, cwd: string): Record<string, string> | null {
    const entry = readJson(mcpJsonPathFor(isGlobal, cwd))?.mcpServers?.[SERVER_NAME];
    return entry?.env && typeof entry.env === 'object' ? { ...entry.env } : null;
  },

  writeMcpConfig(ctx: SetupContext): string {
    const mcpCmd = resolveMcpCommand(ctx);
    // ctx.envVars already layers recommended defaults < the user's existing env < owned keys
    // (buildEnvVars). Only the env and the command are ours; anything else the user put on
    // the entry (e.g. a `type`, a `cwd`) is carried across.
    const mcpJsonPath = mcpJsonPathFor(ctx.isGlobal, ctx.cwd);
    const mcpDir = dirname(mcpJsonPath);
    if (!existsSync(mcpDir)) mkdirSync(mcpDir, { recursive: true });

    const existing = readJson(mcpJsonPath) ?? {};
    if (!existing.mcpServers) existing.mcpServers = {};
    const prior = existing.mcpServers[SERVER_NAME] ?? {};
    const priorEnv: Record<string, string> = prior.env ?? {};
    const preserved = Object.keys(priorEnv).filter(k => ctx.envVars[k] === priorEnv[k]);
    existing.mcpServers[SERVER_NAME] = { ...prior, ...mcpCmd, env: ctx.envVars };
    writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
    const kept = Object.keys(priorEnv).length
      ? ` (${preserved.length} of ${Object.keys(priorEnv).length} existing env values carried over)`
      : '';
    return `MCP config: ${mcpJsonPath}${kept}`;
  },

  writeInstructions(ctx: SetupContext, skip: boolean): string {
    const claudeMdPath = ctx.isGlobal
      ? join(homedir(), '.claude', 'CLAUDE.md')
      : join(ctx.cwd, 'CLAUDE.md');

    if (skip) return 'CLAUDE.md: skipped (--no-instructions)';

    const title = ctx.isGlobal ? '# Global Instructions' : `# ${basename(ctx.cwd)}`;
    return upsertAwmSection(claudeMdPath, AWM_INSTRUCTION_CONTENT, { titleIfNew: title });
  },

  writeHooks(ctx: SetupContext, skip: boolean): string {
    if (skip) return 'Hooks: skipped (--no-hooks)';

    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings: any = readJson(settingsPath) ?? {};
    if (!settings.hooks) settings.hooks = {};

    // 0.14.6: hooks are scripts that resolve the sidecar, the agent and the secret at run
    // time (see hook-scripts.ts). Nothing about ports or secrets is baked into settings.json.
    const hooksDir = join(homedir(), '.claude', 'hooks');
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
    for (const { file, source } of HOOK_SCRIPTS) {
      writeFileSync(join(hooksDir, file), source);
    }
    const record: HooksRecord = {
      version: AWM_HOOKS_VERSION,
      agentId: ctx.agentId,
      dbPath: ctx.envVars.AWM_DB_PATH,
      secretPath: join(dirname(ctx.dbPath), '.awm-hook-secret').replace(/\\/g, '/'),
      hookPort: ctx.hookPort,
      hookPortRange: ctx.hookPortRange,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(join(hooksDir, 'awm-hooks.json'), JSON.stringify(record, null, 2) + '\n');
    const script = (file: string) => `node "${join(hooksDir, file).replace(/\\/g, '/')}"`;

    // Stop — remind Claude to write/recall/switch tasks
    setHookGroup(settings, 'Stop', {
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'echo "MEMORY: (1) Did you learn anything new? Call memory_write. (2) Are you about to work on a topic you might have prior knowledge about? Call memory_recall. (3) Switching tasks? Call memory_task_begin."',
        timeout: 5,
        async: true,
      }],
    });

    // PreCompact — auto-checkpoint before context compaction
    setHookGroup(settings, 'PreCompact', {
      matcher: '',
      hooks: [{ type: 'command', command: script('awm-checkpoint.cjs'), timeout: 10 }],
    });

    // SessionEnd — auto-checkpoint on session close (+ consolidation in the sidecar)
    setHookGroup(settings, 'SessionEnd', {
      matcher: '',
      hooks: [{ type: 'command', command: script('awm-checkpoint.cjs'), timeout: 8 }],
    });

    // UserPromptSubmit — PRIME: inject relevant memories, or nothing (0.14.6)
    setHookGroup(settings, 'UserPromptSubmit', ctx.installPrime ? {
      matcher: '',
      hooks: [{ type: 'command', command: script('awm-prime.cjs'), timeout: 6 }],
    } : null);

    // PostToolUse — DB-mutation reminder: a production data change is not
    // complete until it is memory_written.
    const mutationHookPath = join(hooksDir, 'awm-db-mutation-reminder.cjs');
    writeFileSync(mutationHookPath, DB_MUTATION_HOOK_SCRIPT);
    setHookGroup(settings, 'PostToolUse', {
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: script('awm-db-mutation-reminder.cjs'), timeout: 10 }],
    });

    const settingsDir = dirname(settingsPath);
    if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    const lastPort = Number(ctx.hookPort) + Number(ctx.hookPortRange) - 1;
    const primeNote = ctx.installPrime
      ? `UserPromptSubmit prime (off switch: create ${join(hooksDir, PRIME_DISABLE_FILE).replace(/\\/g, '/')})`
      : 'prime skipped (--no-prime)';
    return `Hooks: Stop + PreCompact/SessionEnd checkpoint + ${primeNote} + PostToolUse DB-mutation reminder\n` +
           `               scripts in ${hooksDir.replace(/\\/g, '/')} find this session's sidecar on ports ${ctx.hookPort}–${lastPort} at run time`;
  },

  async diagnose(ctx: SetupContext): Promise<DiagnosticResult[]> {
    const results: DiagnosticResult[] = [];
    const rerun = `Re-run: awm setup claude-code${ctx.isGlobal ? ' --global' : ''}`;

    // Check MCP config — Claude Code reads from both locations, check all
    const globalPath = join(homedir(), '.mcp.json');
    const projectPath = join(ctx.cwd, '.claude', 'mcp.json');
    const candidates = [projectPath, globalPath];

    let foundConfig = false;
    let configuredEnv: Record<string, string> = {};
    for (const mcpJsonPath of candidates) {
      const entry = readJson(mcpJsonPath)?.mcpServers?.[SERVER_NAME];
      if (!entry) continue;
      configuredEnv = entry.env ?? {};
      const agentNote = configuredEnv.AWM_AGENT_ID
        ? ` (agent ${configuredEnv.AWM_AGENT_ID})`
        : ' (no AWM_AGENT_ID — the server derives it from the directory)';
      results.push({ check: 'MCP config', status: 'ok', message: `AWM registered in ${mcpJsonPath}${agentNote}` });
      const missing = ['AWM_RERANK2', 'AWM_RERANK_WINDOW', 'AWM_RERANK_TAGS'].filter(k => !(k in configuredEnv));
      if (missing.length) {
        results.push({
          check: 'Recommended env',
          status: 'warn',
          message: `not set: ${missing.join(', ')} (the measured-good retrieval configuration)`,
          fix: `${rerun} — adds them; every other env value you have is kept`,
        });
      }
      foundConfig = true;
      break;
    }
    if (!foundConfig) {
      results.push({ check: 'MCP config', status: 'fail', message: 'No AWM MCP config found', fix: `Run: awm setup claude-code${ctx.isGlobal ? ' --global' : ''}` });
    }

    // Check MCP entrypoint
    if (ctx.hasDist) {
      results.push({ check: 'MCP entrypoint', status: 'ok', message: `dist/mcp.js exists` });
    } else {
      results.push({ check: 'MCP entrypoint', status: 'warn', message: 'dist/mcp.js not found — using dev mode (npx tsx)', fix: 'Run: npm run build' });
    }

    // Check database
    if (existsSync(ctx.dbPath)) {
      results.push({ check: 'Database', status: 'ok', message: ctx.dbPath });
    } else {
      results.push({ check: 'Database', status: 'warn', message: `${ctx.dbPath} not found (will be created on first use)` });
    }

    // Check CLAUDE.md
    const claudeMdPath = ctx.isGlobal
      ? join(homedir(), '.claude', 'CLAUDE.md')
      : join(ctx.cwd, 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, 'utf-8');
      if (content.includes('## Memory (AWM)')) {
        const marked = content.includes('AWM:GENERATED:BEGIN');
        results.push({
          check: 'Instructions',
          status: 'ok',
          message: `CLAUDE.md has AWM section${marked ? '' : ' (hand-maintained, predates generated markers — awm setup leaves it alone)'}`,
        });
      } else {
        results.push({ check: 'Instructions', status: 'warn', message: `CLAUDE.md exists but missing AWM section`, fix: rerun });
      }
    } else {
      results.push({ check: 'Instructions', status: 'warn', message: `CLAUDE.md not found` });
    }

    // Check hooks — scripts present and current, settings pointing at them, no legacy curl
    const hooksDir = join(homedir(), '.claude', 'hooks');
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    if (!settings) {
      results.push({
        check: 'Hooks',
        status: 'warn',
        message: existsSync(settingsPath) ? 'settings.json is not valid JSON' : 'No hooks configured (auto-checkpoint and prime disabled)',
        fix: rerun,
      });
    } else {
      const hooksText = JSON.stringify(settings.hooks ?? {});
      const has = (ev: string, needle: string) => JSON.stringify(settings.hooks?.[ev] ?? []).includes(needle);
      const legacyCurl = /curl[^"]*\/hooks\/checkpoint/.test(hooksText);
      const record = readJson(join(hooksDir, 'awm-hooks.json')) as HooksRecord | null;
      const scriptsPresent = HOOK_SCRIPTS.every(h => existsSync(join(hooksDir, h.file)));
      const checkpointWired = has('PreCompact', 'awm-checkpoint.cjs') && has('SessionEnd', 'awm-checkpoint.cjs');
      const primeWired = has('UserPromptSubmit', 'awm-prime.cjs');
      const primeDisabled = existsSync(join(hooksDir, PRIME_DISABLE_FILE));
      const mutationWired = has('PostToolUse', 'awm-db-mutation-reminder');

      if (legacyCurl || !scriptsPresent || !checkpointWired) {
        results.push({
          check: 'Hooks',
          status: 'warn',
          message: legacyCurl
            ? 'checkpoint hooks are the pre-0.14.6 inline curl (fixed port 8401/8402, secret baked into settings.json)'
            : !scriptsPresent ? 'hook scripts missing from ~/.claude/hooks' : 'checkpoint hooks not wired to awm-checkpoint.cjs',
          fix: rerun,
        });
      } else if (record && record.version !== AWM_HOOKS_VERSION) {
        results.push({ check: 'Hooks', status: 'warn', message: `hook scripts v${record.version}; current is v${AWM_HOOKS_VERSION}`, fix: rerun });
      } else {
        results.push({ check: 'Hooks', status: 'ok', message: `PreCompact + SessionEnd checkpoint via awm-checkpoint.cjs (hooks v${record?.version ?? AWM_HOOKS_VERSION})` });
      }
      if (!primeWired) {
        results.push({ check: 'Prime hook', status: 'warn', message: 'not installed — memory reaches the agent only when it chooses to call memory_recall', fix: `${rerun} (without --no-prime)` });
      } else if (primeDisabled) {
        results.push({ check: 'Prime hook', status: 'warn', message: `installed but OFF (${PRIME_DISABLE_FILE} present)`, fix: `Delete ${join(hooksDir, PRIME_DISABLE_FILE)} to turn it on` });
      } else {
        results.push({ check: 'Prime hook', status: 'ok', message: 'UserPromptSubmit → awm-prime.cjs (memories injected per prompt when confident)' });
      }
      if (!mutationWired) {
        results.push({ check: 'DB-mutation reminder', status: 'warn', message: 'PostToolUse reminder missing', fix: rerun });
      }
    }

    // Live sidecars — the thing the hooks actually talk to
    const basePort = parseInt(configuredEnv.AWM_HOOK_PORT ?? ctx.hookPort, 10) || 8401;
    const range = Math.max(1, parseInt(configuredEnv.AWM_HOOK_PORT_RANGE ?? ctx.hookPortRange, 10) || 10);
    const probes = await Promise.all(Array.from({ length: range }, (_, i) => probeSidecar(basePort + i)));
    const live = probes.filter((s): s is LiveSidecar => s !== null);
    if (live.length === 0) {
      results.push({ check: 'Sidecars', status: 'warn', message: `none listening on ${basePort}–${basePort + range - 1} (normal when no Claude Code session is open)` });
    } else {
      const summary = live.map(s => `${s.port}=${s.agentId ?? '?'}@${s.version}${s.pid ? ` pid ${s.pid}` : ''}`).join(', ');
      results.push({ check: 'Sidecars', status: 'ok', message: `${live.length} live: ${summary}` });
      const agents = [...new Set(live.map(s => s.agentId))];
      const configuredAgent = configuredEnv.AWM_AGENT_ID ?? ctx.agentId;
      if (!agents.includes(configuredAgent)) {
        results.push({
          check: 'Sidecar match',
          status: 'warn',
          message: `no live sidecar serves agent "${configuredAgent}" — hooks from this directory fail open (live agents: ${agents.join(', ')})`,
        });
      }
    }

    return results;
  },
};

export default adapter;
