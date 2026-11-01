// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * The shared model daemon process (see model-daemon.ts for the design).
 *
 * It runs ONE inference at a time. onnxruntime-node's CPU arena grows to the largest
 * tensor a session has run, so concurrent runs on the same session would multiply the
 * high-water mark this daemon exists to bound. One at a time costs no speed: four
 * processes recalling at once on one machine finished in 12.3 min with their own models
 * and 11.6 min through one daemon, because they compete for the same cores anyway.
 *
 * Scheduling: interactive requests run before background ones. An embed is run one
 * chunk at a time; an unfinished interactive embed goes to the back of its lane, so
 * sessions take turns and one session's 100-memory write-batch cannot hold up another
 * session's recall; an unfinished background embed goes to the front of its lane, so
 * its chunks stay in order. A request whose connection has closed is dropped unrun.
 * Each step reports `started` when it begins, and a job sent back to the queue between
 * chunks reports `requeued`, so a client's run timer covers only time the daemon spends
 * on its job: its timeout measures a stuck daemon, never a busy one. A step that runs
 * longer than AWM_MODEL_DAEMON_STUCK_MS (default: the client's step timeout, 2 min; for
 * a warm, which may download the models, the client's 10 min) means the daemon is wedged
 * on a promise that will never settle: it exits, and the next client starts a fresh one.
 * The two limits are the same so that a client that gave up on a step is never left
 * reconnecting to the daemon still stuck on it.
 *
 * The daemon exits when no authenticated client has been connected for
 * AWM_MODEL_DAEMON_IDLE_MS (default 5 min). Clients hold one connection each for the
 * life of their process.
 */

import { createServer, connect, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PROTOCOL_VERSION, HELLO_MAX_BYTES, MAX_FRAME_BYTES, addressProblem, encodeFrame, envInt, FrameReader,
  modelDaemonPaths, proof, proofMatches, runDirProblem, REQUEST_TIMEOUT_MS, WARM_TIMEOUT_MS,
  type AuthFrame, type HelloFrame, type Lane, type RequestFrame, type ResponseFrame,
} from './model-daemon.js';
import { VERSION } from '../version.js';

export interface DaemonHandlers {
  embed(args: { texts: string[]; pooling: 'cls' | 'mean'; dimensions: number }): Promise<number[][]>;
  rerank(args: { query: string; passages: string[]; natural?: boolean }): Promise<Array<{ index: number; score: number }>>;
  expand(args: { prompt: string; maxNewTokens: number; noRepeatNgramSize: number }): Promise<string>;
  warm(): Promise<void>;
  /** Texts per scheduling step for an embed; 0 = the whole request at once. */
  embedChunk: number;
}

export interface DaemonOptions {
  fingerprint: string;
  runDir?: string;
  idleMs?: number;
  handlers: DaemonHandlers;
  log?: (msg: string) => void;
  /** Called when the idle lease runs out, after the server has closed. The entry exits. */
  onIdle?: () => void;
  /** A step running longer than this is wedged (a warm gets WARM_TIMEOUT_MS at least). */
  stuckMs?: number;
  /** Called when a step is wedged. The entry exits with an error. */
  onStuck?: () => void;
}

interface Job {
  socket: Socket;
  id: number;
  op: RequestFrame['op'];
  lane: Lane;
  args: any;
  /** Embed: the next slice to run and the vectors so far. */
  offset?: number;
  vectors?: number[][];
}

export interface RunningDaemon {
  server: Server;
  address: string;
  fingerprint: string;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 5_000;

/** Windows refuses a rename over a file another process has open; clients open it briefly. */
async function replaceFile(tmp: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, target); return; } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 40) {
        try { unlinkSync(tmp); } catch { /* nothing to clean */ }
        throw err;
      }
      await delay(25);
    }
  }
}

/** A unix socket file left by a crashed daemon refuses connections; a live one accepts. */
function removeStaleSocket(address: string): Promise<void> {
  if (process.platform === 'win32' || !existsSync(address)) return Promise.resolve();
  return new Promise(resolve => {
    const probe = connect(address);
    probe.once('connect', () => { probe.destroy(); resolve(); });
    probe.once('error', () => { try { unlinkSync(address); } catch { /* raced */ } resolve(); });
  });
}

