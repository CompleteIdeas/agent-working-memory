#!/usr/bin/env node
// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the Claude Desktop extension.  `npm run build:mcpb`
 *
 * An .mcpb is a zip of a local stdio MCP server plus a manifest.json. Desktop installs it in
 * one click, runs it on the user's machine over stdio, and ships its own Node — so there is
 * no runtime to install.
 *
 * THIS IS THE THIN BUNDLE, AND THAT IS A DELIBERATE CHOICE
 * -------------------------------------------------------
 * MCPB's pitch is "bundles all dependencies". Taken literally for AWM that is ~350 MB:
 * onnxruntime-node alone is 208 MB because it carries darwin, linux and win32 binaries, and
 * better-sqlite3 compiles per platform, so it would also have to be three separate bundles.
 *
 * Instead this ships the manifest and the launcher — about 50 KB — and the launcher finds an
 * installed `agent-working-memory`. The cost is one `npm install -g` before the one-click
 * install, which is stated plainly in the description the user reads at install time rather
 * than discovered later as a broken extension.
 *
 * Fat per-platform bundles remain possible; they are a release-pipeline job, not a
 * packaging tweak, and nothing here forecloses them.
 *
 * Requires `npm run build` first (for dist/) and reuses the SAME launcher the Claude Code
 * plugin uses, so the two surfaces cannot diverge on how they find the server or the store.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'mcpb');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

if (!existsSync(join(ROOT, 'dist', 'adapters', 'common.js'))) {
  console.error('\n  dist/ is missing — run `npm run build` first.\n');
  process.exit(1);
}
const { RECOMMENDED_ENV } = await import(pathToFileURL(join(ROOT, 'dist', 'adapters', 'common.js')).href);

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

if (!CHECK) rmSync(OUT, { recursive: true, force: true });
const written = [];

// The same launcher the Claude Code plugin ships. One resolution order, one default store,
// one place to fix a bug in either.
written.push(write(join('server', 'awm-mcp-launcher.cjs'),
  readFileSync(join(ROOT, 'src', 'plugin', 'awm-mcp-launcher.cjs'), 'utf-8')
    .split('__AWM_VERSION__').join(pkg.version)));

// Tool names are NOT listed in the manifest. `tools_generated: true` says they are determined
// at runtime, which is true, and avoids putting a fourth copy of the tool list in a file that
// would then need updating every time one is added.
written.push(write('manifest.json', JSON.stringify({
  manifest_version: '0.3',
  name: 'agent-working-memory',
  display_name: 'Agent Working Memory',
  version: pkg.version,
  description: 'Persistent local memory for Claude. Requires `npm install -g agent-working-memory` first.',
  long_description: [
    'Gives Claude a memory that survives the conversation — and knows when to stay quiet.',
    '',
    'Nineteen memory tools: write what you learn, recall it later, correct it when reality',
    'changes. Selective by design — it filters what is worth keeping and returns nothing when',
    'nothing fits, rather than the best of a bad set.',
    '',
    'Everything stays on this machine: one SQLite file, three small local models, no cloud and',
    'no API keys. By default it opens `~/.awm/memory.db`, the same store the Claude Code',
    'install uses, so memory written in one is recalled in the other.',
    '',
    '**Prerequisite:** this extension ships the wiring, not the engine. Install the package',
    'first with `npm install -g agent-working-memory` (Node 22+). Without it the extension',
    'falls back to `npx`, which works but rebuilds a native dependency on first run and can',
    'look like a hang.',
  ].join('\n'),
  author: { name: 'Robert Winter', url: 'https://github.com/CompleteIdeas' },
  repository: { type: 'git', url: 'https://github.com/CompleteIdeas/agent-working-memory' },
  homepage: 'https://completeideas.github.io/agent-working-memory/',
  documentation: 'https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/desktop.md',
  support: 'https://github.com/CompleteIdeas/agent-working-memory/issues',
  license: 'Apache-2.0',
  keywords: ['memory', 'recall', 'local-first', 'sqlite', 'agent'],
  tools_generated: true,
  server: {
    type: 'node',
    entry_point: 'server/awm-mcp-launcher.cjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/awm-mcp-launcher.cjs'],
      env: {
        // ${HOME} is expanded by Desktop, so the default store needs no launcher trickery.
        AWM_DB_PATH: '${user_config.db_path}',
        AWM_AGENT_ID: '${user_config.agent_id}',
        // Lets someone with a checkout skip the global install entirely.
        AWM_PACKAGE_ROOT: '${user_config.package_root}',
        // Stamps every write with `surface=claude-desktop`.
        AWM_SURFACE: 'claude-desktop',
        ...RECOMMENDED_ENV,
      },
    },
  },
  user_config: {
    db_path: {
      type: 'file',
      title: 'Memory database',
      description:
        'Where memories are stored. Leave the default to share one store with a Claude Code '
        + 'install — anything written there is recalled here and the other way round.',
      default: '${HOME}/.awm/memory.db',
      required: false,
      sensitive: false,
    },
    agent_id: {
      type: 'string',
      title: 'Memory pool',
      description:
        'Which pool this reads and writes: "work" or "personal". Claude Code derives this from '
        + 'the project directory, but Desktop has no project, so choose one here. Leave blank '
        + 'to let the server decide (it will choose "work").',
      default: 'work',
      required: false,
    },
    package_root: {
      type: 'directory',
      title: 'AWM installation (optional)',
      description:
        'Only needed if you have not run `npm install -g agent-working-memory`. Point this at '
        + 'a checkout of the repository and the extension will use it directly, which skips '
        + 'the global install and the slow first-run fallback.',
      required: false,
    },
  },
  compatibility: {
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=22.0.0' },
  },
}, null, 2)));

