// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor adapter — writes .cursor/mcp.json and .cursorrules.
 *
 * Cursor uses the same MCP config format as Claude Code (JSON with mcpServers).
 * Instructions go in .cursorrules (project) or ~/.cursor/rules (global).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { CLIAdapter, SetupContext, DiagnosticResult } from './types.js';
import { resolveMcpCommand, homedir, AWM_INSTRUCTION_CONTENT } from './common.js';

const adapter: CLIAdapter = {
  id: 'cursor',
  name: 'Cursor',
  supportsProjectScope: true,
  supportsGlobalScope: true,

  writeMcpConfig(ctx: SetupContext): string {
    const mcpCmd = resolveMcpCommand(ctx);
    const mcpConfig = { ...mcpCmd, env: ctx.envVars };

    const mcpJsonPath = ctx.isGlobal
      ? join(homedir(), '.cursor', 'mcp.json')
      : join(ctx.cwd, '.cursor', 'mcp.json');

    const mcpDir = dirname(mcpJsonPath);
    if (!existsSync(mcpDir)) {
      mkdirSync(mcpDir, { recursive: true });
    }

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
    return `MCP config: ${mcpJsonPath}`;
  },

  writeInstructions(ctx: SetupContext, skip: boolean): string {
    const rulesPath = ctx.isGlobal
      ? join(homedir(), '.cursor', 'rules')
      : join(ctx.cwd, '.cursorrules');

    if (skip) return '.cursorrules: skipped (--no-instructions)';

    const dir = dirname(rulesPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(rulesPath)) {
      const content = readFileSync(rulesPath, 'utf-8');
      if (content.includes('## Memory (AWM)')) {
        return '.cursorrules: already has AWM section (skipped)';
      }
      writeFileSync(rulesPath, content.trimEnd() + '\n\n' + AWM_INSTRUCTION_CONTENT);
      return '.cursorrules: appended AWM workflow section';
    }

    writeFileSync(rulesPath, AWM_INSTRUCTION_CONTENT);
    return '.cursorrules: created with AWM workflow section';
  },

  writeHooks(_ctx: SetupContext, _skip: boolean): string {
    return 'Hooks: not supported by Cursor (auto-checkpoint unavailable)';
  },

  diagnose(ctx: SetupContext): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    // Check MCP config
    const mcpJsonPath = ctx.isGlobal
      ? join(homedir(), '.cursor', 'mcp.json')
      : join(ctx.cwd, '.cursor', 'mcp.json');

    if (!existsSync(mcpJsonPath)) {
      results.push({
        check: 'MCP config',
        status: 'fail',
        message: `${mcpJsonPath} not found`,
        fix: `Run: awm setup cursor${ctx.isGlobal ? ' --global' : ''}`,
      });
    } else {
      try {
        const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        if (config.mcpServers?.['agent-working-memory']) {
          results.push({ check: 'MCP config', status: 'ok', message: `AWM registered in ${mcpJsonPath}` });
        } else {
          results.push({
            check: 'MCP config',
            status: 'fail',
            message: `${mcpJsonPath} exists but missing agent-working-memory entry`,
            fix: `Run: awm setup cursor${ctx.isGlobal ? ' --global' : ''}`,
          });
        }
      } catch {
        results.push({ check: 'MCP config', status: 'fail', message: `${mcpJsonPath} is not valid JSON` });
      }
    }

    // Check entrypoint
    if (ctx.hasDist) {
      results.push({ check: 'MCP entrypoint', status: 'ok', message: 'dist/mcp.js exists' });
    } else {
      results.push({
        check: 'MCP entrypoint',
        status: 'warn',
        message: 'dist/mcp.js not found — using dev mode',
        fix: 'Run: npm run build',
      });
    }

    // Check database
    if (existsSync(ctx.dbPath)) {
      results.push({ check: 'Database', status: 'ok', message: ctx.dbPath });
    } else {
      results.push({ check: 'Database', status: 'warn', message: `${ctx.dbPath} not found` });
    }

    // Check instructions
    const rulesPath = ctx.isGlobal
      ? join(homedir(), '.cursor', 'rules')
      : join(ctx.cwd, '.cursorrules');
    if (existsSync(rulesPath)) {
      const content = readFileSync(rulesPath, 'utf-8');
      if (content.includes('## Memory (AWM)')) {
        results.push({ check: 'Instructions', status: 'ok', message: '.cursorrules has AWM section' });
      } else {
        results.push({ check: 'Instructions', status: 'warn', message: '.cursorrules exists but missing AWM section' });
      }
    } else {
      results.push({ check: 'Instructions', status: 'warn', message: '.cursorrules not found' });
    }

    return results;
  },
};

export default adapter;
