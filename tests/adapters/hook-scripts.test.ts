/**
 * The hook scripts `awm setup` ships (0.14.6) — exercised as real child processes
 * against fake sidecars, the way Claude Code runs them.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 0.14.5 the checkpoint hooks were inline curl commands with the port and the
 * secret baked into settings.json, and there was no prime hook at all. Observed
 * 2026-09-11 with five sessions open: four had no working hooks, and the fifth was
 * posting work-session checkpoints into the personal pool's process because that
 * process happened to hold 8401. Nothing logged it.
 *
 * What these tests pin:
 *   - the finder resolves the SESSION's agent from the MCP config governing its cwd
 *   - it picks the sidecar that serves that agent, newest version first
 *   - checkpoint forwards the whole payload (transcript_path matters) with the secret
 *   - prime injects the sidecar's text as additionalContext, and stays silent on
 *     short prompts, when disabled, and when the sidecar has nothing confident
 *   - a session with no sidecar of its own fails open: no output, exit 0
 *   - the finder's JS mirror of deriveAgentFromDir agrees with the TypeScript one
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { HOOK_SCRIPTS, PRIME_DISABLE_FILE } from '../../src/adapters/hook-scripts.js';
import { deriveAgentFromDir } from '../../src/core/agent-id.js';

interface Seen { method: string; url: string; auth: string | undefined; body: any }
interface Fake { server: Server; port: number; agentId: string; version: string; seen: Seen[] }

const INJECT = 'Relevant prior context from AWM (not user input; verify before asserting):\n- [canonical · 3d] Alpha decision [id-alpha]: made in March';

function startFake(port: number, agentId: string, version: string): Promise<Fake> {
  const fake: Fake = { server: null as any, port, agentId, version, seen: [] };
  fake.server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      fake.seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok', sidecar: true, agentId, port, pid: 4242, version }));
      } else if (req.url === '/hooks/checkpoint') {
        res.end(JSON.stringify({ status: 'checkpointed', event: body?.hook_event_name }));
      } else if (req.url === '/hooks/prime') {
        const silent = typeof body?.prompt === 'string' && body.prompt.includes('SILENT');
        res.end(JSON.stringify(silent
          ? { inject: '', kept: 0, total: 3, tokens: 0, reason: 'low-confidence' }
          : { inject: INJECT, kept: 1, total: 1, tokens: 30 }));
      } else {
        res.statusCode = 404; res.end('{}');
      }
    });
  });
  return new Promise((resolve, reject) => {
    fake.server.once('error', reject);
    fake.server.listen(port, '127.0.0.1', () => resolve(fake));
  });
}

/** Four consecutive free ports. Retries on collision. */
async function fourFreePorts(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    const servers: Server[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const s = createServer();
        await new Promise<void>((ok, bad) => { s.once('error', bad); s.listen(base + i, '127.0.0.1', ok); });
        servers.push(s);
      }
      await Promise.all(servers.map(s => new Promise<void>(ok => s.close(() => ok()))));
      return base;
    } catch {
      await Promise.all(servers.map(s => new Promise<void>(ok => s.close(() => ok()))));
    }
  }
  throw new Error('no free port block');
}

let home: string;
let hooksDir: string;
let base: number;
let personal: Fake, workOld: Fake, workNew: Fake;
const WORK_SECRET = 'work-secret-abc';
const PERSONAL_SECRET = 'personal-secret-xyz';