export async function startModelDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const { fingerprint } = opts;
  const paths = modelDaemonPaths(fingerprint, opts.runDir);
  const idleMs = opts.idleMs ?? envInt('AWM_MODEL_DAEMON_IDLE_MS', 300_000);
  const log = opts.log ?? ((m: string) => console.error(`[model-daemon ${new Date().toISOString()}] ${m}`));
  const h = opts.handlers;

  const problem = addressProblem(paths);
  if (problem) throw new Error(problem);
  // A run dir that ALREADY exists and is world-writable is refused before anything is
  // tightened: another user may have planted a symlink in it while it was open, and the
  // token and log are about to be written there. The chmod below used to run first, so the
  // check after it could never fire for a directory this user owns — found by the Linux
  // suite (the test is skipped on Windows). Group-writable is still tightened, not refused:
  // umask 002 makes 0775 the norm on user-private-group distros, and the group is the user's own.
  if (process.platform !== 'win32' && existsSync(paths.runDir)) {
    const pre = statSync(paths.runDir);
    if (pre.mode & 0o002) throw new Error(`run dir ${paths.runDir} is writable by other users`);
  }
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  try { chmodSync(paths.runDir, 0o700); } catch { /* not ours to change, or Windows */ }
  const unsafe = runDirProblem(paths.runDir);
  if (unsafe) throw new Error(unsafe);
  const stuckMs = opts.stuckMs ?? envInt('AWM_MODEL_DAEMON_STUCK_MS', envInt('AWM_MODEL_DAEMON_TIMEOUT_MS', REQUEST_TIMEOUT_MS));
  await removeStaleSocket(paths.address);

  const token = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();   // every connection, authenticated or not
  /** Requests a client gave up on, per connection: never started, or never continued. */
  const cancelled = new WeakMap<Socket, Set<number>>();
  const isCancelled = (job: Job) => cancelled.get(job.socket)?.has(job.id) ?? false;
  /** Until the token file is ours, a hello is told to retry, not proved with a token the
   * file does not hold yet (the rename may be retried on Windows). */
  let tokenReady = false;
  const clients = new Set<Socket>();   // authenticated ones: these hold the lease
  const interactive: Job[] = [];
  const background: Job[] = [];
  const served: Record<string, number> = {};
  const startedAt = Date.now();
  let busy = false;
  let current: { op: string; since: number } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closing: Promise<void> | null = null;

  const send = (socket: Socket, frame: ResponseFrame) => {
    if (!socket.destroyed) socket.write(encodeFrame(frame));
  };

  const armIdle = () => {
    if (idleTimer || clients.size > 0 || idleMs <= 0 || closing) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size > 0) return;
      // A step still running (a first-run warm downloading the models) finishes first.
      if (current || interactive.length || background.length) { armIdle(); return; }
      log(`no clients for ${idleMs} ms, exiting`);
      void running.close().then(() => (opts.onIdle ?? (() => process.exit(0)))());
    }, idleMs);
    idleTimer.unref?.();
  };

  /** Runs one step of a job. Returns true when the job is finished. */
  async function step(job: Job): Promise<boolean> {
    send(job.socket, { id: job.id, started: true });
    if (job.vectors) {
      const texts: string[] = job.args.texts;
      const size = h.embedChunk > 0 ? h.embedChunk : texts.length;
      const slice = texts.slice(job.offset!, job.offset! + size);
      job.vectors.push(...await h.embed({ ...job.args, texts: slice }));
      job.offset! += slice.length;
      if (job.offset! < texts.length) return false;
      send(job.socket, { id: job.id, ok: true, result: job.vectors });
      return true;
    }
    let result: unknown;
    switch (job.op) {
      case 'embed': result = await h.embed(job.args); break;
      case 'rerank': result = await h.rerank(job.args); break;
      case 'expand': result = await h.expand(job.args); break;
      case 'warm': await h.warm(); result = true; break;
      default: throw new Error(`unknown op ${String(job.op)}`);
    }
    send(job.socket, { id: job.id, ok: true, result });
    return true;
  }

  async function pump(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const job = interactive.shift() ?? background.shift();
        if (!job) break;
        if (job.socket.destroyed || isCancelled(job)) continue;
        let done = true;
        current = { op: job.op, since: Date.now() };
        try {
          done = await step(job);
        } catch (err) {
          send(job.socket, { id: job.id, ok: false, error: (err as Error)?.message ?? String(err) });
        } finally {
          current = null;
        }
        if (done) { served[job.op] = (served[job.op] ?? 0) + 1; continue; }
        // Back in the queue between chunks: the client's run timer stops until the next
        // step starts, because waiting here is the daemon being busy, not stuck.
        if (isCancelled(job)) continue;
        send(job.socket, { id: job.id, requeued: true });
        if (job.lane === 'interactive') interactive.push(job);
        else background.unshift(job);
      }
    } finally {
      busy = false;
    }
  }

  const onRequest = (socket: Socket, frame: RequestFrame) => {
    if (typeof frame?.id !== 'number') return;
    if (frame.op === 'cancel') {
      // The client gave up waiting: drop the job, or stop it after its running step.
      const id = (frame.args as any)?.id;
      if (typeof id !== 'number') return;
      let set = cancelled.get(socket);
      if (!set) cancelled.set(socket, (set = new Set()));
      if (set.size >= 10_000) set.clear();
      set.add(id);
      for (const q of [interactive, background]) {
        const i = q.findIndex(j => j.socket === socket && j.id === id);
        if (i >= 0) q.splice(i, 1);
      }
      return;
    }
    if (frame.op === 'stats') {
      send(socket, {
        id: frame.id, ok: true, result: {
          pid: process.pid, fingerprint, version: VERSION, uptimeMs: Date.now() - startedAt,
          clients: clients.size, queued: { interactive: interactive.length, background: background.length },
          served, rssBytes: process.memoryUsage().rss,
          current: current ? { op: current.op, runningMs: Date.now() - current.since } : null,
        },
      });
      return;
    }
    const lane: Lane = frame.lane === 'background' ? 'background' : 'interactive';
    const job: Job = { socket, id: frame.id, op: frame.op, lane, args: frame.args };
    if (frame.op === 'embed' && Array.isArray((frame.args as any)?.texts)) {
      job.offset = 0;
      job.vectors = [];
    }
    (lane === 'background' ? background : interactive).push(job);
    void pump();
  };

  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let stage: 'hello' | 'auth' | 'ready' = 'hello';
    let clientNonce = '';
    let daemonNonce = '';
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const refuse = (error: string) => { clearTimeout(helloTimer); socket.end(encodeFrame({ t: 'hello', ok: false, error })); };
    const reader = new FrameReader(frame => {
      if (stage === 'ready') return onRequest(socket, frame as RequestFrame);
      if (closing) return refuse('closing');
      if (!tokenReady) return refuse('starting');
      if (stage === 'hello') {
        const hello = frame as HelloFrame;
        if (hello?.t !== 'hello') return refuse('expected hello');
        if (hello.protocol !== PROTOCOL_VERSION) return refuse(`protocol ${hello.protocol} != ${PROTOCOL_VERSION}`);
        if (hello.fingerprint !== fingerprint) return refuse('fingerprint mismatch');
        if (typeof hello.nonce !== 'string' || hello.nonce.length < 32) return refuse('bad nonce');
        clientNonce = hello.nonce;
        daemonNonce = randomBytes(16).toString('hex');
        stage = 'auth';
        socket.write(encodeFrame({
          t: 'challenge', nonce: daemonNonce, pid: process.pid, version: VERSION,
          proof: proof(token, 'daemon', clientNonce, daemonNonce, fingerprint),
        }));
        return;
      }
      const auth = frame as AuthFrame;
      if (auth?.t !== 'auth' || !proofMatches(proof(token, 'client', clientNonce, daemonNonce, fingerprint), auth.proof)) {
        return refuse('bad token');
      }
      clearTimeout(helloTimer);
      stage = 'ready';
      reader.limit = MAX_FRAME_BYTES;
      clients.add(socket);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      socket.write(encodeFrame({ t: 'hello', ok: true }));
    }, HELLO_MAX_BYTES);
    socket.on('data', (chunk: string) => { if (!reader.push(chunk)) socket.destroy(); });
    socket.on('error', () => { /* the close handler cleans up */ });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      sockets.delete(socket);
      if (clients.delete(socket)) armIdle();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.address, () => { server.off('error', reject); resolve(); });
  });
  if (process.platform !== 'win32') { try { chmodSync(paths.address, 0o600); } catch { /* best effort */ } }
  // The token is written only once this daemon owns the address. A second daemon that
  // lost the race (EADDRINUSE above) must not overwrite the live one's token. A client
  // that connected in the gap read no token or an old one; it is refused and retries.
  const tmp = `${paths.token}.${process.pid}`;
  writeFileSync(tmp, token, { mode: 0o600 });
  try {
    await replaceFile(tmp, paths.token);
  } catch (err) {
    server.close();
    throw err;
  }
  tokenReady = true;
  log(`listening on ${paths.address} (pid ${process.pid}, AWM ${VERSION}, fingerprint ${fingerprint})`);
  armIdle();

  const watchdog = stuckMs > 0 ? setInterval(() => {
    if (!current) return;
    const limit = current.op === 'warm' ? Math.max(stuckMs, WARM_TIMEOUT_MS) : stuckMs;
    if (Date.now() - current.since <= limit) return;
    log(`${current.op} has run for ${Date.now() - current.since} ms: wedged, exiting so a fresh daemon can start`);
    if (watchdog) clearInterval(watchdog);
    void running.close().then(() => (opts.onStuck ?? (() => process.exit(1)))());
  }, Math.min(5_000, Math.max(50, Math.floor(stuckMs / 4)))) : null;
  watchdog?.unref?.();

  const running: RunningDaemon = {
    server, address: paths.address, fingerprint,
    close: () => (closing ??= new Promise<void>(resolve => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (watchdog) clearInterval(watchdog);
      // Every connection, including one still in its handshake: server.close() waits for
      // all of them, and a late hello must not authenticate against a closing daemon.
      for (const s of sockets) s.destroy();
      server.close(() => {
        try { if (readFileSync(paths.token, 'utf8') === token) unlinkSync(paths.token); } catch { /* already gone */ }
        resolve();
      });
    })),
  };
  return running;
}
