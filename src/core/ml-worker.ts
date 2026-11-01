// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * ML inference dispatch pool.
 *
 * STATUS (AWM 0.8.x P1 REVISE, 2026-05-25): worker_threads were the original
 * plan, but @huggingface/transformers in Node only supports the `cpu`
 * (native ONNX) and `dml` (Windows GPU) backends. Neither is safe inside
 * a worker_thread — onnxruntime-node's native bindings store V8 handles
 * that get invalidated when crossing isolate boundaries, causing
 * `v8::HandleScope::CreateHandle()` crashes on first inference call.
 * The browser-only `wasm` backend is not loaded in Node builds of
 * transformers.js.
 *
 * The dispatch abstraction is preserved so a future child_process pool
 * or HTTP sidecar (see AWM_ML_SIDECAR_URL design in docs/awm-architecture-history.md)
 * can plug in. For now ALL inference runs in-process. The freeze fix from
 * P0 (sleep-only consolidation) already eliminates the multi-second
 * in-band blocks. Individual inference calls (~50ms each) on the main
 * thread are accepted as-is.
 *
 * Test / dev mode: AWM_ML_INPROCESS=1 is honored but is now the default.
 * The env var remains as a no-op for backwards compatibility.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  configEnv, envInt, isModelDaemonEnabled, modelDaemonFingerprint, REQUEST_TIMEOUT_MS as DAEMON_STEP_TIMEOUT_MS, WARM_TIMEOUT_MS,
  type InferenceConfig, type Lane,
} from './model-daemon.js';
import { DaemonRemoteError, DaemonUnavailableError, ModelDaemonClient } from './model-daemon-client.js';

type WorkerRole = 'embed' | 'rerank' | 'expand';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface ManagedWorker {
  role: WorkerRole;
  worker: Worker | null;
  ready: Promise<void>;
  setReady: () => void;
  setFailed: (err: Error) => void;
  pending: Map<number, PendingRequest>;
  buffered: Array<{ id: number; op: WorkerRole; args: any }>;
  isReady: boolean;
  restartTimestamps: number[]; // unix-ms of recent restarts (for backoff cap)
}

let inProcessMode = false;
let workers: Record<WorkerRole, ManagedWorker> | null = null;
let nextId = 1;

// In-process fallback handles (used in tests and as crash escape hatch).
let inProcessEmbed: ((args: any) => Promise<number[][]>) | null = null;
let inProcessRerank: ((args: any) => Promise<Array<{ index: number; score: number }>>) | null = null;
let inProcessExpand: ((args: any) => Promise<string>) | null = null;

const REQUEST_TIMEOUT_MS = 60_000;  // any single inference call > 60s is treated as failed
const MAX_RESTARTS_PER_MINUTE = 3;

function shouldUseInProcess(): boolean {
  // AWM 0.8.x P1 REVISE: worker_threads were removed because @huggingface/transformers
  // in Node is not worker_threads-safe (see file header). Always in-process for now.
  // The dispatch abstraction is preserved for a future child_process pool or
  // HTTP sidecar pivot.
  return true;
}

function createWorker(role: WorkerRole): ManagedWorker {
  const m: ManagedWorker = {
    role,
    worker: null,
    ready: Promise.resolve(),
    setReady: () => {},
    setFailed: () => {},
    pending: new Map(),
    buffered: [],
    isReady: false,
    restartTimestamps: [],
  };
  m.ready = new Promise<void>((resolve, reject) => {
    m.setReady = () => { m.isReady = true; resolve(); };
    m.setFailed = (err) => reject(err);
  });
  spawnWorker(m);
  return m;
}

function workerEntryPath(): string {
  // Resolve to the compiled .js. Two possible locations:
  //   1. Same directory as this file (when running from dist/core/)
  //   2. Sibling dist/core/ (when running from src/core/ via tsx)
  // Always prefer the compiled file. If neither exists, shouldUseInProcess()
  // will detect the missing entry and fall back to in-process mode.
  const here = dirname(fileURLToPath(import.meta.url));
  const samedir = join(here, 'ml-worker-entry.js');
  if (existsSync(samedir)) return samedir;
  // From src/core/ml-worker.ts, dist/core/ml-worker-entry.js is at ../../dist/core/
  const distSibling = join(here, '..', '..', 'dist', 'core', 'ml-worker-entry.js');
  if (existsSync(distSibling)) return distSibling;
  // Fallback to the same-dir path (will fail existsSync in shouldUseInProcess
  // and trigger in-process mode)
  return samedir;
}

