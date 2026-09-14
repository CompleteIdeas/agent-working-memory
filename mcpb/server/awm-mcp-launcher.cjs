#!/usr/bin/env node
// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
//
// Entry point for the Claude Code plugin's MCP server.
//
// This is a REAL source file, not a string inside the generator, because it is real code:
// it gets syntax-checked, linted and tested like everything else. `npm run build:plugin`
// copies it to plugin/bin/ and substitutes 0.15.2.
//
// Two jobs a bare `mcpServers` entry in plugin.json cannot do:
//
//   1. Default the store to ~/.awm/memory.db — the SAME file `awm setup --global` writes.
//      Without this the plugin opens its own empty database and "your memory follows you
//      between Claude Code, Desktop and Cowork" is simply false.
//
//   2. Find the server. A plugin does not know whether the package is installed globally,
//      sits in a local node_modules, or is a checkout on disk.
//
// Fails loudly on stderr. A silent exit here looks like "the memory tools just aren't there",
// which is the least debuggable failure this could have.
'use strict';

const { join, resolve, sep } = require('node:path');
const { homedir } = require('node:os');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn, execFileSync } = require('node:child_process');

const NL = '\n';

// Claude Desktop substitutes user_config values into env, and a field the user cleared
// arrives as an empty string rather than being absent. An empty AWM_AGENT_ID would override
// the server's directory-derived default with nothing, so drop empties before anything reads
// them and let the normal defaults apply.
for (const k of ['AWM_DB_PATH', 'AWM_AGENT_ID', 'AWM_HOOK_PORT', 'AWM_PACKAGE_ROOT']) {
  if (process.env[k] !== undefined && String(process.env[k]).trim() === '') delete process.env[k];
}

// An explicit AWM_DB_PATH always wins, so per-project pools still work.
if (!process.env.AWM_DB_PATH) {
  process.env.AWM_DB_PATH = join(homedir(), '.awm', 'memory.db').split(sep).join('/');
}

const tried = [];
function candidate(p) {
  if (!p) return null;
  tried.push(p);
  return existsSync(p) ? p : null;
}

// In priority order. npx is last: on a cold cache it rebuilds better-sqlite3, which takes
// minutes and is indistinguishable from a hang.
let found =
  // 1. An explicit override.
  candidate(process.env.AWM_PACKAGE_ROOT && join(process.env.AWM_PACKAGE_ROOT, 'dist', 'mcp.js')) ||
  // 2. The plugin sitting inside an AWM checkout (plugin/bin -> ../../dist).
  candidate(resolve(__dirname, '..', '..', 'dist', 'mcp.js')) ||
  // 3. A local dependency of the project being worked on.
  candidate(join(process.cwd(), 'node_modules', 'agent-working-memory', 'dist', 'mcp.js'));

// 4. A global install. require.resolve does not search global roots, so ask npm once.
if (!found) {
  try {
    const isWin = process.platform === 'win32';
    const root = execFileSync(isWin ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf-8',
      shell: isWin,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    found = candidate(root && join(root, 'agent-working-memory', 'dist', 'mcp.js'));
  } catch {
    /* npm not on PATH — fall through */
  }
}

// 5. Anywhere node can resolve it from here.
if (!found) {
  try {
    found = require.resolve('agent-working-memory/dist/mcp.js');
  } catch {
    /* not installed where this script can see it */
  }
}

if (found) {
  // dist/ is ESM ("type": "module"), so import() — require() throws ERR_REQUIRE_ESM.
  import(pathToFileURL(found).href).catch((e) => {
    process.stderr.write('[awm] failed to load ' + found + ': ' + e.message + NL);
    process.exit(1);
  });
} else {
  // Last resort, pinned so the tools match the hook scripts shipped beside them.
  // shell:true on Windows: spawning npx.cmd directly throws EINVAL since Node 18.20/20.12.
  const isWin = process.platform === 'win32';
  const child = spawn(
    isWin ? 'npx.cmd' : 'npx',
    ['-y', '-p', 'agent-working-memory@0.15.2', 'awm', 'mcp'],
    { stdio: 'inherit', env: process.env, shell: isWin }
  );
  child.on('error', (e) => {
    process.stderr.write('[awm] could not start the MCP server: ' + e.message + NL);
    process.stderr.write('[awm] looked in:' + NL);
    for (const t of tried) process.stderr.write('  ' + t + NL);
    process.stderr.write('[awm] fix: npm install -g agent-working-memory' + NL);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
}
