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

const adapter: CLIAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  supportsProjectScope: true,
  supportsGlobalScope: true,

  writeMcpConfig(ctx: SetupContext): string {
    const mcpCmd = resolveMcpCommand(ctx);
    const mcpConfig = { ...mcpCmd, env: ctx.envVars };

    // Global: ~/.mcp.json (standard MCP location, all projects)
    // Project: .claude/mcp.json (Claude Code's native project scope)
    const mcpJsonPath = ctx.isGlobal
      ? join(homedir(), '.mcp.json')
      : join(ctx.cwd, '.claude', 'mcp.json');

    const mcpDir = dirname(mcpJsonPath);
    if (!existsSync(mcpDir)) {
      mkdirSync(mcpDir, { recursive: true });
    }

    let existing: any = {};
    if (existsSync(mcpJsonPath)) {
      try {
        existing = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      } catch {
        existing = {};
      }
    }
    if (!existing.mcpServers) existing.mcpServers = {};

    existing.mcpServers['agent-working-memory'] = mcpConfig;
    writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
    return `MCP config: ${mcpJsonPath}`;
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
    let settings: any = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch {
        settings = {};
      }
    }
    if (!settings.hooks) settings.hooks = {};

    const hookUrl = `http://127.0.0.1:${ctx.hookPort}/hooks/checkpoint`;

    // Stop — remind Claude to write/recall/switch tasks
    settings.hooks.Stop = [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'echo "MEMORY: (1) Did you learn anything new? Call memory_write. (2) Are you about to work on a topic you might have prior knowledge about? Call memory_recall. (3) Switching tasks? Call memory_task_begin."',
        timeout: 5,
        async: true,
      }],
    }];

    // Multi-port fallback for separate memory pools
    const altPort = ctx.hookPort === '8401' ? '8402' : '8401';
    const hookUrlAlt = `http://127.0.0.1:${altPort}/hooks/checkpoint`;
    const buildHookCmd = (event: string, maxTime: number) => {
      const primary = `curl -sf -X POST ${hookUrl} -H "Content-Type: application/json" -H "Authorization: Bearer ${ctx.hookSecret}" -d "{\\"hook_event_name\\":\\"${event}\\"}" --max-time ${maxTime}`;
      const fallback = `curl -sf -X POST ${hookUrlAlt} -H "Content-Type: application/json" -H "Authorization: Bearer ${ctx.hookSecret}" -d "{\\"hook_event_name\\":\\"${event}\\"}" --max-time ${maxTime}`;
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

    // SessionEnd — auto-checkpoint on session close
    settings.hooks.SessionEnd = [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: buildHookCmd('SessionEnd', 2),
        timeout: 5,
      }],
    }];

    const settingsDir = dirname(settingsPath);
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true });
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return `Hooks: Stop + PreCompact + SessionEnd (port ${ctx.hookPort})`;
  },

  diagnose(ctx: SetupContext): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    // Check MCP config — Claude Code reads from both locations, check all
    const globalPath = join(homedir(), '.mcp.json');
    const projectPath = join(ctx.cwd, '.claude', 'mcp.json');
    const candidates = [projectPath, globalPath];

    let foundConfig = false;
    for (const mcpJsonPath of candidates) {
      if (!existsSync(mcpJsonPath)) continue;
      try {
        const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        if (config.mcpServers?.['agent-working-memory']) {
          results.push({ check: 'MCP config', status: 'ok', message: `AWM registered in ${mcpJsonPath}` });
          foundConfig = true;
          break;
        }
      } catch { /* not valid JSON, skip */ }
    }
    if (!foundConfig) {
      results.push({
        check: 'MCP config',
        status: 'fail',
        message: 'No AWM MCP config found',
        fix: `Run: awm setup claude-code${ctx.isGlobal ? ' --global' : ''}`,
      });
    }

    // Check MCP entrypoint
    if (ctx.hasDist) {
      results.push({ check: 'MCP entrypoint', status: 'ok', message: `dist/mcp.js exists` });
    } else {
      results.push({
        check: 'MCP entrypoint',
        status: 'warn',
        message: 'dist/mcp.js not found — using dev mode (npx tsx)',
        fix: 'Run: npm run build',
      });
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
        results.push({ check: 'Instructions', status: 'ok', message: `CLAUDE.md has AWM section` });
      } else {
        results.push({
          check: 'Instructions',
          status: 'warn',
          message: `CLAUDE.md exists but missing AWM section`,
          fix: `Run: awm setup claude-code${ctx.isGlobal ? ' --global' : ''}`,
        });
      }
    } else {
      results.push({ check: 'Instructions', status: 'warn', message: `CLAUDE.md not found` });
    }

    // Check hooks
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const hasHooks = settings.hooks?.PreCompact && settings.hooks?.SessionEnd;
        if (hasHooks) {
          results.push({ check: 'Hooks', status: 'ok', message: 'PreCompact + SessionEnd configured' });
        } else {
          results.push({ check: 'Hooks', status: 'warn', message: 'Hooks partially configured' });
        }
      } catch {
        results.push({ check: 'Hooks', status: 'warn', message: 'settings.json is not valid JSON' });
      }
    } else {
      results.push({ check: 'Hooks', status: 'warn', message: 'No hooks configured (auto-checkpoint disabled)' });
    }

    return results;
  },
};

export default adapter;
