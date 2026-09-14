#!/usr/bin/env node
// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the Claude Code plugin.  `npm run build:plugin`
 *
 * WHY THIS IS GENERATED AND NOT HAND-WRITTEN
 * ------------------------------------------
 * 0.14.6 exists because the same facts — hook wiring, guidance text, recommended env —
 * lived in two places and only one got updated. A hand-maintained plugin directory would
 * be a third copy of exactly those facts, and it would drift the same way within a
 * release or two.
 *
 * So every file under plugin/ is emitted from the SAME modules `awm setup` uses:
 *   hook scripts + version  <- src/adapters/hook-scripts.ts
 *   the DB-mutation hook    <- src/adapters/claude-code.ts
 *   the agent guidance      <- src/adapters/common.ts  (AWM_INSTRUCTION_CONTENT)
 *   the recommended flags   <- src/adapters/common.ts  (RECOMMENDED_ENV)
 *
 * `npm run check:release` re-runs this and fails if the committed output differs, so the
 * plugin cannot silently fall behind the installer the way the installer fell behind the
 * engine.
 *
 * Requires `npm run build` first — it imports from dist/.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'plugin');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

const distUrl = (p) => pathToFileURL(join(ROOT, 'dist', p)).href;
if (!existsSync(join(ROOT, 'dist', 'adapters', 'hook-scripts.js'))) {
  console.error('\n  dist/ is missing — run `npm run build` first.\n');
  process.exit(1);
}

const { HOOK_SCRIPTS, AWM_HOOKS_VERSION, PRIME_DISABLE_FILE } = await import(distUrl('adapters/hook-scripts.js'));
const { AWM_INSTRUCTION_CONTENT, RECOMMENDED_ENV } = await import(distUrl('adapters/common.js'));
const { DB_MUTATION_HOOK_SCRIPT } = await import(distUrl('adapters/claude-code.js'));

// --check compares instead of writing, so `npm run check:release` can prove the committed
// plugin/ still matches its source. Without it the plugin is just a third copy of the hook
// wiring, waiting to drift exactly the way the installer did.
const CHECK = process.argv.includes('--check');
const drift = [];

const write = (rel, body) => {
  const p = join(OUT, rel);
  const want = body.endsWith('\n') ? body : body + '\n';
  if (CHECK) {
    const have = existsSync(p) ? readFileSync(p, 'utf-8') : null;
    if (have === null) drift.push(rel + ' (missing)');
    else if (have.split('\r\n').join('\n') !== want.split('\r\n').join('\n')) drift.push(rel + ' (differs)');
    return rel;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, want);
  return rel;
};

// A generated tree is rebuilt, never patched: a stale file left behind is the failure
// this script exists to prevent.
if (!CHECK) rmSync(OUT, { recursive: true, force: true });
const written = [];

// ── the hook scripts, byte-identical to what `awm setup` installs ────────────
for (const h of HOOK_SCRIPTS) written.push(write(join('hooks', h.file), h.source));
written.push(write(join('hooks', 'awm-db-mutation-reminder.cjs'), DB_MUTATION_HOOK_SCRIPT));

// ── the launcher ─────────────────────────────────────────────────────────────
// Two jobs a bare `mcpServers` entry cannot do:
//  1. Default the store to ~/.awm/memory.db — the SAME file `awm setup --global` uses.
//     Without this the plugin would quietly open its own empty database and the memory
//     would not actually be shared with the CLI install, which is the entire point.
//  2. Find the package: a global install, a local node_modules, or npx as a last resort.
// Copied from a real source file rather than embedded as a template literal: it is real
// code, it gets syntax-checked and tested, and four layers of backslash escaping inside a
// generator is a defect factory. Only the version is substituted.
written.push(write(join('bin', 'awm-mcp-launcher.cjs'),
  readFileSync(join(ROOT, 'src', 'plugin', 'awm-mcp-launcher.cjs'), 'utf-8')
    .split('__AWM_VERSION__').join(pkg.version)));

// ── hooks.json — same five events `awm setup` wires, via ${CLAUDE_PLUGIN_ROOT} ──
const cmd = (file) => `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${file}"`;
written.push(write(join('hooks', 'hooks.json'), JSON.stringify({ hooks: {
    Stop: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'echo "MEMORY: (1) Did you learn anything new? Call memory_write. (2) Are you about to work on a topic you might have prior knowledge about? Call memory_recall. (3) Switching tasks? Call memory_task_begin."',
        timeout: 5,
        async: true,
      }],
    }],
    PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: cmd('awm-checkpoint.cjs'), timeout: 10 }] }],
    SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: cmd('awm-checkpoint.cjs'), timeout: 8 }] }],
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: cmd('awm-prime.cjs'), timeout: 6 }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd('awm-db-mutation-reminder.cjs'), timeout: 5, async: true }] }],
} }, null, 2)));

