// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared model daemon: what the client and the daemon agree on.
 *
 * Every AWM MCP process used to load its own three ONNX models (embedder, cross-encoder,
 * query expander): about 1.1 GB per process even with the input-shape caps, so six
 * Claude Code sessions held 6+ GB of identical weights and arenas. With
 * AWM_MODEL_DAEMON=1, one per-user process holds the models and every AWM process on the
 * machine sends inference to it over a local socket. Store, engine and recall stay in
 * each process; only the three dispatch calls in ml-worker.ts cross the socket.
 *
 * This module has no model imports, so a client that only talks to the daemon never
 * loads @huggingface/transformers' models itself.
 *
 * - The daemon is keyed by a FINGERPRINT of the inference config the model modules
 *   actually captured (model ids, dtype, dimensions, pooling, shape caps), the model
 *   cache dir, the AWM version and package root, the user and the run dir. Two installs,
 *   two versions or two configs get separate daemons and can never mix vectors. The
 *   spawned daemon is given the client's captured config as env, so a value applied
 *   after the modules loaded (a .env file) cannot make the two disagree; the handshake
 *   checks the fingerprint again.
 * - Transport: a named pipe on Windows, a unix socket in ~/.awm/run (0700) elsewhere.
 * - Authentication is mutual, by HMAC over two nonces with the token the daemon wrote to
 *   the run dir (0600). The token itself never crosses the socket, so a process that
 *   took the pipe name first learns nothing and is refused by the client.
 * - Frames are newline-delimited JSON. JSON.stringify escapes every newline inside a
 *   value, so a newline only ever ends a frame. Before authentication a connection may
 *   send HELLO_MAX_BYTES; after it, MAX_FRAME_BYTES.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';

export const PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const HELLO_MAX_BYTES = 4 * 1024;
/** A step must finish within this (client run timer and daemon watchdog both). */
export const REQUEST_TIMEOUT_MS = 120_000;
/** The first warm can include a first-run model download (client and daemon both). */
export const WARM_TIMEOUT_MS = 10 * 60_000;
/** Exit code of a daemon whose own fingerprint is not the one its spawner expected. */
export const EXIT_FINGERPRINT_DRIFT = 3;
/** Longest unix socket path every platform accepts (macOS: 104 bytes with the NUL). */
const UNIX_SOCKET_MAX = 103;

export type ModelOp = 'embed' | 'rerank' | 'expand' | 'warm' | 'stats' | 'cancel';
/** Interactive work (prime hook, recall, writes) runs ahead of background backfill. */
export type Lane = 'interactive' | 'background';

/** What the model modules captured at import; registered with ml-worker. */
export type InferenceConfig = Record<string, string | number>;

/** Client → daemon, first frame. */
export interface HelloFrame { t: 'hello'; protocol: number; fingerprint: string; nonce: string }
/** Daemon → client: its proof, and a refusal carries `error`. */
export interface ChallengeFrame { t: 'challenge'; nonce: string; proof: string; pid: number; version: string }
/** Client → daemon: the client's proof. */
export interface AuthFrame { t: 'auth'; proof: string }
export interface HelloResult { t: 'hello'; ok: boolean; error?: string }
export interface RequestFrame { id: number; op: ModelOp; lane?: Lane; args?: unknown }
/** `started` starts the client's run timer and `requeued` stops it; the final frame has `ok`. */
export interface ResponseFrame { id: number; ok?: boolean; started?: true; requeued?: true; result?: unknown; error?: string }

/** Env names the config is passed to a spawned daemon as. */
const CONFIG_ENV: Record<string, string> = {
  embedModel: 'AWM_EMBED_MODEL', embedDims: 'AWM_EMBED_DIMS', embedPooling: 'AWM_EMBED_POOLING',
  embedBatch: 'AWM_EMBED_BATCH', rerankModel: 'AWM_RERANKER_MODEL', rerankDtype: 'AWM_RERANKER_DTYPE',
  rerankBatch: 'AWM_RERANK_BATCH', rerankQueryTokens: 'AWM_RERANK_QUERY_TOKENS',
};

export function configEnv(config: InferenceConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, name] of Object.entries(CONFIG_ENV)) if (config[k] !== undefined) env[name] = String(config[k]);
  return env;
}

function safeUser(): string {
  try { return userInfo().username; } catch { return process.env.USERNAME ?? process.env.USER ?? ''; }
}

export function packageRoot(): string {
  // src/core/model-daemon.ts (dev) and dist/core/model-daemon.js (build): two levels up.
  return resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
}

export function defaultRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AWM_RUN_DIR || join(homedir(), '.awm', 'run');
}

/**
 * Size and mtime of the modules whose code decides what inference returns. A rebuild or
 * a dev edit without a version bump is a different daemon, not the old one serving old
 * code to new clients. The client and the daemon run from the same files, so they agree.
 */
