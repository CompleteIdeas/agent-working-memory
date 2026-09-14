// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
//
// The install path for the Claude Code plugin.
//
// WHY THIS EXISTS
// ---------------
// A plugin that generates cleanly can still be uninstallable: a marketplace entry pointing
// at the wrong directory, a plugin.json referencing a path that was never written, a hook
// command naming a script that does not exist. None of that is caught by `npm run
// build:plugin`, and none of it shows up until someone types `/plugin install` and gets
// nothing.
//
// So this walks the same steps Claude Code does — resolve the marketplace entry, read the
// manifest, expand ${CLAUDE_PLUGIN_ROOT}, check every referenced file is really there, then
// actually start the MCP server over stdio and run the hooks.
//
// The MCP test uses a scratch database on purpose. The launcher's whole job is to default to
// ~/.awm/memory.db — the user's real store — so a test that forgot to override it would
// write into production memory.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = resolve(__dirname, '..', '..');
const MARKETPLACE = join(ROOT, '.claude-plugin', 'marketplace.json');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

/** Claude Code substitutes this before running anything the manifest names. */
function expandPluginRoot(s: string, pluginRoot: string): string {
  return s.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot.split('\\').join('/'));
}

/** Every filesystem path a command string refers to inside the plugin. */
function pathsIn(command: string, pluginRoot: string): string[] {
  const expanded = expandPluginRoot(command, pluginRoot);
  return [...expanded.matchAll(/"([^"]+\.(?:cjs|mjs|js))"/g)].map(m => m[1]);
}

describe('claude code plugin — the install path', () => {
  let marketplace: any;
  let pluginDir: string;
  let manifest: any;

  beforeAll(() => {
    marketplace = readJson(MARKETPLACE);
    // Claude Code resolves `source` relative to the directory holding .claude-plugin/.
    pluginDir = resolve(ROOT, marketplace.plugins[0].source);
    manifest = readJson(join(pluginDir, '.claude-plugin', 'plugin.json'));
  });

  it('the marketplace manifest has the fields Claude Code requires', () => {
    expect(marketplace.name).toMatch(/^[a-z0-9-]+$/);
    expect(marketplace.owner?.name).toBeTruthy();
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
    for (const p of marketplace.plugins) {
      expect(p.name, 'plugin name must be kebab-case').toMatch(/^[a-z0-9-]+$/);
      expect(p.source, 'plugin entry needs a source').toBeTruthy();
    }
  });

  it('the marketplace source resolves to a real plugin directory', () => {
    expect(existsSync(pluginDir), `source did not resolve: ${pluginDir}`).toBe(true);
    expect(existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('the plugin version tracks the package version', () => {
    const pkg = readJson(join(ROOT, 'package.json'));
    expect(manifest.version).toBe(pkg.version);
  });

  // The failure this catches: a manifest that names a directory the generator never wrote.
  it('every path the manifest references exists', () => {
    const missing: string[] = [];
    if (manifest.skills) {
      const dir = resolve(pluginDir, manifest.skills);
      if (!existsSync(dir)) missing.push(`skills: ${dir}`);
    }
    if (manifest.hooks) {
      const f = resolve(pluginDir, manifest.hooks);
      if (!existsSync(f)) missing.push(`hooks: ${f}`);
    }
    for (const [name, server] of Object.entries<any>(manifest.mcpServers ?? {})) {
      for (const p of pathsIn((server.args ?? []).map((a: string) => `"${a}"`).join(' '), pluginDir)) {
        if (!existsSync(p)) missing.push(`mcpServers.${name}: ${p}`);
      }
    }
    expect(missing, `manifest references files that do not exist:\n${missing.join('\n')}`).toEqual([]);
  });

  it('the declared skill is loadable — frontmatter with a name and description', () => {
    const skill = readFileSync(join(pluginDir, 'skills', 'awm-memory', 'SKILL.md'), 'utf-8');
    expect(skill.startsWith('---')).toBe(true);
    const fm = skill.slice(3, skill.indexOf('---', 3));
    expect(fm).toMatch(/name:\s*awm-memory/);
    expect(fm).toMatch(/description:/);
    // The guidance itself, not just a stub.
    expect(skill.length).toBeGreaterThan(5000);
  });

  it('every hook command points at a script that exists and parses', () => {
    const hooks = readJson(resolve(pluginDir, manifest.hooks));
    const events = Object.keys(hooks);
    expect(events).toEqual(
      expect.arrayContaining(['Stop', 'PreCompact', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse']),
    );
    for (const [event, groups] of Object.entries<any>(hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          expect(h.type, `${event} hook type`).toBe('command');
          for (const p of pathsIn(h.command, pluginDir)) {
            expect(existsSync(p), `${event} names a missing script: ${p}`).toBe(true);
            const parsed = spawnSync(process.execPath, ['--check', p], { encoding: 'utf-8' });
            expect(parsed.status, `${event} script does not parse: ${p}\n${parsed.stderr}`).toBe(0);
          }
        }
      }
    }
  });

  it('the shipped hook scripts are byte-identical to what `awm setup` installs', async () => {
    const mod = await import('../../src/adapters/hook-scripts.js');
    for (const h of mod.HOOK_SCRIPTS) {
      const onDisk = readFileSync(join(pluginDir, 'hooks', h.file), 'utf-8').split('\r\n').join('\n');
      const want = h.source.endsWith('\n') ? h.source : h.source + '\n';
      expect(onDisk, `${h.file} has drifted from HOOK_SCRIPTS`).toBe(want);
    }
  });

  // The one that actually proves the plugin works: drive the launcher over stdio exactly as
  // Claude Code does, and require the full tool surface back.
  it('the launcher starts the MCP server and serves every tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awm-plugin-'));
    try {
      const launcher = join(pluginDir, 'bin', 'awm-mcp-launcher.cjs');
      const child = spawn(process.execPath, [launcher], {
        env: {
          ...process.env,
          AWM_DB_PATH: join(dir, 'scratch.db'),   // never the real store
          AWM_AGENT_ID: 'plugin-install-test',
          AWM_HOOK_PORT: '18500',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
      const tools = await new Promise<string[]>((res, rej) => {
        let buf = '';
        const timer = setTimeout(() => { child.kill(); rej(new Error('launcher never answered')); }, 90_000);
        child.stdout.on('data', d => {
          buf += d;
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let m: any;
            try { m = JSON.parse(line); } catch { continue; }
            if (m.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
            if (m.id === 2) {
              clearTimeout(timer);
              child.kill();
              res((m.result?.tools ?? []).map((t: any) => t.name));
            }
          }
        });
        child.on('error', rej);
        send({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        });
      });

      expect(tools).toContain('memory_recall');
      expect(tools).toContain('memory_write');
      expect(tools).toContain('memory_whoami');
      expect(tools.length).toBeGreaterThanOrEqual(19);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // A hook that throws would break the session it is attached to. They must fail open.
  it('hooks exit 0 and stay silent when no sidecar is running', () => {
    const prime = join(pluginDir, 'hooks', 'awm-prime.cjs');
    const r = spawnSync(process.execPath, [prime], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: ROOT, prompt: 'a'.repeat(40) }),
      env: { ...process.env, AWM_HOOK_PORT: '18999', AWM_HOOK_PORT_RANGE: '1' },
      encoding: 'utf-8',
      timeout: 20_000,
    });
    expect(r.status, `prime hook exited ${r.status}: ${r.stderr}`).toBe(0);
  }, 30_000);
});
