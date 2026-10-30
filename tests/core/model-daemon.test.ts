/**
 * Shared model daemon (AWM_MODEL_DAEMON=1): protocol, authentication, scheduling,
 * spawn election, identical results, idle exit and in-process fallback.
 *
 * Run: npx vitest run tests/core/model-daemon.test.ts
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FrameReader, encodeFrame, modelDaemonFingerprint, modelDaemonPaths, configEnv, PROTOCOL_VERSION, runDirProblem, codeStamp,
} from '../../src/core/model-daemon.js';
import { startModelDaemon, type DaemonHandlers, type RunningDaemon } from '../../src/core/model-daemon-server.js';
import { DaemonRemoteError, DaemonUnavailableError, ModelDaemonClient } from '../../src/core/model-daemon-client.js';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'awm-md-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a daemon still idling there */ } } });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let n = 0;
const uniqueFp = () => `${process.pid.toString(16)}f${(++n).toString(16)}`.padEnd(16, '0').slice(0, 16);
const NO_SPAWN = { command: process.execPath, args: ['-e', 'process.exit(7)'] };

function fakeHandlers(over: Partial<DaemonHandlers> = {}): DaemonHandlers {
  return {
    embed: async ({ texts }) => texts.map(t => [t.length, 0.5]),
    rerank: async ({ passages }) => passages.map((_, index) => ({ index, score: 1 / (index + 1) })),
    expand: async ({ prompt }) => `expanded:${prompt.length}`,
    warm: async () => {},
    embedChunk: 8,
    ...over,
  };
}

const running: RunningDaemon[] = [];
const clients: ModelDaemonClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const d of running.splice(0)) await d.close();
});

function client(fingerprint: string, runDir: string, o: { requestTimeoutMs?: number; startTimeoutMs?: number; queueTimeoutMs?: number } = {}) {
  const c = new ModelDaemonClient({ fingerprint, runDir, startTimeoutMs: o.startTimeoutMs ?? 2_000, requestTimeoutMs: o.requestTimeoutMs, queueTimeoutMs: o.queueTimeoutMs, entry: NO_SPAWN });
  clients.push(c);
  return c;
}

async function pair(handlers: DaemonHandlers, opts: {
  idleMs?: number; onIdle?: () => void; requestTimeoutMs?: number; queueTimeoutMs?: number;
  stuckMs?: number; onStuck?: () => void; staleToken?: boolean;
} = {}) {
  const runDir = tmp();
  const fingerprint = uniqueFp();
  if (opts.staleToken) writeFileSync(modelDaemonPaths(fingerprint, runDir).token, 'a dead daemon\'s token');
  const d = await startModelDaemon({ fingerprint, runDir, handlers, idleMs: opts.idleMs ?? 0, onIdle: opts.onIdle,
    stuckMs: opts.stuckMs ?? 0, onStuck: opts.onStuck, log: () => {} });
  running.push(d);
  return { d, c: client(fingerprint, runDir, opts), runDir, fingerprint };
}

/** A raw connection that records every frame it receives. */
function raw(address: string) {
  const frames: any[] = [];
  const s = connect(address);
  s.setEncoding('utf8');
  const r = new FrameReader(f => frames.push(f));
  s.on('data', (ch: string) => r.push(ch));
  const closed = new Promise<void>(res => s.on('close', () => res()));
  s.on('error', () => {});
  const open = new Promise<void>(res => s.on('connect', () => res()));
  return { s, frames, closed, open };
}

