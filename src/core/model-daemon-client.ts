// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Client side of the shared model daemon (see model-daemon.ts).
 *
 * Connecting: try the daemon's address. If nothing answers, take the lockfile (O_EXCL,
 * holding this pid) and spawn the daemon detached, through a launcher so that it is not
 * this process's child (see LAUNCHER); every other process starting at the
 * same moment finds the lock taken and just keeps trying to connect. A lock whose pid is
 * dead, or that is older than the start timeout, is stale and is taken over, so a
 * spawner that crashed mid-start blocks nobody. A daemon this client spawned that exits
 * with an error ends the wait at once instead of at the start timeout.
 *
 * Timeouts: a request waits in the daemon's queue for up to AWM_MODEL_DAEMON_QUEUE_MS
 * (10 min) without failing, because a busy daemon is not a broken one; when it gives up
 * it tells the daemon to drop the job. While the daemon reports a step `started` (and
 * until it reports the job `requeued` between chunks), the step must finish within
 * AWM_MODEL_DAEMON_TIMEOUT_MS (2 min); a daemon that does not is stuck, and the
 * connection is dropped.
 *
 * The client never falls back to in-process inference itself; ml-worker.ts decides that.
 */

import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROTOCOL_VERSION, HELLO_MAX_BYTES, MAX_FRAME_BYTES, addressProblem, encodeFrame, envInt, FrameReader,
  modelDaemonPaths, proof, proofMatches, runDirProblem, EXIT_FINGERPRINT_DRIFT, REQUEST_TIMEOUT_MS, WARM_TIMEOUT_MS,
  type DaemonPaths, type Lane, type ModelOp, type ResponseFrame,
} from './model-daemon.js';

/** The daemon ran the request and it failed there. In-process would fail the same way. */
export class DaemonRemoteError extends Error {}

/** The daemon could not be reached or stopped answering. */
export class DaemonUnavailableError extends Error {
  constructor(message: string, readonly reason: string) { super(message); }
}

export interface DaemonEntry { command: string; args: string[] }

export interface ClientOptions {
  fingerprint: string;
  runDir?: string;
  /** How to start the daemon. Defaults to this package's model-daemon entry. */
  entry?: DaemonEntry;
  /** Extra env for a spawned daemon: the client's captured inference config. */
  spawnEnv?: Record<string, string>;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  queueTimeoutMs?: number;
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const POLL_MS = 150;
const HELLO_TIMEOUT_MS = 5_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Starts the daemon and exits once it listens, passing on its exit code if it stops
 * before that. The daemon's parent is then a process that no longer exists, so a tree
 * kill of the AWM process that started it does not reach it: when Claude Code closes a
 * session whose MCP server does not exit on stdin close, it kills the server's whole
 * process tree, and a daemon spawned directly died with it (measured with Claude Code
 * 2.1.302 on Windows). Inline, so it needs no loader in dev.
 */
const LAUNCHER = [
  "const c = require('node:child_process').spawn(process.argv[1], process.argv.slice(2),",
  "  { detached: true, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });",
  "c.on('message', () => process.exit(0));",
  "c.on('exit', code => process.exit(code ?? 1));",
  "c.on('error', () => process.exit(1));",
].join('\n');

export function defaultDaemonEntry(): DaemonEntry {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = join(here, '..', 'model-daemon.js');
  if (existsSync(js)) return { command: process.execPath, args: [js] };
  // Running from src/ under tsx (dev, tests): the daemon needs the same loader.
  const ts = join(here, '..', 'model-daemon.ts');
  return { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), ts] };
}

