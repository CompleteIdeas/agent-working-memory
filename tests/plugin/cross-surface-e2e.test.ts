// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end: one store, two surfaces.
//
// WHAT THIS PROVES
// ----------------
// Everything the unit tests cannot: that the SHIPPED .mcpb artifact — unzipped, with its
// manifest expanded exactly the way Claude Desktop expands it — starts a real MCP server,
// writes a real memory into a real SQLite store, and that the Claude Code plugin launcher
// then RECALLS that same memory from the same file. Plus that each write is stamped with the
// surface it came from.
//
// WHAT IT DOES NOT PROVE
// ----------------------
// Claude Desktop's own installer UI. Desktop is not installed on the machine this was
// written on, so the manifest expansion here is performed by the test rather than by
// Desktop. Every variable Desktop substitutes is substituted, but the substituting is ours.
//
// It starts from `dist-mcpb/*.mcpb` — the actual packed zip, not the source directory —
// because the zip is what a user receives.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(__dirname, '..', '..');

/** Minimal zip reader — enough for an .mcpb, which is a plain zip of small files. */
function unzip(file: string, dest: string): string[] {
  const b = readFileSync(file);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip: ' + file);
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const method = b.readUInt16LE(off + 10);
    const compSize = b.readUInt32LE(off + 20);
    const localOff = b.readUInt32LE(off + 42);
    const name = b.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // local header: skip its own name/extra to reach the payload
    const lNameLen = b.readUInt16LE(localOff + 26);
    const lExtraLen = b.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(start, start + compSize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    const target = join(dest, name.split('/').join(require('node:path').sep));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    out.push(name);
  }
  return out;
}

/** Exactly the variables Claude Desktop substitutes into mcp_config. */
function expandDesktop(s: string, vars: Record<string, string>): string {
  let out = s;
  for (const [k, v] of Object.entries(vars)) out = out.split('${' + k + '}').join(v);
  return out;
}

