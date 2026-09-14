// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
//
// The Claude Desktop extension bundle.
//
// WHY THIS EXISTS
// ---------------
// `mcpb validate` checks the manifest against its schema. It cannot check that
// `entry_point` names a file that was actually written, that the env block references
// user_config keys that exist, or that the launcher survives what Desktop actually passes
// it — which includes empty strings for any setting the user cleared.
//
// That last one is the interesting case. Desktop substitutes `${user_config.agent_id}`
// whether or not the user filled it in, so a blank field arrives as "" rather than being
// absent. An empty AWM_AGENT_ID would override the server's own default with nothing.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = resolve(__dirname, '..', '..');
const BUNDLE = join(ROOT, 'mcpb');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

/** Desktop expands these before launching. */
function expand(s: string, vars: Record<string, string>): string {
  let out = s;
  for (const [k, v] of Object.entries(vars)) out = out.split('${' + k + '}').join(v);
  return out;
}

/** Kill a child and WAIT for it to actually exit before touching its files. */
function stopAndWait(child: any): Promise<void> {
  return new Promise(res => {
    if (child.exitCode !== null || child.signalCode !== null) return res();
    const done = () => res();
    child.once('exit', done);
    child.kill();
    setTimeout(() => { child.off('exit', done); res(); }, 10_000);
  });
}

describe('claude desktop extension (.mcpb)', () => {
  let manifest: any;

  beforeAll(() => {
    manifest = readJson(join(BUNDLE, 'manifest.json'));
  });

  it('carries every field the MCPB spec requires', () => {
    for (const f of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) {
      expect(manifest[f], `missing required field: ${f}`).toBeTruthy();
    }
    expect(manifest.author.name, 'author.name is required').toBeTruthy();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.server.type).toBe('node');
  });

  it('tracks the package version', () => {
    expect(manifest.version).toBe(readJson(join(ROOT, 'package.json')).version);
  });

  it('entry_point and the launched args both resolve to a real file', () => {
    expect(existsSync(join(BUNDLE, manifest.server.entry_point))).toBe(true);
    for (const arg of manifest.server.mcp_config.args) {
      if (!arg.includes('${__dirname}')) continue;
      const p = expand(arg, { __dirname: BUNDLE });
      expect(existsSync(p), `mcp_config arg does not exist: ${p}`).toBe(true);
    }
  });

  // A ${user_config.x} that names a key which is not declared expands to nothing, silently.
  it('every ${user_config.*} reference in env is a declared setting', () => {
    const declared = Object.keys(manifest.user_config ?? {});
    const refs = [...JSON.stringify(manifest.server.mcp_config.env ?? {})
      .matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map(m => m[1]);
    expect(refs.length, 'expected the manifest to expose settings').toBeGreaterThan(0);
    for (const r of refs) {
      expect(declared, `env references undeclared user_config key: ${r}`).toContain(r);
    }
  });

  it('declares the platforms and runtime it actually needs', () => {
    expect(manifest.compatibility?.platforms).toEqual(
      expect.arrayContaining(['darwin', 'win32']),
    );
    expect(manifest.compatibility?.runtimes?.node).toBeTruthy();
  });

  it('states the global-install prerequisite where a user will read it', () => {
    const text = `${manifest.description} ${manifest.long_description ?? ''}`;
    expect(text).toMatch(/npm install -g agent-working-memory/);
  });

  // The behaviour that manifest validation cannot reach.
  it('the launcher survives the empty strings Desktop sends for cleared settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awm-mcpb-'));
    let child: any;
    try {
      const launcher = join(BUNDLE, manifest.server.entry_point);
      child = spawn(process.execPath, [launcher], {
        env: {
          ...process.env,
          AWM_DB_PATH: join(dir, 'scratch.db'),
          AWM_AGENT_ID: '',        // user cleared the field — must not pin an empty agent
          AWM_HOOK_PORT: '',       // same
          AWM_HOOK_PORT_RANGE: '4',
          AWM_PACKAGE_ROOT: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
      const info = await new Promise<any>((res, rej) => {
        let buf = '';
        const timer = setTimeout(() => { child.kill(); rej(new Error('no response')); }, 90_000);
        child.stdout.on('data', d => {
          buf += d;
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let m: any;
            try { m = JSON.parse(line); } catch { continue; }
            if (m.id === 1) { clearTimeout(timer); child.kill(); res(m.result); }
          }
        });
        child.on('error', rej);
        send({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'desktop-test', version: '1' } },
        });
      });

      expect(info?.serverInfo?.name).toBe('agent-working-memory');
    } finally {
      // Wait for the process to release the store before deleting it. rmSync straight after
      // kill() raced the OS and failed with EBUSY once the backend fix made these tests
      // create a real SQLite file rather than a PGlite directory.
      await stopAndWait(child);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir; best-effort */ }
    }
  }, 120_000);

  it('defaults the store to the same file the other surfaces use', () => {
    const want = join(homedir(), '.awm', 'memory.db').split('\\').join('/');
    const src = readFileSync(join(BUNDLE, manifest.server.entry_point), 'utf-8');
    // The launcher computes it rather than hardcoding a string, so assert the intent.
    expect(src).toMatch(/\.awm'?,\s*'memory\.db'/);
    expect(manifest.user_config.db_path.default).toBe('${HOME}/.awm/memory.db');
    expect(want.endsWith('/.awm/memory.db')).toBe(true);
  });
});