function spawnWorker(m: ManagedWorker): void {
  const w = new Worker(workerEntryPath(), { workerData: { role: m.role } });
  m.worker = w;

  w.on('message', (msg: any) => {
    if (msg?.ready === true) {
      m.setReady();
      // Drain buffered messages
      for (const buf of m.buffered) w.postMessage(buf);
      m.buffered = [];
      return;
    }
    if (msg?.ready === false) {
      m.setFailed(new Error(`worker ${m.role} failed to load model: ${msg.error}`));
      return;
    }
    if (msg?.shutdown === 'done') return;
    if (typeof msg?.id !== 'number') return;

    const p = m.pending.get(msg.id);
    if (!p) return;
    m.pending.delete(msg.id);
    if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'worker error'));
  });

  w.on('error', (err) => {
    console.error(`[ml-worker:${m.role}] error:`, err);
  });

  w.on('exit', (code) => {
    if (code === 0) return; // graceful exit
    console.warn(`[ml-worker:${m.role}] exited with code ${code} — recovering`);
    // Reject all pending requests
    for (const [, p] of m.pending) {
      if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
      p.reject(new Error(`worker ${m.role} crashed (exit ${code})`));
    }
    m.pending.clear();

    // Restart-rate backoff
    const now = Date.now();
    m.restartTimestamps = m.restartTimestamps.filter(t => now - t < 60_000);
    m.restartTimestamps.push(now);

    if (m.restartTimestamps.length > MAX_RESTARTS_PER_MINUTE) {
      console.error(`[ml-worker:${m.role}] crashed ${m.restartTimestamps.length} times in 60s — falling back to in-process`);
      m.worker = null;
      m.isReady = false;
      inProcessMode = true;
      return;
    }

    // Reset ready promise + respawn
    m.isReady = false;
    m.ready = new Promise<void>((resolve, reject) => {
      m.setReady = () => { m.isReady = true; resolve(); };
      m.setFailed = (err) => reject(err);
    });
    spawnWorker(m);
  });
}

/** Initialize the pool. Idempotent — safe to call multiple times. */
export function initMLPool(): void {
  if (shouldUseInProcess()) {
    inProcessMode = true;
    return;
  }
  if (workers) return;
  workers = {
    embed: createWorker('embed'),
    rerank: createWorker('rerank'),
    expand: createWorker('expand'),
  };
}

/** Register in-process fallback handlers. Called once by the consumer modules. */
export function registerInProcessHandlers(handlers: {
  embed?: typeof inProcessEmbed;
  rerank?: typeof inProcessRerank;
  expand?: typeof inProcessExpand;
}): void {
  if (handlers.embed) inProcessEmbed = handlers.embed;
  if (handlers.rerank) inProcessRerank = handlers.rerank;
  if (handlers.expand) inProcessExpand = handlers.expand;
}

/** True if the pool is operating in in-process mode (no workers). */
export function isInProcessMode(): boolean {
  return inProcessMode;
}