/** One MCP request/response cycle against a launched server. */
function mcpSession(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  const pending = new Map<number, (v: any) => void>();
  let buf = '';
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  child.stdout.on('data', d => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => rej(new Error(`${method} timed out\n${stderr.slice(-600)}`)), 90_000);
    pending.set(id, (v) => { clearTimeout(t); res(v); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    call,
    async init() {
      return this.call('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'e2e', version: '1' },
      });
    },
    async tool(name: string, args: Record<string, unknown>) {
      const r = await this.call('tools/call', { name, arguments: args });
      return (r.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
    },
    /**
     * Waits for the process to actually exit. Firing kill() and moving on leaves the store
     * locked on Windows — the first version of this test failed with EPERM copying a file
     * that was "already closed", because it was not. Never race a killed process.
     */
    stop(): Promise<void> {
      return new Promise(res => {
        if (child.exitCode !== null || child.signalCode !== null) return res();
        const done = () => res();
        child.once('exit', done);
        child.kill();
        setTimeout(() => { child.off('exit', done); res(); }, 10_000);
      });
    },
    get stderr() { return stderr; },
  };
}

describe('end-to-end: one store, two surfaces', () => {
  let work: string;
  let extracted: string;
  let manifest: any;
  let dbPath: string;
  const MARKER = 'ZEBRAFISH-CROSSWALK-7731';

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'awm-e2e-'));
    dbPath = join(work, 'shared-store.db');

    // ALWAYS repack. The first run of this test found a .mcpb built twenty minutes before a
    // manifest change, so it was asserting against an artifact that no longer matched the
    // source — which is precisely the failure an artifact test exists to catch, and would
    // have been silently inverted into a false pass had the assertion been weaker.
    const dir = join(ROOT, 'dist-mcpb');
    const packed = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-mcpb.mjs'), '--pack'],
      { cwd: ROOT, encoding: 'utf-8' });
    // Select the artifact for THIS version by name. readdirSync()[0] picked 0.15.3 over
    // 0.15.4 purely because it sorts first, so the test asserted against a stale bundle and
    // failed a rename that was actually correct. An artifact test that cannot say which
    // artifact it is testing is not an artifact test.
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
    const art = `agent-working-memory-${version}.mcpb`;
    if (!existsSync(join(dir, art))) {
      throw new Error(`could not pack ${art} — is the MCPB CLI installed? `
        + '`npm i -g @anthropic-ai/mcpb`\n' + (packed.stderr ?? ''));
    }

    extracted = join(work, 'extension');
    mkdirSync(extracted, { recursive: true });
    unzip(join(dir, art), extracted);
    manifest = JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf-8'));
  });

  afterAll(() => {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('the packed artifact contains what the manifest promises', () => {
    expect(existsSync(join(extracted, 'manifest.json'))).toBe(true);
    expect(existsSync(join(extracted, manifest.server.entry_point))).toBe(true);
  });

  it('Desktop writes a memory, Claude Code recalls it from the same store', async () => {
    // ---- surface 1: Claude Desktop, launched from the unzipped artifact -----------------
    const cfg = manifest.server.mcp_config;
    const vars = {
      __dirname: extracted,
      HOME: work,
      'user_config.db_path': dbPath,
      'user_config.agent_id': 'personal',
      'user_config.package_root': ROOT,     // this checkout, so no global install is needed
    };
    const desktopEnv: NodeJS.ProcessEnv = { ...process.env, AWM_HOOK_PORT: '18600', AWM_HOOK_PORT_RANGE: '4' };
    for (const [k, v] of Object.entries<string>(cfg.env)) desktopEnv[k] = expandDesktop(v, vars);

    expect(desktopEnv.AWM_DB_PATH, 'Desktop must open the configured store').toBe(dbPath);
    expect(desktopEnv.AWM_CLIENT).toBe('claude-desktop');

    const desktop = mcpSession(
      cfg.command,
      cfg.args.map((a: string) => expandDesktop(a, vars)),
      desktopEnv,
    );
    try {
      const init = await desktop.init();
      expect(init.result?.serverInfo?.name).toBe('agent-working-memory');

      const wrote = await desktop.tool('memory_write', {
        concept: `Desktop provenance walk ${MARKER}`,
        content:
          `The ${MARKER} reconciliation decision was taken in Claude Desktop and must be `
          + `recallable from Claude Code against the same SQLite store at shared-store.db. `
          + `Recorded so the cross-surface path is proven rather than assumed.`,
        project: 'AWM',
        topic: 'cross-surface-e2e',
        intent: 'decision',
        confidence_level: 'verified',
        memory_class: 'canonical',
      });
      expect(wrote, `write was rejected:\n${wrote}`).toMatch(/Stored|active|staging/i);
    } finally {
      await desktop.stop();
    }

    // ---- surface 2: Claude Code plugin launcher, SAME store -----------------------------
    const pluginManifest = JSON.parse(
      readFileSync(join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), 'utf-8'));
    const pServer = pluginManifest.mcpServers['agent-working-memory'];
    const codeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...pServer.env,
      AWM_DB_PATH: dbPath,
      AWM_AGENT_ID: 'personal',
      AWM_PACKAGE_ROOT: ROOT,
      AWM_HOOK_PORT: '18610',
      AWM_HOOK_PORT_RANGE: '4',
    };
    expect(codeEnv.AWM_CLIENT).toBe('claude-code');

    const code = mcpSession(
      pServer.command,
      pServer.args.map((a: string) => a.split('${CLAUDE_PLUGIN_ROOT}').join(join(ROOT, 'plugin'))),
      codeEnv,
    );
    try {
      await code.init();
      const recalled = await code.tool('memory_recall', { query: `${MARKER} reconciliation decision`, limit: 5 });
      expect(recalled, `Claude Code could not see the Desktop write:\n${recalled}`).toContain(MARKER);
    } finally {
      await code.stop();
    }

    // ---- provenance, once both servers are down ----------------------------------------
    // Windows keeps a handle briefly after kill(), so opening the store can fail for a
    // moment even though the file is plainly there. Retry rather than assert on the race.
    // Open the store directly. Both servers have fully exited by now (stop() awaits it), and
    // opening read-write lets SQLite replay the -wal, which is where a just-written row lives.
    //
    // An earlier version copied the file first, on the theory that Windows was holding a lock.
    // That was the wrong diagnosis: the open was failing because AWM_DB_PATH had become a
    // PGlite *directory*, and copyFileSync on a directory also reports EPERM. Two different
    // faults with one error code. The real bug is fixed in storage/factory.ts.
    const { default: Database } = await import('better-sqlite3');
    let rows: any[] = [];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const db = new Database(dbPath);
        try {
          rows = db.prepare('SELECT concept, tags FROM engrams').all() as any[];
        } finally {
          db.close();
        }
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 250));
      }
    }

    const listing = existsSync(work) ? readdirSync(work).join(', ') : '(work dir is GONE)';
    const dbThere = existsSync(dbPath);
    expect(rows.length,
      `could not read the shared store
`
      + `  path      : ${dbPath}
`
      + `  file there: ${dbThere}
`
      + `  work holds: ${listing}
`
      + `  error     : ${String(lastErr)}`)
      .toBeGreaterThan(0);

    const desktopRow = rows.find(r => String(r.concept).includes(MARKER));
    expect(desktopRow, 'the Desktop write is not in the shared store').toBeTruthy();
    expect(String(desktopRow.tags)).toContain('client=claude-desktop');
  }, 300_000);

});