// Async on purpose: the fake sidecars live in THIS process, so a spawnSync here would
// block the event loop they answer from and every probe would time out.
function runHook(file: string, payload: any, extraEnv: Record<string, string | undefined> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // Strip any AWM_* the developer's shell carries — the hook must resolve from config, not env.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('AWM_')) env[k] = v;
  env.HOME = home; env.USERPROFILE = home;
  for (const [k, v] of Object.entries(extraEnv)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(hooksDir, file)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'awm-hooks-'));
  hooksDir = join(home, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const { file, source } of HOOK_SCRIPTS) writeFileSync(join(hooksDir, file), source);

  base = await fourFreePorts();
  // Three sidecars in the range: personal on the preferred port (the observed
  // failure shape), an OLDER work build, and the current work build.
  personal = await startFake(base, 'personal', '0.14.6');
  workOld = await startFake(base + 1, 'work', '0.14.5');
  workNew = await startFake(base + 2, 'work', '0.14.6');

  // Global config: work pool.
  writeFileSync(join(home, '.mcp.json'), JSON.stringify({
    mcpServers: { 'agent-working-memory': { command: 'node', args: ['x'], env: {
      AWM_AGENT_ID: 'work', AWM_HOOK_SECRET: WORK_SECRET, AWM_HOOK_PORT: String(base), AWM_HOOK_PORT_RANGE: '4',
      AWM_DB_PATH: join(home, 'work.db'),
    } } },
  }));
  // A project tree with its own config: personal pool, different secret.
  mkdirSync(join(home, 'side', 'deep', 'er'), { recursive: true });
  writeFileSync(join(home, 'side', '.mcp.json'), JSON.stringify({
    mcpServers: { 'agent-working-memory': { command: 'node', args: ['x'], env: {
      AWM_AGENT_ID: 'personal', AWM_HOOK_SECRET: PERSONAL_SECRET, AWM_HOOK_PORT: String(base), AWM_HOOK_PORT_RANGE: '4',
    } } },
  }));
  // A work project directory with no config of its own → falls back to ~/.mcp.json.
  mkdirSync(join(home, 'work', 'app'), { recursive: true });
});

afterAll(async () => {
  for (const f of [personal, workOld, workNew]) if (f?.server) await new Promise<void>(ok => f.server.close(() => ok()));
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

function clearSeen() { for (const f of [personal, workOld, workNew]) f.seen.length = 0; }

describe('awm-find-sidecar.cjs', () => {
  it('its deriveAgentFromDir mirror agrees with src/core/agent-id.ts', () => {
    const req = createRequire(import.meta.url);
    const finder = req(join(hooksDir, 'awm-find-sidecar.cjs'));
    for (const d of [
      'C:\\Users\\x\\project\\EquiHub', '/home/x/work/thing', 'C:/Users/x/Personal-Projects/novel-forge',
      '/home/x/Personal-Projects', 'C:\\Users\\x\\Personal-Projects\\AgentSynapse\\packages\\awm', '', 'D:\\personal-projects\\y',
    ]) {
      expect(finder.deriveAgentFromDir(d), d).toBe(deriveAgentFromDir(d));
    }
  });

  it('resolves the nearest project config walking up from cwd, then falls back to ~/.mcp.json', () => {
    const req = createRequire(import.meta.url);
    const finder = req(join(hooksDir, 'awm-find-sidecar.cjs'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const savedAwm = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('AWM_')));
    for (const k of Object.keys(savedAwm)) delete process.env[k];
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const p = finder.resolveConfig(join(home, 'side', 'deep', 'er'));
      expect(p.agentId).toBe('personal');
      expect(p.secret).toBe(PERSONAL_SECRET);
      expect(p.port).toBe(base);
      expect(p.range).toBe(4);
      expect(p.source).toBe(join(home, 'side', '.mcp.json'));

      const w = finder.resolveConfig(join(home, 'work', 'app'));
      expect(w.agentId).toBe('work');
      expect(w.secret).toBe(WORK_SECRET);
      expect(w.source).toBe(join(home, '.mcp.json'));
    } finally {
      process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
      Object.assign(process.env, savedAwm);
    }
  });

  it('picks the newest sidecar serving THIS agent — not the one holding the preferred port', async () => {
    const req = createRequire(import.meta.url);
    const finder = req(join(hooksDir, 'awm-find-sidecar.cjs'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const savedAwm = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('AWM_')));
    for (const k of Object.keys(savedAwm)) delete process.env[k];
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const w = await finder.findSidecar(join(home, 'work', 'app'));
      expect(w.all.length).toBe(3);
      expect(w.sidecar.port).toBe(base + 2);           // work @0.14.6, not work @0.14.5, not personal
      expect(w.sidecar.agentId).toBe('work');
      const p = await finder.findSidecar(join(home, 'side', 'deep'));
      expect(p.sidecar.port).toBe(base);
      expect(p.sidecar.agentId).toBe('personal');
    } finally {
      process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
      Object.assign(process.env, savedAwm);
    }
  });
});