interface Pending {
  op: ModelOp;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ModelDaemonClient {
  readonly fingerprint: string;
  readonly paths: DaemonPaths;
  private readonly entry: DaemonEntry;
  private readonly spawnEnv: Record<string, string>;
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly queueTimeoutMs: number;
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  daemonPid: number | null = null;
  spawned = 0;

  constructor(opts: ClientOptions) {
    this.fingerprint = opts.fingerprint;
    this.paths = modelDaemonPaths(this.fingerprint, opts.runDir);
    this.entry = opts.entry ?? defaultDaemonEntry();
    this.spawnEnv = opts.spawnEnv ?? {};
    this.startTimeoutMs = opts.startTimeoutMs ?? envInt('AWM_MODEL_DAEMON_START_MS', 20_000);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? envInt('AWM_MODEL_DAEMON_TIMEOUT_MS', REQUEST_TIMEOUT_MS);
    this.queueTimeoutMs = opts.queueTimeoutMs ?? envInt('AWM_MODEL_DAEMON_QUEUE_MS', 10 * 60_000);
  }

  get connected(): boolean { return !!this.socket && !this.socket.destroyed; }

  async request<T>(op: ModelOp, args?: unknown, lane: Lane = 'interactive'): Promise<T> {
    const socket = await this.ensureConnected();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { op, resolve, reject, timer: this.queueTimer(id, op) };
      this.pending.set(id, p);
      socket.write(encodeFrame({ id, op, lane, args }));
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  /** Waiting in the queue: fail this request only, the daemon is busy, not gone. */
  private queueTimer(id: number, op: ModelOp): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.reject(new DaemonUnavailableError(`model daemon: ${op} still queued after ${this.queueTimeoutMs} ms`, 'queue-timeout'));
      if (this.socket && !this.socket.destroyed) this.socket.write(encodeFrame({ id: this.nextId++, op: 'cancel', args: { id } }));
    }, this.queueTimeoutMs);
  }

  /** Running: no answer and no progress in time means the daemon is stuck. */
  private runTimer(id: number, op: ModelOp): ReturnType<typeof setTimeout> {
    const ms = op === 'warm' ? Math.max(this.requestTimeoutMs, WARM_TIMEOUT_MS) : this.requestTimeoutMs;
    return setTimeout(() => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.reject(new DaemonUnavailableError(`model daemon: ${op} step ran over ${ms} ms`, 'timeout'));
      this.socket?.destroy();
    }, ms);
  }

  private ensureConnected(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    this.connecting ??= this.connectOrSpawn().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connectOrSpawn(): Promise<Socket> {
    const problem = addressProblem(this.paths);
    if (problem) throw new DaemonUnavailableError(problem, 'socket-path-too-long');
    if (existsSync(this.paths.runDir)) {
      const unsafe = runDirProblem(this.paths.runDir);
      if (unsafe) throw new DaemonUnavailableError(unsafe, 'run-dir-unsafe');
    }
    const deadline = Date.now() + this.startTimeoutMs;
    let holdsLock = false;
    let exited: number | null = null;
    let last = 'unreachable';
    try {
      for (;;) {
        const r = await this.tryConnect();
        if (r.socket) return r.socket;
        last = r.reason;
        // A daemon of a different protocol or config, or one that cannot prove it holds
        // the token, will not change by waiting.
        if (r.fatal) throw new DaemonUnavailableError(`model daemon refused: ${r.reason}`, r.reason);
        if (exited === EXIT_FINGERPRINT_DRIFT) {
          // This process computed its fingerprint from code that has since changed on disk
          // (a rebuild, an update): a daemon started now is a different daemon.
          throw new DaemonUnavailableError('model daemon code changed on disk since this process started; restart the session to use the daemon', 'code-changed');
        }
        if (exited !== null && exited !== 0) {
          throw new DaemonUnavailableError(`model daemon exited with code ${exited} during start; see ${this.paths.log}`, 'daemon-exited');
        }
        if (!holdsLock && !['bad token', 'starting'].includes(r.reason) && this.takeLock()) {
          holdsLock = true;
          // Exit code 0 is a daemon that lost the start race to another: keep polling.
          this.spawnDaemon(code => { exited = code; });
        }
        if (Date.now() >= deadline) break;
        await sleep(POLL_MS);
      }
    } finally {
      if (holdsLock) this.releaseLock();
    }
    throw new DaemonUnavailableError(`model daemon did not start within ${this.startTimeoutMs} ms (${last}); see ${this.paths.log}`, 'start-timeout');
  }

  private tryConnect(): Promise<{ socket?: Socket; reason: string; fatal?: boolean }> {
    return new Promise(resolve => {
      let settled = false;
      const done = (v: { socket?: Socket; reason: string; fatal?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!v.socket) socket.destroy();
        resolve(v);
      };
      const socket = connect(this.paths.address);
      socket.setEncoding('utf8');
      const timer = setTimeout(() => done({ reason: 'hello timeout' }), HELLO_TIMEOUT_MS);
      socket.once('error', err => done({ reason: (err as NodeJS.ErrnoException).code ?? err.message }));
      socket.once('close', () => done({ reason: 'closed during hello' }));
      socket.once('connect', () => {
        // The token is read when the challenge arrives, not now: a daemon that has
        // answered has written its token, while one that only just started listening may
        // not have replaced a dead daemon's file yet.
        const readToken = () => { try { return readFileSync(this.paths.token, 'utf8').trim(); } catch { return ''; } };
        let token = '';
        const nonce = randomBytes(16).toString('hex');
        let stage: 'challenge' | 'result' | 'ready' = 'challenge';
        let daemonPid: number | null = null;
        const reader = new FrameReader(frame => {
          if (stage === 'ready') return this.onResponse(frame as ResponseFrame);
          const f = frame as { t?: string; ok?: boolean; error?: string; nonce?: string; proof?: string; pid?: number };
          if (f?.t === 'hello' && !f.ok) {
            const reason = f.error ?? 'refused';
            // 'starting': the daemon has not written its token yet. 'closing': it is
            // exiting on its lease. 'bad token': our proof used a stale file. All three
            // clear up by trying again.
            return done({ reason, fatal: !['bad token', 'closing', 'starting'].includes(reason) });
          }
          if (stage === 'challenge') {
            if (f?.t !== 'challenge') return done({ reason: 'unexpected handshake frame', fatal: true });
            const verifies = (t: string) => !!t && proofMatches(proof(t, 'daemon', nonce, String(f.nonce), this.fingerprint), f.proof);
            token = readToken();
            if (!verifies(token)) {
              token = readToken();   // a rename may have landed between the two reads
              if (!verifies(token)) {
                // Whatever answered on our address does not hold our token: send it nothing.
                return done({ reason: 'daemon failed authentication', fatal: true });
              }
            }
            daemonPid = f.pid ?? null;
            stage = 'result';
            socket.write(encodeFrame({ t: 'auth', proof: proof(token, 'client', nonce, String(f.nonce), this.fingerprint) }));
            return;
          }
          if (f?.t === 'hello' && f.ok) {
            stage = 'ready';
            reader.limit = MAX_FRAME_BYTES;
            this.daemonPid = daemonPid;
            this.attach(socket);
            return done({ socket, reason: 'ok' });
          }
          return done({ reason: 'unexpected handshake frame', fatal: true });
        }, HELLO_MAX_BYTES);
        socket.on('data', (chunk: string) => { if (!reader.push(chunk)) socket.destroy(); });
        socket.write(encodeFrame({ t: 'hello', protocol: PROTOCOL_VERSION, fingerprint: this.fingerprint, nonce }));
      });
    });
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    socket.removeAllListeners('close');
    socket.removeAllListeners('error');
    socket.on('error', () => { /* close follows */ });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new DaemonUnavailableError('model daemon disconnected', 'disconnected'));
      }
      this.pending.clear();
    });
    // The connection must not keep an otherwise finished process alive.
    socket.unref();
  }

  private onResponse(frame: ResponseFrame): void {
    const p = this.pending.get(frame?.id);
    if (!p) return;
    if (frame.started) {
      clearTimeout(p.timer);
      p.timer = this.runTimer(frame.id, p.op);
      return;
    }
    if (frame.requeued) {
      clearTimeout(p.timer);
      p.timer = this.queueTimer(frame.id, p.op);
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.result);
    else p.reject(new DaemonRemoteError(frame.error ?? 'model daemon error'));
  }

  private takeLock(): boolean {
    mkdirSync(this.paths.runDir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.paths.lock, 'wx', 0o600);
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        closeSync(fd);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let holder: { pid?: number; at?: number } = {};
        try { holder = JSON.parse(readFileSync(this.paths.lock, 'utf8')); } catch { /* half-written: judge by age */ }
        const age = Date.now() - (holder.at ?? statMtime(this.paths.lock));
        if (pidAlive(holder.pid ?? -1) && age < this.startTimeoutMs) return false;
        // Two processes can both judge it stale and both start a daemon; the second to
        // listen gets EADDRINUSE and exits 0, so the race costs one process start.
        try { unlinkSync(this.paths.lock); } catch { /* another process took it over first */ }
      }
    }
    return false;
  }

  private releaseLock(): void {
    try {
      const holder = JSON.parse(readFileSync(this.paths.lock, 'utf8'));
      if (holder.pid === process.pid) unlinkSync(this.paths.lock);
    } catch { /* gone already */ }
  }

  private spawnDaemon(onExit: (code: number) => void): void {
    let fd: number | 'ignore' = 'ignore';
    try {
      if (existsSync(this.paths.log) && statSync(this.paths.log).size > LOG_MAX_BYTES) {
        renameSync(this.paths.log, `${this.paths.log}.1`);
      }
      fd = openSync(this.paths.log, 'a', 0o600);
    } catch { /* no log, still start */ }
    try {
      // The exit code is the launcher's: 0 once the daemon listens (or lost the race),
      // otherwise the daemon's own.
      const child = spawn(process.execPath, ['-e', LAUNCHER, '--', this.entry.command, ...this.entry.args], {
        // Not the session's project directory: on Windows a process's cwd cannot be
        // deleted or renamed, and the daemon outlives the session that started it.
        cwd: this.paths.runDir,
        detached: true, windowsHide: true,
        env: { ...process.env, ...this.spawnEnv, AWM_MODEL_DAEMON_FINGERPRINT: this.fingerprint },
        stdio: ['ignore', fd, fd],
      });
      child.on('error', err => { console.error(`[awm] model daemon spawn failed: ${err.message}`); onExit(-1); });
      child.on('exit', code => onExit(code ?? -1));
      child.unref();
      this.spawned++;
    } finally {
      if (typeof fd === 'number') closeSync(fd);
    }
  }
}

function statMtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}