written.push(write('README.md', `# Agent Working Memory — Claude Desktop extension

**Generated.** \`npm run build:mcpb\` emits this from \`src/\`; \`npm run check:release\` fails if
the committed output has drifted. Edit the source, not these files.

## Build the installable bundle

\`\`\`bash
npm install -g @anthropic-ai/mcpb   # once
npm run build && npm run build:mcpb
npm run pack:mcpb                   # -> dist-mcpb/agent-working-memory-<version>.mcpb
\`\`\`

Install the result by double-clicking it, dragging it onto the Claude Desktop window, or
**Settings → Extensions → Advanced settings → Install Extension…**

## Why this bundle is small

MCPB normally vendors every dependency. For AWM that would be roughly 350 MB —
\`onnxruntime-node\` alone is 208 MB because it carries darwin, linux and win32 binaries — and
\`better-sqlite3\` compiles per platform, so it would have to be three separate bundles.

This ships the manifest and the launcher instead, and the launcher finds an installed
\`agent-working-memory\`. The trade is one prerequisite:

\`\`\`bash
npm install -g agent-working-memory
\`\`\`

That requirement is in the description the user reads at install time, rather than being
discovered afterwards as an extension that does nothing.

## The store

\`AWM_DB_PATH\` defaults to \`\${HOME}/.awm/memory.db\` — the same file \`awm setup --global\` and
the Claude Code plugin use. Memory written in one surface is recalled in the other. Desktop
shows it as a configurable field at install time.

Desktop has no project directory, so the agent pool cannot be derived the way Claude Code
derives it. The manifest exposes it as a setting, defaulting to \`work\`.
`));

if (CHECK) {
  if (drift.length) {
    console.error(`\n  mcpb/ is out of date with src/ — ${drift.length} file(s):\n`);
    for (const d of drift) console.error('    ' + d.split('\\').join('/'));
    console.error('\n  Fix: npm run build && npm run build:mcpb, then commit mcpb/\n');
    process.exit(1);
  }
  console.log(`  mcpb/ is in sync (v${pkg.version}, ${written.length} files)`);
  process.exit(0);
}

console.log(`\n  Desktop extension v${pkg.version} -> mcpb/\n`);
for (const f of written) console.log('    ' + f.split('\\').join('/'));

// --pack produces the installable artifact. Kept here rather than as an escaped one-liner
// in package.json: the version has to be interpolated into the filename, and quoting that
// through npm on Windows is exactly the kind of thing that ships broken.
if (process.argv.includes('--pack')) {
  const outDir = join(ROOT, 'dist-mcpb');
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, `agent-working-memory-${pkg.version}.mcpb`);
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'mcpb.cmd' : 'mcpb', ['pack', OUT, target],
    { stdio: 'inherit', shell: isWin });
  if (r.error || r.status !== 0) {
    console.error('\n  pack failed. Install the CLI:  npm install -g @anthropic-ai/mcpb\n');
    process.exit(1);
  }
  console.log(`\n  Packed: ${target}\n`);
} else {
  console.log(`\n  Pack it with:  npm run pack:mcpb\n`);
}
