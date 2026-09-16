/**
 * `awm setup claude-code` (0.14.6): re-running it must upgrade, never reset.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 0.14.5 writeMcpConfig replaced the whole server entry. On a real install
 * that would have dropped the three hand-set rerank flags, written a new agent id
 * (`claude`) over a config that relied on directory derivation, and repointed
 * AWM_DB_PATH at the package default — three ways to lose a working memory setup
 * by running the upgrade command. writeHooks likewise replaced the Stop/PreCompact/
 * SessionEnd arrays, deleting any hook the user had added on those events.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import adapter from '../../src/adapters/claude-code.js';
import { buildSetupContext, RECOMMENDED_ENV } from '../../src/adapters/common.js';
import { AWM_HOOKS_VERSION, PRIME_DISABLE_FILE } from '../../src/adapters/hook-scripts.js';

let home: string;
let project: string;
let savedCwd: string;
let savedHome: string | undefined;
const SERVER = 'agent-working-memory';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'awm-setup-'));
  project = join(home, 'proj'); mkdirSync(project);
  savedCwd = process.cwd(); process.chdir(project);
  savedHome = process.env.AWM_SETUP_HOME; process.env.AWM_SETUP_HOME = home;
});
afterEach(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.AWM_SETUP_HOME; else process.env.AWM_SETUP_HOME = savedHome;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

const readMcp = () => JSON.parse(readFileSync(join(home, '.mcp.json'), 'utf-8'));
const readSettings = () => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
const ctxFor = (opts: Partial<Parameters<typeof buildSetupContext>[0]> = {}) => {
  const existingEnv = adapter.readExistingEnv!(true, process.cwd());
  return buildSetupContext({ isGlobal: true, dbPath: opts.dbPath ?? join(home, 'db', 'memory.db'), existingEnv, ...opts });
};

describe('writeMcpConfig', () => {
  it('fresh install: owned keys + the recommended retrieval flags, global agent defaults to work', () => {
    const ctx = ctxFor();
    adapter.writeMcpConfig(ctx);
    const env = readMcp().mcpServers[SERVER].env;
    expect(env.AWM_AGENT_ID).toBe('work');
    expect(env.AWM_DB_PATH).toContain('memory.db');
    expect(env.AWM_HOOK_PORT).toBe('8401');
    expect(env.AWM_HOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    for (const [k, v] of Object.entries(RECOMMENDED_ENV)) expect(env[k]).toBe(v);
    expect(env.AWM_HOOK_PORT_RANGE).toBeUndefined();       // default range is not written
  });

  it('re-run keeps the user\'s agent id, db path, port and every foreign env value', () => {
    const dbPath = join(home, 'elsewhere', 'store.db');
    mkdirSync(join(home, 'elsewhere'), { recursive: true });
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({
      mcpServers: {
        other: { command: 'x' },
        [SERVER]: { type: 'stdio', command: 'node', args: ['old.js'], env: {
          AWM_AGENT_ID: 'claude', AWM_DB_PATH: dbPath, AWM_HOOK_PORT: '8501',
          AWM_RERANK2: '0', AWM_WORKSPACE: 'team', AWM_STORE_BACKEND: 'sqlite',
        } },
      },
    }));
    const ctx = ctxFor({ dbPath: undefined });          // no flags at all → existing wins
    adapter.writeMcpConfig(ctx);
    const cfg = readMcp();
    const entry = cfg.mcpServers[SERVER];
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(entry.type).toBe('stdio');                    // non-env fields carried across
    expect(entry.env.AWM_AGENT_ID).toBe('claude');
    expect(entry.env.AWM_DB_PATH).toBe(dbPath.replace(/\\/g, '/'));
    expect(entry.env.AWM_HOOK_PORT).toBe('8501');
    expect(entry.env.AWM_RERANK2).toBe('0');              // a deliberate override is respected
    expect(entry.env.AWM_WORKSPACE).toBe('team');
    expect(entry.env.AWM_STORE_BACKEND).toBe('sqlite');
    expect(entry.env.AWM_RERANK_WINDOW).toBe('query');   // missing recommended flags are added
    expect(entry.env.AWM_RERANK_TAGS).toBe('1');
  });

  it('an explicit flag beats the existing value', () => {
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({
      mcpServers: { [SERVER]: { command: 'node', args: [], env: { AWM_AGENT_ID: 'claude', AWM_HOOK_PORT: '8501' } } },
    }));
    const ctx = ctxFor({ agentId: 'work', hookPort: '8601', hookPortRange: '3' });
    adapter.writeMcpConfig(ctx);
    const env = readMcp().mcpServers[SERVER].env;
    expect(env.AWM_AGENT_ID).toBe('work');
    expect(env.AWM_HOOK_PORT).toBe('8601');
    expect(env.AWM_HOOK_PORT_RANGE).toBe('3');
  });
});

describe('writeHooks', () => {
  it('installs the scripts, the record, and wires all five events', () => {
    const ctx = ctxFor();
    const msg = adapter.writeHooks(ctx, false);
    expect(msg).toContain('prime');
    const hooksDir = join(home, '.claude', 'hooks');
    for (const f of ['awm-find-sidecar.cjs', 'awm-checkpoint.cjs', 'awm-prime.cjs', 'awm-db-mutation-reminder.cjs', 'awm-hooks.json']) {
      expect(existsSync(join(hooksDir, f)), f).toBe(true);
    }
    const record = JSON.parse(readFileSync(join(hooksDir, 'awm-hooks.json'), 'utf-8'));
    expect(record.version).toBe(AWM_HOOKS_VERSION);
    expect(record.agentId).toBe('work');
    expect(record.hookPort).toBe('8401');
    expect(record.hookPortRange).toBe('10');
    expect(record.secretPath).toContain('.awm-hook-secret');

    const s = readSettings();
    const cmd = (ev: string) => JSON.stringify(s.hooks[ev]);
    expect(cmd('PreCompact')).toContain('awm-checkpoint.cjs');
    expect(cmd('SessionEnd')).toContain('awm-checkpoint.cjs');
    expect(cmd('UserPromptSubmit')).toContain('awm-prime.cjs');
    expect(cmd('PostToolUse')).toContain('awm-db-mutation-reminder.cjs');
    expect(cmd('Stop')).toContain('MEMORY:');
    expect(JSON.stringify(s.hooks)).not.toContain('curl');
    expect(JSON.stringify(s.hooks)).not.toContain(ctx.hookSecret);     // secret never in settings.json
  });

  it('replaces the pre-0.14.6 inline curl hooks and keeps the user\'s own hooks on the same events', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'node my-own-stop-hook.js' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'echo "MEMORY: (1) Did you learn anything new? ..."' }] },
        ],
        PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'curl -sf -X POST http://127.0.0.1:8401/hooks/checkpoint -H "Authorization: Bearer old" || curl -sf -X POST http://127.0.0.1:8402/hooks/checkpoint' }] }],
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'curl -sf -X POST http://127.0.0.1:8401/hooks/checkpoint' }] }],
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node my-formatter.js' }] }],
      },
    }));
    adapter.writeHooks(ctxFor(), false);
    const s = readSettings();
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(JSON.stringify(s.hooks.Stop)).toContain('my-own-stop-hook.js');
    expect(s.hooks.Stop.filter((g: any) => JSON.stringify(g).includes('MEMORY:')).length).toBe(1);
    expect(JSON.stringify(s.hooks.PreCompact)).not.toContain('curl');
    expect(JSON.stringify(s.hooks.SessionEnd)).not.toContain('curl');
    expect(s.hooks.PreCompact.length).toBe(1);
    expect(JSON.stringify(s.hooks.PostToolUse)).toContain('my-formatter.js');
    expect(s.hooks.PostToolUse.length).toBe(2);
  });

  it('leaves alone hooks that merely share the awm- prefix but were never installed by setup', () => {
    // Caught rehearsing an upgrade over a real install: a loose /awm-[a-z-]+\.cjs/ matcher
    // treated the owner's own awm-dev-log.cjs and awm-recall-stamp.cjs as setup's property
    // and deleted both. Only the files this adapter writes are ours.
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "~/.claude/hooks/awm-dev-log.cjs"' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'node "~/.claude/hooks/awm-recall-stamp.cjs"' }] },
        ],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "~/.claude/hooks/awm-precheck-discovery-query.cjs"' }] }],
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'powershell -File ~/.claude/hooks/awm-session-start.ps1' }] }],
      },
    }));
    adapter.writeHooks(ctxFor(), false);
    const s = readSettings();
    const all = JSON.stringify(s.hooks);
    for (const kept of ['awm-dev-log.cjs', 'awm-recall-stamp.cjs', 'awm-precheck-discovery-query.cjs', 'awm-session-start.ps1']) {
      expect(all, kept).toContain(kept);
    }
    expect(s.hooks.PostToolUse.length).toBe(3);          // two of the user's + ours
    expect(s.hooks.SessionStart.length).toBe(1);
  });

  it('--no-prime installs no UserPromptSubmit hook and removes one a previous run installed', () => {
    adapter.writeHooks(ctxFor(), false);
    expect(readSettings().hooks.UserPromptSubmit).toBeDefined();
    adapter.writeHooks(ctxFor({ installPrime: false }), false);
    expect(readSettings().hooks.UserPromptSubmit).toBeUndefined();
  });

  it('is idempotent', () => {
    adapter.writeHooks(ctxFor(), false);
    const first = readSettings();
    adapter.writeHooks(ctxFor(), false);
    expect(readSettings()).toEqual(first);
  });
});

describe('diagnose', () => {
  function fakeSidecar(agentId: string): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/health' ? { status: 'ok', sidecar: true, agentId, version: '9.9.9', pid: 1 } : {}));
    });
    return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, port: (server.address() as any).port })));
  }

  it('flags the legacy inline-curl hooks and a missing prime hook', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'curl -sf -X POST http://127.0.0.1:8401/hooks/checkpoint' }] }],
      SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'curl -sf -X POST http://127.0.0.1:8401/hooks/checkpoint' }] }],
    } }));
    // Point the probe at a port block with nothing on it so this test is hermetic.
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { [SERVER]: { command: 'node', args: [], env: { AWM_AGENT_ID: 'work', AWM_HOOK_PORT: '1', AWM_HOOK_PORT_RANGE: '1' } } } }));
    const results = await adapter.diagnose(ctxFor());
    const by = (c: string) => results.find(r => r.check === c)!;
    expect(by('Hooks').status).toBe('warn');
    expect(by('Hooks').message).toContain('pre-0.14.6');
    expect(by('Prime hook').status).toBe('warn');
    expect(by('Recommended env').status).toBe('warn');
    expect(by('Sidecars').status).toBe('warn');
  });

  it('reports a current install as ok, sees the live sidecar, and notices the off switch', async () => {
    const sc = await fakeSidecar('work');
    try {
      const ctx = ctxFor({ hookPort: String(sc.port), hookPortRange: '1' });
      adapter.writeMcpConfig(ctx);
      adapter.writeHooks(ctx, false);
      let results = await adapter.diagnose(ctxFor());
      const by = (c: string) => results.find(r => r.check === c)!;
      expect(by('Hooks').status).toBe('ok');
      expect(by('Prime hook').status).toBe('ok');
      expect(results.find(r => r.check === 'Recommended env')).toBeUndefined();
      expect(by('Sidecars').status).toBe('ok');
      expect(by('Sidecars').message).toContain(`${sc.port}=work@9.9.9`);
      expect(results.find(r => r.check === 'Sidecar match')).toBeUndefined();

      writeFileSync(join(home, '.claude', 'hooks', PRIME_DISABLE_FILE), '');
      results = await adapter.diagnose(ctxFor());
      expect(results.find(r => r.check === 'Prime hook')!.status).toBe('warn');
      expect(results.find(r => r.check === 'Prime hook')!.message).toContain('OFF');
    } finally {
      await new Promise<void>(ok => sc.server.close(() => ok()));
    }
  });

  it('warns when the live sidecars serve a different agent than this directory is configured for', async () => {
    const sc = await fakeSidecar('personal');
    try {
      const ctx = ctxFor({ agentId: 'work', hookPort: String(sc.port), hookPortRange: '1' });
      adapter.writeMcpConfig(ctx);
      adapter.writeHooks(ctx, false);
      const results = await adapter.diagnose(ctxFor());
      const m = results.find(r => r.check === 'Sidecar match')!;
      expect(m.status).toBe('warn');
      expect(m.message).toContain('"work"');
      expect(m.message).toContain('personal');
    } finally {
      await new Promise<void>(ok => sc.server.close(() => ok()));
    }
  });
});

// A store inside the installed package is destroyed by the next `npm install -g`: npm renames
// the package directory aside and deletes it. Reported from a real machine as an EBUSY on
// upgrade — which was the lucky outcome, because a running process held the file open.
describe('the store must never live inside the installed package', () => {
  it('flags a store inside node_modules, on both path shapes', async () => {
    const { isInsidePackage } = await import('../../src/adapters/common.js');
    expect(isInsidePackage('C:\\Users\\jason\\AppData\\Roaming\\npm\\node_modules\\agent-working-memory\\data\\memory.db')).toBe(true);
    expect(isInsidePackage('/usr/local/lib/node_modules/agent-working-memory/data/memory.db')).toBe(true);
  });

  it('does not flag a store in the user home', async () => {
    const { isInsidePackage } = await import('../../src/adapters/common.js');
    expect(isInsidePackage('C:/Users/robert/.awm/memory.db')).toBe(false);
    expect(isInsidePackage('/home/x/.awm/memory.db')).toBe(false);
  });

  it('defaults to ~/.awm even when the package root is inside node_modules', async () => {
    const { resolveDbPath, isInsidePackage } = await import('../../src/adapters/common.js');
    const p = resolveDbPath('/usr/local/lib/node_modules/agent-working-memory');
    expect(isInsidePackage(p)).toBe(false);
    expect(p).toContain('.awm');
    expect(p).toContain('memory.db');
  });
});


/**
 * `--force` has to actually REACH upsertAwmSection.
 *
 * WHY THIS EXISTS
 * ---------------
 * upsertAwmSection has taken a `force` option since generated markers were introduced,
 * and it was unit-tested. But nothing ever passed it: there was no CLI flag, and no
 * adapter set it. So a user with a legacy unmarked section hit an unbreakable loop —
 * every `awm setup` wrote another timestamped backup and refused, and the refusal message
 * told them to "re-run with force", which was impossible.
 *
 * Measured on a real install 2026-09-16: four byte-identical backups in 35 minutes.
 *
 * The unit test on the option passing is not enough; this covers the WIRING.
 */