async function dispatchToWorker<T>(role: WorkerRole, args: any): Promise<T> {
  if (!workers) initMLPool();
  if (inProcessMode) {
    return dispatchInProcess<T>(role, args);
  }

  const m = workers![role];
  await m.ready;
  if (inProcessMode) {
    // Fallback flipped while we awaited ready
    return dispatchInProcess<T>(role, args);
  }

  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const req: PendingRequest = {
      resolve,
      reject,
      timeoutHandle: setTimeout(() => {
        m.pending.delete(id);
        reject(new Error(`ml-worker:${role} request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS),
    };
    m.pending.set(id, req);
    const msg = { id, op: role, args };
    if (m.isReady && m.worker) {
      m.worker.postMessage(msg);
    } else {
      m.buffered.push(msg);
    }
  });
}

async function dispatchInProcess<T>(role: WorkerRole, args: any): Promise<T> {
  switch (role) {
    case 'embed':
      if (!inProcessEmbed) throw new Error('in-process embed handler not registered');
      return inProcessEmbed(args) as Promise<T>;
    case 'rerank':
      if (!inProcessRerank) throw new Error('in-process rerank handler not registered');
      return inProcessRerank(args) as Promise<T>;
    case 'expand':
      if (!inProcessExpand) throw new Error('in-process expand handler not registered');
      return inProcessExpand(args) as Promise<T>;
  }
}

// --- Shared model daemon (AWM_MODEL_DAEMON=1, see model-daemon.ts) ---

/**
 * The config each model module captured at import, registered by the module itself.
 * The daemon's fingerprint is built from these values, not from the env strings, and a
 * spawned daemon is given them as env: a .env file applied after the modules loaded
 * would otherwise make the daemon run a different model than the fallback here.
 */
const inferenceConfig: InferenceConfig = {};
export function registerInferenceConfig(part: InferenceConfig): void {
  Object.assign(inferenceConfig, part);
}
export function registeredInferenceConfig(): InferenceConfig {
  return { ...inferenceConfig };
}

/**
 * When the daemon fails, inference runs in-process and the daemon is probed again in
 * the background, after 60 s, then 2, 4, 8 and at most 15 min. Requests never wait on a
 * probe. In-process is the pre-daemon behaviour, bounded by the same shape caps, so a
 * daemon outage costs memory, never recall. A BUSY daemon is not a failure: only an
 * unreachable one, one that will not start, or one that stops making progress.
 */
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;

let daemon: Promise<ModelDaemonClient> | null = null;
let fallbackActive = false;
let retryMs = RETRY_FIRST_MS;
let retryAt = 0;
let probing = false;
let connectedPid: number | null = null;
let clientFingerprint: string | null = null;
const daemonState = {
  requests: 0,
  queueTimeouts: 0,
  fallbacks: 0,
  lastFallbackReason: null as string | null,
  lastFallbackAt: null as string | null,
};

function daemonClient(): Promise<ModelDaemonClient> {
  return (daemon ??= (async () => {
    // All three modules register their config on import. Load any not loaded yet, so
    // the fingerprint is the daemon's (which loads all three).
    await Promise.all([import('./embeddings.js'), import('./reranker.js'), import('./query-expander.js')]);
    const config = registeredInferenceConfig();
    clientFingerprint = modelDaemonFingerprint(config);
    return new ModelDaemonClient({ fingerprint: clientFingerprint, spawnEnv: configEnv(config) });
  })());
}

function reasonOf(err: unknown): string {
  return err instanceof DaemonUnavailableError ? err.reason : 'error';
}

function noteFallback(reason: string, err: unknown): void {
  daemonState.fallbacks++;
  daemonState.lastFallbackReason = reason;
  daemonState.lastFallbackAt = new Date().toISOString();
  retryAt = Date.now() + retryMs;
  console.error(`[awm] model daemon unavailable (${reason}): ${(err as Error)?.message ?? err} — running inference in this process; next try in ${Math.round(retryMs / 1000)}s`);
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  fallbackActive = true;
}

function noteConnected(client: ModelDaemonClient): void {
  connectedPid = client.daemonPid;
  if (fallbackActive) console.error(`[awm] model daemon back (pid ${client.daemonPid}); inference leaves this process`);
  fallbackActive = false;
  retryMs = RETRY_FIRST_MS;
}

function probeInBackground(): void {
  if (probing || Date.now() < retryAt) return;
  probing = true;
  void daemonClient()
    .then(async c => {
      const st = await c.request<{ current: { op: string; runningMs: number } | null }>('stats');
      // Answering stats is not health: a daemon stuck on a step answers it too.
      const limit = st.current?.op === 'warm' ? WARM_TIMEOUT_MS : envInt('AWM_MODEL_DAEMON_TIMEOUT_MS', DAEMON_STEP_TIMEOUT_MS);
      if (st.current && st.current.runningMs > limit) {
        throw new DaemonUnavailableError(`daemon has been running ${st.current.op} for ${st.current.runningMs} ms`, 'wedged');
      }
      noteConnected(c);
    })
    .catch(err => noteFallback(reasonOf(err), err))
    .finally(() => { probing = false; });
}

async function dispatch<T>(role: WorkerRole, args: any, lane: Lane = 'interactive'): Promise<T> {
  if (!isModelDaemonEnabled()) return dispatchToWorker<T>(role, args);
  if (fallbackActive) {
    probeInBackground();
    return dispatchToWorker<T>(role, args);
  }
  // One retry on a dropped connection: the daemon may have exited on its idle lease
  // just as this request went out, and the retry starts a new one.
  for (let attempt = 0; ; attempt++) {
    try {
      const client = await daemonClient();
      const result = await client.request<T>(role, args, lane);
      daemonState.requests++;
      connectedPid = client.daemonPid;
      return result;
    } catch (err) {
      if (err instanceof DaemonRemoteError) throw err;
      if (attempt === 0 && reasonOf(err) === 'disconnected') continue;
      // Queued too long is busy, not down: this one request runs here, and the next one
      // goes to the daemon again.
      if (reasonOf(err) === 'queue-timeout') { daemonState.queueTimeouts++; return dispatchToWorker<T>(role, args); }
      noteFallback(reasonOf(err), err);
      return dispatchToWorker<T>(role, args);
    }
  }
}

/**
 * Eager warm through the daemon: it loads its models; this process loads none. On
 * failure this process enters the fallback window (so the first recall does not pay
 * the start timeout again) but loads nothing now: the first real request does that, if
 * the daemon is still down by then.
 */
export async function warmModelDaemon(): Promise<void> {
  try {
    const client = await daemonClient();
    await client.request('warm');
    noteConnected(client);
  } catch (err) {
    if (err instanceof DaemonRemoteError) {
      console.error(`[awm] model daemon could not load its models: ${err.message}`);
      return;
    }
    noteFallback(reasonOf(err), err);
  }
}

export function modelDaemonStatus(): {
  enabled: boolean;
  mode: 'off' | 'daemon' | 'in-process-fallback' | 'not-connected';
  fingerprint: string | null;
  daemonPid: number | null;
  requests: number;
  queueTimeouts: number;
  fallbacks: number;
  lastFallbackReason: string | null;
  lastFallbackAt: string | null;
} {
  const enabled = isModelDaemonEnabled();
  const mode = !enabled ? 'off' : fallbackActive ? 'in-process-fallback' : connectedPid ? 'daemon' : 'not-connected';
  return {
    enabled, mode,
    fingerprint: enabled ? clientFingerprint : null,
    daemonPid: enabled ? connectedPid : null,
    ...daemonState,
  };
}

/** Test-only: forget the client, the fallback window and the counters. */
export async function __resetModelDaemonClient(): Promise<void> {
  const c = daemon;
  daemon = null;
  (await c?.catch(() => null))?.close();
  fallbackActive = false;
  retryMs = RETRY_FIRST_MS;
  retryAt = 0;
  probing = false;
  connectedPid = null;
  clientFingerprint = null;
  Object.assign(daemonState, { requests: 0, queueTimeouts: 0, fallbacks: 0, lastFallbackReason: null, lastFallbackAt: null });
}

// --- Public API used by the consumer modules ---

export async function dispatchEmbed(args: { texts: string[]; pooling: 'cls' | 'mean'; dimensions: number }, lane: Lane = 'interactive'): Promise<number[][]> {
  return dispatch<number[][]>('embed', args, lane);
}

export async function dispatchRerank(args: { query: string; passages: string[]; natural?: boolean }): Promise<Array<{ index: number; score: number }>> {
  return dispatch<Array<{ index: number; score: number }>>('rerank', args);
}

export async function dispatchExpand(args: { prompt: string; maxNewTokens: number; noRepeatNgramSize: number }): Promise<string> {
  return dispatch<string>('expand', args);
}

/** Graceful shutdown. Waits up to 2s for queue drain, then terminates. */
export async function shutdownMLPool(): Promise<void> {
  if (!workers) return;
  const promises: Promise<void>[] = [];
  for (const role of ['embed', 'rerank', 'expand'] as WorkerRole[]) {
    const m = workers[role];
    if (!m.worker) continue;
    const w = m.worker;
    promises.push(new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        w.terminate().finally(() => resolve());
      }, 2000);
      w.once('exit', () => { clearTimeout(timeout); resolve(); });
      w.postMessage({ shutdown: true });
    }));
  }
  await Promise.all(promises);
  workers = null;
}