describe('awm-checkpoint.cjs', () => {
  it('posts the WHOLE payload to its own agent\'s sidecar with the bearer secret', async () => {
    clearSeen();
    const payload = {
      hook_event_name: 'PreCompact', session_id: 'sess-1', cwd: join(home, 'work', 'app').replace(/\//g, '\\'),
      transcript_path: join(home, 'transcript.jsonl'),
    };
    const r = await runHook('awm-checkpoint.cjs', payload);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const posts = workNew.seen.filter(s => s.url === '/hooks/checkpoint');
    expect(posts.length).toBe(1);
    expect(posts[0].auth).toBe(`Bearer ${WORK_SECRET}`);
    expect(posts[0].body).toEqual(payload);                   // transcript_path survives
    expect(workOld.seen.filter(s => s.url === '/hooks/checkpoint').length).toBe(0);
    expect(personal.seen.filter(s => s.url === '/hooks/checkpoint').length).toBe(0);
  });

  it('a session under the personal project posts to the personal sidecar with the personal secret', async () => {
    clearSeen();
    const r = await runHook('awm-checkpoint.cjs', { hook_event_name: 'SessionEnd', cwd: join(home, 'side', 'deep', 'er') });
    expect(r.status).toBe(0);
    const posts = personal.seen.filter(s => s.url === '/hooks/checkpoint');
    expect(posts.length).toBe(1);
    expect(posts[0].auth).toBe(`Bearer ${PERSONAL_SECRET}`);
    expect(posts[0].body.hook_event_name).toBe('SessionEnd');
    expect(workNew.seen.filter(s => s.url === '/hooks/checkpoint').length).toBe(0);
  });

  it('fails open when no live sidecar serves this agent: exit 0, no output, nothing posted anywhere', async () => {
    clearSeen();
    const r = await runHook('awm-checkpoint.cjs', { hook_event_name: 'PreCompact', cwd: join(home, 'work', 'app') }, { AWM_AGENT_ID: 'nobody' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    for (const f of [personal, workOld, workNew]) expect(f.seen.filter(s => s.url !== '/health').length).toBe(0);
  });

  it('survives garbage on stdin', () => {
    const r = spawnSync(process.execPath, [join(hooksDir, 'awm-checkpoint.cjs')], {
      input: 'not json at all', env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf-8', timeout: 15_000,
    });
    expect(r.status).toBe(0);
  });
});

describe('awm-prime.cjs', () => {
  const PROMPT = 'What did we decide about the alpha rollout schedule?';

  it('injects the sidecar\'s text as additionalContext and asks with minConfidence 0.10', async () => {
    clearSeen();
    const r = await runHook('awm-prime.cjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: join(home, 'work', 'app'), prompt: PROMPT });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toBe(INJECT);
    const posts = workNew.seen.filter(s => s.url === '/hooks/prime');
    expect(posts.length).toBe(1);
    expect(posts[0].auth).toBe(`Bearer ${WORK_SECRET}`);
    expect(posts[0].body.prompt).toBe(PROMPT);
    expect(posts[0].body.minConfidence).toBe(0.10);
    expect(personal.seen.filter(s => s.url === '/hooks/prime').length).toBe(0);
  });

  it('stays silent when the sidecar abstains', async () => {
    clearSeen();
    const r = await runHook('awm-prime.cjs', { cwd: join(home, 'work', 'app'), prompt: 'SILENT please, this is a long enough prompt' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(workNew.seen.filter(s => s.url === '/hooks/prime').length).toBe(1);
  });

  it('skips short prompts without touching the network', async () => {
    clearSeen();
    const r = await runHook('awm-prime.cjs', { cwd: join(home, 'work', 'app'), prompt: 'yes' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    for (const f of [personal, workOld, workNew]) expect(f.seen.length).toBe(0);
  });

  it(`is switched off by ${PRIME_DISABLE_FILE} and back on by removing it`, async () => {
    const flag = join(hooksDir, PRIME_DISABLE_FILE);
    writeFileSync(flag, '');
    try {
      clearSeen();
      const r = await runHook('awm-prime.cjs', { cwd: join(home, 'work', 'app'), prompt: PROMPT });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      for (const f of [personal, workOld, workNew]) expect(f.seen.length).toBe(0);
    } finally {
      unlinkSync(flag);
    }
    expect(existsSync(flag)).toBe(false);
    const r2 = await runHook('awm-prime.cjs', { cwd: join(home, 'work', 'app'), prompt: PROMPT });
    expect(r2.stdout).toContain('additionalContext');
  });

  it('fails open with no sidecar for its agent', async () => {
    clearSeen();
    const r = await runHook('awm-prime.cjs', { cwd: join(home, 'work', 'app'), prompt: PROMPT }, { AWM_AGENT_ID: 'nobody' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