// ── the guidance, as a skill rather than an append to the user's CLAUDE.md ────
// Better than what setup does today: loaded on demand, versioned with the plugin, and it
// never edits a file the user owns.
written.push(write(join('skills', 'awm-memory', 'SKILL.md'), `---
name: awm-memory
description: >-
  How to use Agent Working Memory (AWM) — when to call memory_recall before stating a fact or
  searching the filesystem, when to memory_write, how to tag a write so it can be found again,
  and how to read an abstained recall. Load whenever AWM's memory tools are available and you
  are about to state a fact, make a decision, finish a task, or search for something you may
  already know.
---

# Agent Working Memory

Generated from \`src/adapters/common.ts\` (AWM v${pkg.version}) — the same guidance
\`awm setup\` writes into CLAUDE.md. Do not edit here; edit the source and re-run
\`npm run build:plugin\`.

${AWM_INSTRUCTION_CONTENT.trim()}
`));

// ── the manifest ─────────────────────────────────────────────────────────────
written.push(write(join('.claude-plugin', 'plugin.json'), JSON.stringify({
  name: 'awm',
  displayName: 'Agent Working Memory',
  version: pkg.version,
  description: pkg.description,
  author: { name: 'Robert Winter' },
  homepage: 'https://completeideas.github.io/agent-working-memory/',
  repository: 'https://github.com/CompleteIdeas/agent-working-memory',
  license: 'Apache-2.0',
  keywords: ['memory', 'mcp', 'recall', 'agent'],
  skills: './skills/',
  hooks: './hooks/hooks.json',
  mcpServers: {
    'agent-working-memory': {
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/bin/awm-mcp-launcher.cjs'],
      // AWM_SURFACE stamps every write with `surface=claude-code` so the store records
      // which surface a memory came from. Set here, not by the caller.
      env: { ...RECOMMENDED_ENV, AWM_SURFACE: 'claude-code' },
    },
  },
}, null, 2)));

written.push(write('README.md', `# AWM — Claude Code plugin

Installs Agent Working Memory as a plugin: the MCP server, the session hooks, and the usage
guidance, all versioned together. This is the plugin equivalent of \`awm setup --global\`.

**This directory is generated.** \`npm run build:plugin\` emits it from the same modules the
installer uses, and \`npm run check:release\` fails if the committed output has drifted. Edit
\`src/adapters/\`, not these files.

## What it installs

| | |
|---|---|
| MCP server | ${Object.keys({ 'agent-working-memory': 1 }).length} server, 19 memory tools, via \`bin/awm-mcp-launcher.cjs\` |
| Hooks | Stop, PreCompact, SessionEnd, UserPromptSubmit (prime), PostToolUse — hooks v${AWM_HOOKS_VERSION} |
| Skill | \`awm-memory\` — when to recall, when to write, how to tag |

## The store

The launcher defaults \`AWM_DB_PATH\` to \`~/.awm/memory.db\` — **the same file
\`awm setup --global\` uses** — so a plugin install shares memory with a CLI install rather
than quietly starting an empty one. Set \`AWM_DB_PATH\` yourself to override.

It prefers an installed copy of the package (global, or a local \`node_modules\`) and falls
back to \`npx -p agent-working-memory@${pkg.version}\`. The npx path rebuilds
\`better-sqlite3\` on a cold cache, which is slow enough to look like a hang, so a real
install is worth having:

\`\`\`bash
npm install -g agent-working-memory
\`\`\`

## Turning prime off

\`UserPromptSubmit\` primes relevant memory into context. To silence it without uninstalling,
create an empty \`~/.claude/hooks/${PRIME_DISABLE_FILE}\`.
`));

if (CHECK) {
  if (drift.length) {
    console.error(`\n  plugin/ is out of date with src/ — ${drift.length} file(s):\n`);
    for (const d of drift) console.error('    ' + d.split('\\').join('/'));
    console.error(`\n  Fix: npm run build && npm run build:plugin, then commit plugin/\n`);
    process.exit(1);
  }
  console.log(`  plugin/ is in sync (v${pkg.version}, hooks v${AWM_HOOKS_VERSION}, ${written.length} files)`);
  process.exit(0);
}

console.log(`\n  Plugin v${pkg.version} (hooks v${AWM_HOOKS_VERSION}) -> plugin/\n`);
for (const f of written) console.log('    ' + f.split('\\').join('/'));
console.log('');