describe('fingerprint and framing', () => {
  const cfg = { embedModel: 'Xenova/bge-small-en-v1.5', embedDims: 384, rerankDtype: 'fp32', rerankQueryTokens: 128 };
  const o = { env: {} as NodeJS.ProcessEnv, version: '1.0.0', root: '/pkg', code: 'reranker:1:1' };

  it('changes with the captured config, the version, the package root, the run dir and the cache dir', () => {
    const fp = modelDaemonFingerprint(cfg, o);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(modelDaemonFingerprint({ ...cfg }, { ...o })).toBe(fp);
    expect(modelDaemonFingerprint({ ...cfg, rerankDtype: 'q8' }, o)).not.toBe(fp);
    expect(modelDaemonFingerprint({ ...cfg, embedDims: 768 }, o)).not.toBe(fp);
    expect(modelDaemonFingerprint({ ...cfg, rerankQueryTokens: 256 }, o)).not.toBe(fp);
    expect(modelDaemonFingerprint(cfg, { ...o, version: '1.0.1' })).not.toBe(fp);
    expect(modelDaemonFingerprint(cfg, { ...o, root: '/other-worktree' })).not.toBe(fp);
    expect(modelDaemonFingerprint(cfg, { ...o, code: 'reranker:9999:1' })).not.toBe(fp);
    expect(modelDaemonFingerprint(cfg, { ...o, env: { AWM_RUN_DIR: '/x' } })).not.toBe(fp);
    expect(modelDaemonFingerprint(cfg, { ...o, env: { AWM_CACHE_DIR: '/models' } })).not.toBe(fp);
    // Key order does not matter.
    expect(modelDaemonFingerprint({ rerankQueryTokens: 128, rerankDtype: 'fp32', embedDims: 384, embedModel: 'Xenova/bge-small-en-v1.5' }, o)).toBe(fp);
  });

  it('passes the captured config to a spawned daemon as env', () => {
    expect(configEnv({ embedModel: 'm', embedDims: 768, rerankDtype: 'q8', expandModel: 'x' }))
      .toEqual({ AWM_EMBED_MODEL: 'm', AWM_EMBED_DIMS: '768', AWM_RERANKER_DTYPE: 'q8' });
  });

  it('a pipe name or socket path is derived from the fingerprint', () => {
    const p = modelDaemonPaths('abcdef0123456789', '/run');
    expect(p.address).toContain('abcdef0123456789');
    expect(p.token).toContain('abcdef0123456789');
  });

  it('splits frames across chunks and keeps newlines inside values', () => {
    const got: unknown[] = [];
    const r = new FrameReader(f => got.push(f));
    const wire = encodeFrame({ a: 'line1\nline2' }) + encodeFrame({ b: [1.25, -0.000123] }) + encodeFrame({ c: 1 });
    for (let i = 0; i < wire.length; i += 5) expect(r.push(wire.slice(i, i + 5))).toBe(true);
    expect(got).toEqual([{ a: 'line1\nline2' }, { b: [1.25, -0.000123] }, { c: 1 }]);
  });

  it('refuses an unterminated tail over its limit', () => {
    const r = new FrameReader(() => {}, 100);
    expect(r.push('x'.repeat(101))).toBe(false);
  });

  it('reads a long frame in many chunks in linear time', () => {
    let got = 0;
    const r = new FrameReader(() => { got++; });
    const piece = 'x'.repeat(64 * 1024);
    const t0 = performance.now();
    r.push('{"a":"');
    for (let i = 0; i < 512; i++) r.push(piece);   // 32 MB
    r.push('"}\n');
    expect(got).toBe(1);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('round-trips float32 values exactly through JSON', () => {
    const sent = Array.from(new Float32Array([0.1, -1 / 3, 1e-7, 0.123456789]));
    expect(JSON.parse(JSON.stringify(sent))).toEqual(sent);
  });
});

describe('daemon protocol (fake models)', () => {
  it('serves embed, rerank and expand', async () => {
    const { c } = await pair(fakeHandlers());
    expect(await c.request('embed', { texts: ['ab', 'abcd'], pooling: 'mean', dimensions: 2 })).toEqual([[2, 0.5], [4, 0.5]]);
    expect(await c.request('rerank', { query: 'q', passages: ['a', 'b'] })).toEqual([{ index: 0, score: 1 }, { index: 1, score: 0.5 }]);
    expect(await c.request('expand', { prompt: 'abc', maxNewTokens: 5, noRepeatNgramSize: 2 })).toBe('expanded:3');
    const stats = await c.request<any>('stats');
    expect(stats.pid).toBe(process.pid);
    expect(stats.clients).toBe(1);
    expect(stats.served).toEqual({ embed: 1, rerank: 1, expand: 1 });
    expect(c.daemonPid).toBe(process.pid);
  });

  it('refuses a client without the token, and serves nothing on that connection', async () => {
    const { d } = await pair(fakeHandlers());
    const r = raw(d.address);
    await r.open;
    r.s.write(encodeFrame({ t: 'hello', protocol: PROTOCOL_VERSION, fingerprint: d.fingerprint, nonce: 'a'.repeat(32) }));
    await sleep(100);
    expect(r.frames[0]).toMatchObject({ t: 'challenge' });
    r.s.write(encodeFrame({ t: 'auth', proof: 'f'.repeat(64) }));
    r.s.write(encodeFrame({ id: 1, op: 'stats' }));
    await r.closed;
    expect(r.frames.slice(1)).toEqual([{ t: 'hello', ok: false, error: 'bad token' }]);
  });

  it('sends nothing to a process squatting the address that cannot prove it holds the token', async () => {
    const runDir = tmp();
    const fingerprint = uniqueFp();
    const paths = modelDaemonPaths(fingerprint, runDir);
    writeFileSync(paths.token, 'the-real-token');
    const seen: any[] = [];
    const squatter = createServer(s => {
      s.setEncoding('utf8');
      const r = new FrameReader(f => {
        seen.push(f);
        if ((f as any).t === 'hello') s.write(encodeFrame({ t: 'challenge', nonce: 'b'.repeat(32), proof: '0'.repeat(64), pid: 1, version: 'x' }));
      });
      s.on('data', (ch: string) => r.push(ch));
      s.on('error', () => {});
    });
    await new Promise<void>(res => squatter.listen(paths.address, () => res()));
    try {
      const c = client(fingerprint, runDir, { startTimeoutMs: 10_000 });
      const t0 = Date.now();
      await expect(c.request('embed', { texts: ['private memory text'], pooling: 'mean', dimensions: 1 }))
        .rejects.toMatchObject({ reason: 'daemon failed authentication' });
      expect(Date.now() - t0).toBeLessThan(3_000);
      await sleep(100);
      expect(seen.map(f => f.t)).toEqual(['hello']);
      expect(JSON.stringify(seen)).not.toContain('the-real-token');
      expect(JSON.stringify(seen)).not.toContain('private memory text');
    } finally {
      await new Promise<void>(res => squatter.close(() => res()));
    }
  });

  it('a fingerprint mismatch is fatal, not retried until the timeout', async () => {
    const { runDir, fingerprint } = await pair(fakeHandlers());
    const c = client(fingerprint, runDir, { startTimeoutMs: 10_000 });
    (c as any).fingerprint = 'ffffffffffffffff';
    const t0 = Date.now();
    await expect(c.request('stats')).rejects.toMatchObject({ reason: 'fingerprint mismatch' });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('cuts off a connection that sends more than 4 KB before authenticating', async () => {
    const { d } = await pair(fakeHandlers());
    const r = raw(d.address);
    await r.open;
    r.s.write('x'.repeat(8 * 1024));
    await r.closed;
    expect(r.frames).toEqual([]);
  });

  it('a model error in the daemon is a remote error, not an outage', async () => {
    const { c } = await pair(fakeHandlers({ rerank: async () => { throw new Error('model exploded'); } }));
    const err = await c.request('rerank', { query: 'q', passages: ['a'] }).catch(e => e);
    expect(err).toBeInstanceOf(DaemonRemoteError);
    expect(err.message).toBe('model exploded');
    expect(await c.request('expand', { prompt: 'x', maxNewTokens: 1, noRepeatNgramSize: 1 })).toBe('expanded:1');
  });

  it('interactive work runs between the chunks of a background embed', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let firstChunk!: () => void;
    const started = new Promise<void>(r => { firstChunk = r; });
    const { c } = await pair(fakeHandlers({
      embed: async ({ texts }) => {
        order.push(`embed:${texts[0]}`);
        if (texts[0] === 't0') { firstChunk(); await gate; }
        return texts.map(() => [1]);
      },
      rerank: async ({ passages }) => { order.push('rerank'); return passages.map((_, index) => ({ index, score: 0 })); },
    }));
    const texts = Array.from({ length: 24 }, (_, i) => `t${i}`);
    const bg = c.request<number[][]>('embed', { texts, pooling: 'mean', dimensions: 1 }, 'background');
    await started;
    const fg = c.request('rerank', { query: 'q', passages: ['p'] });
    await sleep(150);   // let the interactive frame reach the queue while chunk 1 runs
    release();
    const [vecs] = await Promise.all([bg, fg]);
    expect(vecs).toHaveLength(24);
    expect(order).toEqual(['embed:t0', 'rerank', 'embed:t8', 'embed:t16']);
  });

  it('sessions take turns: one session\'s large write-batch does not hold up another\'s recall', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let firstChunk!: () => void;
    const started = new Promise<void>(r => { firstChunk = r; });
    const { c: a, runDir, fingerprint } = await pair(fakeHandlers({
      embed: async ({ texts }) => {
        order.push(`a:${texts[0]}`);
        if (texts[0] === 'w0') { firstChunk(); await gate; }
        return texts.map(() => [1]);
      },
      rerank: async ({ passages }) => { order.push('b:rerank'); return passages.map((_, index) => ({ index, score: 0 })); },
    }));
    const b = client(fingerprint, runDir);
    await b.request('stats');
    const texts = Array.from({ length: 24 }, (_, i) => `w${i}`);
    const big = a.request<number[][]>('embed', { texts, pooling: 'mean', dimensions: 1 });
    await started;
    const recall = b.request('rerank', { query: 'q', passages: ['p'] });
    await sleep(150);
    release();
    await Promise.all([big, recall]);
    expect(order).toEqual(['a:w0', 'b:rerank', 'a:w8', 'a:w16']);
  });

  it('a busy daemon is not a failure: waiting in the queue does not time out', async () => {
    const { c, runDir, fingerprint } = await pair(fakeHandlers({
      expand: async ({ prompt }) => { await sleep(300); return prompt; },
    }), { requestTimeoutMs: 500 });
    const other = client(fingerprint, runDir, { requestTimeoutMs: 500 });
    await other.request('stats');
    // Three 300 ms jobs ahead: the last one waits ~900 ms, each runs well inside 500 ms.
    const ahead = ['1', '2', '3'].map(p => other.request('expand', { prompt: p, maxNewTokens: 1, noRepeatNgramSize: 1 }));
    await sleep(20);
    expect(await c.request('expand', { prompt: 'mine', maxNewTokens: 1, noRepeatNgramSize: 1 })).toBe('mine');
    expect(await Promise.all(ahead)).toEqual(['1', '2', '3']);
  });

  it('a chunked embed waiting in the queue between its chunks is busy, not stuck', async () => {
    const { c, runDir, fingerprint } = await pair(fakeHandlers({
      embed: async ({ texts }) => { await sleep(50); return texts.map(() => [1]); },
      rerank: async ({ passages }) => { await sleep(100); return passages.map((_, index) => ({ index, score: 0 })); },
    }), { requestTimeoutMs: 300 });
    const other = client(fingerprint, runDir, { requestTimeoutMs: 300 });
    await other.request('stats');
    const bg = c.request<number[][]>('embed', { texts: Array.from({ length: 24 }, () => 'x'), pooling: 'mean', dimensions: 1 }, 'background');
    await sleep(20);
    // ~1 s of interactive work lands between the background chunks; each step is < 300 ms.
    const fg = Array.from({ length: 10 }, () => other.request('rerank', { query: 'q', passages: ['p'] }));
    expect(await bg).toHaveLength(24);
    expect(await Promise.all(fg)).toHaveLength(10);
  });

  it('a request that gives up waiting is dropped by the daemon, not run later', async () => {
    let ran = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { c } = await pair(fakeHandlers({
      expand: async ({ prompt }) => { if (prompt === 'block') await gate; else ran++; return prompt; },
    }), { queueTimeoutMs: 200 });
    const blocker = c.request('expand', { prompt: 'block', maxNewTokens: 1, noRepeatNgramSize: 1 });
    await sleep(20);
    await expect(c.request('expand', { prompt: 'late', maxNewTokens: 1, noRepeatNgramSize: 1 })).rejects.toMatchObject({ reason: 'queue-timeout' });
    await sleep(100);   // the cancel frame reaches the daemon before the blocker finishes
    release();
    await blocker;
    await sleep(50);
    expect(ran).toBe(0);
  });

  it('a daemon wedged on a step that never settles exits, so a fresh one can start', async () => {
    let stuck = false;
    const { c } = await pair(fakeHandlers({ expand: () => new Promise(() => {}) }), { stuckMs: 200, onStuck: () => { stuck = true; } });
    void c.request('expand', { prompt: 'x', maxNewTokens: 1, noRepeatNgramSize: 1 }).catch(() => {});
    await sleep(100);
    expect(stuck).toBe(false);
    await sleep(500);
    expect(stuck).toBe(true);
  });

  it('a cancel that arrives while a chunked job is running stops it after that chunk', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let firstChunk!: () => void;
    const started = new Promise<void>(r => { firstChunk = r; });
    const { c } = await pair(fakeHandlers({
      embed: async ({ texts }) => { calls.push(texts[0]); if (texts[0] === 'x0') { firstChunk(); await gate; } return texts.map(() => [1]); },
    }));
    const job = c.request('embed', { texts: Array.from({ length: 24 }, (_, i) => `x${i}`), pooling: 'mean', dimensions: 1 }).catch(e => e);
    await started;
    // The id of that request is 1 (the first on this client).
    (c as any).socket.write(encodeFrame({ id: 99, op: 'cancel', args: { id: 1 } }));
    await sleep(100);
    release();
    await sleep(100);
    expect(calls).toEqual(['x0']);
    c.close();
    await job;
  });

  it('the idle lease does not cut off a step that is still running', async () => {
    let idled = false;
    let warmed = false;
    const { c } = await pair(fakeHandlers({ warm: async () => { await sleep(500); warmed = true; } }), { idleMs: 100, onIdle: () => { idled = true; } });
    await c.request('stats');
    void c.request('warm').catch(() => {});
    await sleep(50);
    c.close();             // the last client leaves while the warm runs
    await sleep(300);
    expect(idled).toBe(false);
    await sleep(600);
    expect(warmed).toBe(true);
    expect(idled).toBe(true);
  });

  it('a token left by a dead daemon does not break the next start', async () => {
    const { c } = await pair(fakeHandlers(), { staleToken: true });
    expect((await c.request<any>('stats')).pid).toBe(process.pid);
  });

  it('a job that makes no progress is an outage', async () => {
    const { c } = await pair(fakeHandlers({ expand: () => new Promise(() => {}) }), { requestTimeoutMs: 300 });
    const err = await c.request('expand', { prompt: 'x', maxNewTokens: 1, noRepeatNgramSize: 1 }).catch(e => e);
    expect(err).toBeInstanceOf(DaemonUnavailableError);
    expect(err.reason).toBe('timeout');
  });

  it('exits on its idle lease once the last client leaves', async () => {
    let idled = false;
    const { c } = await pair(fakeHandlers(), { idleMs: 200, onIdle: () => { idled = true; } });
    await c.request('stats');
    await sleep(400);
    expect(idled).toBe(false);
    c.close();
    await sleep(500);
    expect(idled).toBe(true);
  });

  it('a connection still in its handshake when the lease runs out does not keep the daemon alive', async () => {
    let idled = false;
    const { d } = await pair(fakeHandlers(), { idleMs: 200, onIdle: () => { idled = true; } });
    const r = raw(d.address);
    await r.open;
    await sleep(400);   // the lease runs out while this connection has sent nothing
    await r.closed;
    expect(idled).toBe(true);
    // A hello now finds no daemon at all, rather than a half-closed one.
    r.s.destroy();
  });

  it('does not start a second daemon while one owns the address, and the loser leaves its token alone', async () => {
    const { runDir, fingerprint } = await pair(fakeHandlers());
    await expect(startModelDaemon({ fingerprint, runDir, handlers: fakeHandlers(), idleMs: 0, log: () => {} }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect((await client(fingerprint, runDir).request<any>('stats')).pid).toBe(process.pid);
  });

  it.skipIf(process.platform !== 'win32')('refuses a run dir outside the user profile on Windows', () => {
    expect(runDirProblem('C:\\Users\\Public\\awm-run')).toMatch(/outside your user profile/);
    expect(runDirProblem(tmp())).toBeNull();
  });

  it('the code stamp includes the inference library versions', () => {
    expect(codeStamp()).toMatch(/@huggingface\/transformers@\d/);
    expect(codeStamp()).toMatch(/onnxruntime-node@\d/);
  });

  it.skipIf(process.platform === 'win32')('refuses a run dir other users can write to', async () => {
    const { chmodSync } = await import('node:fs');
    const runDir = tmp();
    chmodSync(runDir, 0o777);
    const fingerprint = uniqueFp();
    await expect(startModelDaemon({ fingerprint, runDir, handlers: fakeHandlers(), idleMs: 0, log: () => {} }))
      .rejects.toThrow(/run dir/);
  });

  it('a daemon that exits during start fails the wait at once, and a stale lock does not block the start', async () => {
    const runDir = tmp();
    const fingerprint = uniqueFp();
    writeFileSync(modelDaemonPaths(fingerprint, runDir).lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    const c = client(fingerprint, runDir, { startTimeoutMs: 15_000 });
    const t0 = Date.now();
    await expect(c.request('stats')).rejects.toMatchObject({ reason: 'daemon-exited' });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(c.spawned).toBe(1);
  });
});

// Real child processes: the daemon entry under tsx, with the real models.
describe('daemon processes (real models)', () => {
  const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
    const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  it('six processes starting at once share one daemon, which exits when they leave', async () => {
    await withEnv({ AWM_RUN_DIR: tmp(), AWM_MODEL_DAEMON_IDLE_MS: '1500' }, async () => {
      const fixture = fileURLToPath(new URL('./fixtures/daemon-client.mts', import.meta.url));
      const procs = Array.from({ length: 6 }, () => spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fixture], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env }));
      try {
        const out = await Promise.all(procs.map(p => new Promise<{ pid: number; spawned: number }>((res, rej) => {
          let buf = '';
          p.stdout!.on('data', d => { buf += d; const m = buf.match(/\{.*\}/); if (m) res(JSON.parse(m[0])); });
          p.on('exit', code => rej(new Error(`client exited ${code}`)));
        })));
        expect(new Set(out.map(o => o.pid)).size).toBe(1);
        expect(out.reduce((a, o) => a + o.spawned, 0)).toBeGreaterThanOrEqual(1);
        const daemonPid = out[0].pid;
        expect(procs.map(p => p.pid)).not.toContain(daemonPid);
        for (const p of procs) p.stdin!.end();
        const deadline = Date.now() + 15_000;
        while (pidAlive(daemonPid) && Date.now() < deadline) await sleep(200);
        expect(pidAlive(daemonPid)).toBe(false);
      } finally {
        for (const p of procs) p.kill();
      }
    });
  }, 120_000);

  it('the daemon survives a tree kill of the process that started it', async () => {
    // What Claude Code does to an MCP server that does not exit when its session closes.
    const treeKill = (pid: number) => {
      if (process.platform === 'win32') { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }); return; }
      // Linux: read the process table from /proc — slim containers ship no `ps` (the Linux
      // suite's node:22 image failed here with spawnSync ps ENOENT). Elsewhere, `ps`.
      const rows: number[][] = process.platform === 'linux'
        ? readdirSync('/proc').filter((d) => /^\d+$/.test(d)).flatMap((d) => {
            try {
              const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
              // Field 4 is the ppid; the command (field 2) may contain spaces, so split after its ')'.
              const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
              return [[Number(d), Number(after[1])]];
            } catch { return []; }
          })
        : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
      const tree = [pid];
      for (let i = 0; i < tree.length; i++) for (const [p, pp] of rows) if (pp === tree[i]) tree.push(p);
      for (const p of tree) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    };
    await withEnv({ AWM_RUN_DIR: tmp(), AWM_MODEL_DAEMON_IDLE_MS: '1500' }, async () => {
      const fixture = fileURLToPath(new URL('./fixtures/daemon-client.mts', import.meta.url));
      const p = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fixture], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
      let daemonPid = 0;
      try {
        const out = await new Promise<{ pid: number; spawned: number }>((res, rej) => {
          let buf = '';
          p.stdout!.on('data', d => { buf += d; const m = buf.match(/\{.*\}/); if (m) res(JSON.parse(m[0])); });
          p.on('exit', code => rej(new Error(`client exited ${code}`)));
        });
        expect(out.spawned).toBe(1);
        daemonPid = out.pid;
        treeKill(p.pid!);
        await sleep(1000);
        expect(pidAlive(daemonPid)).toBe(true);
        // And it still serves: a new client reaches the same daemon without starting one.
        const { registeredInferenceConfig } = await import('../../src/core/ml-worker.js');
        await import('../../src/core/embeddings.js');
        await import('../../src/core/reranker.js');
        await import('../../src/core/query-expander.js');
        const c = new ModelDaemonClient({ fingerprint: modelDaemonFingerprint(registeredInferenceConfig()), startTimeoutMs: 5_000 });
        clients.push(c);
        expect((await c.request<{ pid: number }>('stats')).pid).toBe(daemonPid);
        expect(c.spawned).toBe(0);
        c.close();
        const deadline = Date.now() + 15_000;
        while (pidAlive(daemonPid) && Date.now() < deadline) await sleep(200);
        expect(pidAlive(daemonPid)).toBe(false);
      } finally {
        p.kill();
        if (daemonPid && pidAlive(daemonPid)) process.kill(daemonPid);
      }
    });
  }, 120_000);

  it('ml-worker sends inference to the daemon, which returns exactly what in-process returns, and restarts after a kill', async () => {
    await withEnv({ AWM_RUN_DIR: tmp(), AWM_MODEL_DAEMON: '1', AWM_MODEL_DAEMON_IDLE_MS: '1500' }, async () => {
      const mw = await import('../../src/core/ml-worker.js');
      const { inProcessEmbed } = await import('../../src/core/embeddings.js');
      const { inProcessRerank } = await import('../../src/core/reranker.js');
      const { inProcessExpand } = await import('../../src/core/query-expander.js');
      await mw.__resetModelDaemonClient();
      try {
        const texts = Array.from({ length: 20 }, (_, i) => `memory ${i}: the nightly import fails on host ${i} after the move`);
        const args = { texts, pooling: 'mean' as const, dimensions: 384 };
        const want = await inProcessEmbed(args);
        expect(await mw.dispatchEmbed(args)).toEqual(want);                 // interactive, chunked by the daemon
        expect(await mw.dispatchEmbed(args, 'background')).toEqual(want);   // background lane
        const st = mw.modelDaemonStatus();
        expect(st.mode).toBe('daemon');
        expect(st.fallbacks).toBe(0);
        expect(st.daemonPid).not.toBe(process.pid);

        // A long query exercises the 128-token cap on the daemon's side.
        const rr = { query: `why does the nightly import fail ${'2026-10-16T13:00:07Z INFO worker heartbeat ok '.repeat(30)}`, passages: texts.slice(0, 12) };
        expect(await mw.dispatchRerank(rr)).toEqual(await inProcessRerank(rr));
        const ex = { prompt: 'Expand this search query with synonyms. Query: nightly import failure. Additional terms:', maxNewTokens: 25, noRepeatNgramSize: 2 };
        expect(await mw.dispatchExpand(ex)).toBe(await inProcessExpand(ex));

        const first = st.daemonPid!;
        process.kill(first);
        await sleep(300);
        expect(await mw.dispatchEmbed({ ...args, texts: texts.slice(0, 2) })).toEqual(want.slice(0, 2));
        const second = mw.modelDaemonStatus().daemonPid!;
        expect(second).not.toBe(first);
        expect(mw.modelDaemonStatus().fallbacks).toBe(0);
        await mw.__resetModelDaemonClient();
        // The last client left: the daemon exits on its 1.5 s lease.
        const deadline = Date.now() + 15_000;
        while (pidAlive(second) && Date.now() < deadline) await sleep(200);
        expect(pidAlive(second)).toBe(false);
      } finally {
        await mw.__resetModelDaemonClient();
      }
    });
  }, 180_000);

  it('a daemon whose code changed since its spawner started refuses to start, and the spawner gives up at once', async () => {
    await withEnv({ AWM_RUN_DIR: tmp() }, async () => {
      // A fingerprint this code does not compute: as if the spawner predates a rebuild.
      const c = new ModelDaemonClient({ fingerprint: 'deadbeefdeadbeef', startTimeoutMs: 60_000 });
      clients.push(c);
      const t0 = Date.now();
      await expect(c.request('stats')).rejects.toMatchObject({ reason: 'code-changed' });
      expect(Date.now() - t0).toBeLessThan(30_000);
    });
  }, 60_000);

  it('ml-worker falls back to in-process inference when the daemon cannot start, and says why', async () => {
    const blocker = join(tmp(), 'not-a-dir');
    writeFileSync(blocker, '');
    await withEnv({ AWM_MODEL_DAEMON: '1', AWM_RUN_DIR: blocker }, async () => {
      const mw = await import('../../src/core/ml-worker.js');
      const { inProcessEmbed } = await import('../../src/core/embeddings.js');
      await mw.__resetModelDaemonClient();
      try {
        const args = { texts: ['hello world'], pooling: 'mean' as const, dimensions: 384 };
        expect(await mw.dispatchEmbed(args)).toEqual(await inProcessEmbed(args));
        const st = mw.modelDaemonStatus();
        expect(st.enabled).toBe(true);
        expect(st.mode).toBe('in-process-fallback');
        expect(st.fallbacks).toBe(1);
        expect(st.lastFallbackReason).toBeTruthy();
        // Inside the retry window: served in-process at once, no second attempt.
        const t0 = Date.now();
        await mw.dispatchEmbed(args);
        expect(Date.now() - t0).toBeLessThan(1_000);
        expect(mw.modelDaemonStatus().fallbacks).toBe(1);
      } finally {
        await mw.__resetModelDaemonClient();
      }
    });
  }, 60_000);
});