export function codeStamp(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const files = ['embeddings', 'reranker', 'query-expander', 'model-daemon', 'model-daemon-server', 'ml-worker', 'rerank-window']
    .map(m => { try { const s = statSync(join(here, m + ext)); return `${m}:${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return `${m}:-`; } });
  // An `npm update` of the inference libraries changes results without an AWM version bump.
  const req = createRequire(import.meta.url);
  const libs = ['@huggingface/transformers', 'onnxruntime-node'].map(name => {
    // Not `${name}/package.json`: a package's "exports" may not expose it.
    try {
      for (let dir = dirname(req.resolve(name)); dir !== dirname(dir); dir = dirname(dir)) {
        try {
          const pkg = req(join(dir, 'package.json'));
          if (pkg.name === name) return `${name}@${pkg.version}`;
        } catch { /* keep walking up */ }
      }
    } catch { /* not installed */ }
    return `${name}@-`;
  });
  return [...files, ...libs].join(',');
}

/** 16 hex chars. Everything is a parameter so tests can compare configs in one process. */
export function modelDaemonFingerprint(
  config: InferenceConfig,
  o: { env?: NodeJS.ProcessEnv; version?: string; root?: string; code?: string } = {},
): string {
  const env = o.env ?? process.env;
  const parts = [
    `protocol=${PROTOCOL_VERSION}`, `version=${o.version ?? VERSION}`, `root=${o.root ?? packageRoot()}`,
    `code=${o.code ?? codeStamp()}`,
    `user=${safeUser()}`, `home=${homedir()}`, `run=${defaultRunDir(env)}`,
    // Read lazily by model-cache.ts, so the env at this point is the env it would use.
    `cache=${env.AWM_CACHE_DIR || env.HF_HOME || ''}`,
    ...Object.keys(config).sort().map(k => `${k}=${config[k]}`),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

export interface DaemonPaths {
  runDir: string;
  /** Pipe name on Windows, socket path elsewhere. */
  address: string;
  token: string;
  lock: string;
  log: string;
}

export function modelDaemonPaths(fingerprint: string, runDir: string = defaultRunDir()): DaemonPaths {
  const base = join(runDir, `models-${fingerprint}`);
  return {
    runDir,
    // Windows pipe names are one machine-wide namespace; the fingerprint includes the
    // user, home and run dir, so two users never share a name by accident.
    address: process.platform === 'win32' ? `\\\\.\\pipe\\awm-models-${fingerprint}` : `${base}.sock`,
    token: `${base}.token`,
    lock: `${base}.lock`,
    log: `${base}.log`,
  };
}

/** A unix socket path the OS will refuse, or null. */
export function addressProblem(paths: DaemonPaths): string | null {
  if (process.platform === 'win32') return null;
  return Buffer.byteLength(paths.address) > UNIX_SOCKET_MAX
    ? `socket path is ${Buffer.byteLength(paths.address)} bytes (max ${UNIX_SOCKET_MAX}); set AWM_RUN_DIR to a shorter directory you own (not a shared one like /tmp)`
    : null;
}

/**
 * A run dir another user can write to, or that this user does not own, is refused off
 * Windows: the token and the log are written there, and another user could plant a
 * symlink in their place. (On Windows the dir sits under the user's profile, whose ACL
 * already excludes other users.)
 */
export function runDirProblem(runDir: string): string | null {
  if (process.platform === 'win32') {
    // No uid to compare. The profile's ACL excludes other users; a dir outside it
    // (C:\Users\Public, a shared drive) may not.
    const rel = relative(homedir(), resolve(runDir));
    return rel && (rel.startsWith('..') || isAbsolute(rel)) ? `run dir ${runDir} is outside your user profile` : null;
  }
  if (typeof process.getuid !== 'function') return null;
  try {
    const s = statSync(runDir);
    if (s.uid !== process.getuid()) return `run dir ${runDir} is not owned by this user`;
    if (s.mode & 0o022) return `run dir ${runDir} is writable by other users`;
    return null;
  } catch (err) {
    return `run dir ${runDir}: ${(err as Error).message}`;
  }
}

export function proof(token: string, role: 'daemon' | 'client', clientNonce: string, daemonNonce: string, fingerprint: string): string {
  return createHmac('sha256', token).update(`${role}|${clientNonce}|${daemonNonce}|${fingerprint}`).digest('hex');
}

export function proofMatches(expected: string, got: unknown): boolean {
  if (typeof got !== 'string' || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

/**
 * Splits a byte stream into frames. push() returns false when the unterminated tail is
 * over `limit`. Chunks without a newline are kept as a list and only the new chunk is
 * searched, so a long frame arriving in many chunks costs linear time: appending to one
 * string and searching it again would copy the whole buffer on every chunk.
 */
export class FrameReader {
  private parts: string[] = [];
  private size = 0;
  constructor(private readonly onFrame: (frame: unknown) => void, public limit = MAX_FRAME_BYTES) {}

  push(chunk: string): boolean {
    let nl: number;
    while ((nl = chunk.indexOf('\n')) >= 0) {
      const line = this.parts.length ? this.parts.join('') + chunk.slice(0, nl) : chunk.slice(0, nl);
      this.parts = [];
      this.size = 0;
      chunk = chunk.slice(nl + 1);
      if (!line) continue;
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { return false; }
      this.onFrame(frame);
    }
    if (chunk) { this.parts.push(chunk); this.size += chunk.length; }
    return this.size <= this.limit;
  }
}

export function encodeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}

export function isModelDaemonEnabled(): boolean {
  return process.env.AWM_MODEL_DAEMON === '1';
}

/** Non-negative integer env var; anything else falls back (an explicit 0 is kept). */
export function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]?.trim() || NaN);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}