describe('claude-code: --force reaches the instruction writer', () => {
  const LEGACY = '# Global Instructions\n\n## Memory (AWM) — MANDATORY\n\nOld unmarked text.\nA hand-written note worth keeping.\n';

  it('defaults to false: a legacy section is backed up and left alone', () => {
    const claudeMd = join(home, '.claude', 'CLAUDE.md');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeMd, LEGACY);

    const msg = adapter.writeInstructions(ctxFor(), false);

    expect(msg).toMatch(/NOT updated/);
    expect(readFileSync(claudeMd, 'utf-8')).toBe(LEGACY);       // untouched
    expect(msg).toMatch(/--force/);                              // and the advice is followable
    const backups = readdirSync(join(home, '.claude')).filter(f => f.includes('.awm-backup-'));
    expect(backups).toHaveLength(1);
  });

  it('forceInstructions: true replaces the section and marks it, so the loop ends', () => {
    const claudeMd = join(home, '.claude', 'CLAUDE.md');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeMd, LEGACY);

    const msg = adapter.writeInstructions(ctxFor({ forceInstructions: true }), false);
    // Match the SUCCESS message specifically: the refusal message also contains the word
    // "force" (it says "re-run with --force"), so /force/ would pass even unwired.
    expect(msg).toMatch(/replaced with a marked generated block/);

    const out = readFileSync(claudeMd, 'utf-8');
    expect(out).toContain('<!-- AWM:GENERATED:END -->');
    expect(out).toContain('# Global Instructions');              // content above survives
    expect(out).not.toContain('Old unmarked text.');             // the section itself is replaced

    // And now that it carries markers, a further run is a no-op rather than a backup.
    const again = adapter.writeInstructions(ctxFor(), false);
    expect(again).toMatch(/up-to-date|updated/);
    const backups = readdirSync(join(home, '.claude')).filter(f => f.includes('.awm-backup-'));
    expect(backups).toHaveLength(0);
  });
});
