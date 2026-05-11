// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP adapter — generic fallback for any tool that can make REST calls.
 *
 * Doesn't write MCP config. Prints connection instructions for the HTTP API.
 * Optionally writes an instruction file.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CLIAdapter, SetupContext, DiagnosticResult } from './types.js';
import { AWM_INSTRUCTION_CONTENT, upsertAwmSection } from './common.js';

const HTTP_ADDENDUM = `
### HTTP API (for tools without MCP support)

If your tool doesn't support MCP, use the HTTP API directly:

**Base URL:** \`http://127.0.0.1:8400\`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /memory/restore/:agentId | Restore context from prior sessions |
| POST | /memory/activate | Cognitive recall (use \`context\` field) |
| POST | /memory/write | Write a memory |
| POST | /memory/feedback | Report if memory was useful |
| POST | /memory/retract | Invalidate a wrong memory |
| POST | /memory/checkpoint | Save execution state |
| POST | /task/create | Create a task |
| POST | /task/update | Update task status |
| GET | /task/list/:agentId | List tasks |
| GET | /task/next/:agentId | Get next actionable task |
| GET | /health | Health check |

Start the server with: \`awm serve\`
`;

const adapter: CLIAdapter = {
  id: 'http',
  name: 'HTTP (generic)',
  supportsProjectScope: true,
  supportsGlobalScope: false,

  writeMcpConfig(ctx: SetupContext): string {
    const port = process.env.AWM_PORT ?? '8400';
    return `MCP config: N/A (HTTP mode)\n  Start server: awm serve --port ${port}\n  Base URL: http://127.0.0.1:${port}`;
  },

  writeInstructions(ctx: SetupContext, skip: boolean): string {
    const instrPath = join(ctx.cwd, 'AWM-INSTRUCTIONS.md');

    if (skip) return 'AWM-INSTRUCTIONS.md: skipped (--no-instructions)';

    return upsertAwmSection(instrPath, AWM_INSTRUCTION_CONTENT, {
      titleIfNew: '# Agent Working Memory',
      suffix: HTTP_ADDENDUM,
    });
  },

  writeHooks(_ctx: SetupContext, _skip: boolean): string {
    return 'Hooks: N/A (HTTP mode)';
  },

  diagnose(ctx: SetupContext): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    // Check database
    if (existsSync(ctx.dbPath)) {
      results.push({ check: 'Database', status: 'ok', message: ctx.dbPath });
    } else {
      results.push({ check: 'Database', status: 'warn', message: `${ctx.dbPath} not found` });
    }

    // Check if HTTP server is reachable
    // (can't do async in diagnose, so just check if the entrypoint exists)
    if (ctx.hasDist) {
      results.push({ check: 'Server entrypoint', status: 'ok', message: 'dist/index.js exists' });
    } else {
      results.push({
        check: 'Server entrypoint',
        status: 'warn',
        message: 'dist/index.js not found — use: npx tsx src/index.ts',
        fix: 'Run: npm run build',
      });
    }

    return results;
  },
};

export default adapter;
