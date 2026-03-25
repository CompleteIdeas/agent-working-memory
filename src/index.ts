// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import Fastify from 'fastify';

// Load .env file if present (no external dependency)
try {
  const envPath = resolve(process.cwd(), '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val; // Don't override existing env
  }
} catch { /* No .env file — that's fine */ }
import { EngramStore } from './storage/sqlite.js';
import { ActivationEngine } from './engine/activation.js';
import { ConnectionEngine } from './engine/connections.js';
import { StagingBuffer } from './engine/staging.js';
import { EvictionEngine } from './engine/eviction.js';
import { RetractionEngine } from './engine/retraction.js';
import { EvalEngine } from './engine/eval.js';
import { ConsolidationEngine } from './engine/consolidation.js';
import { ConsolidationScheduler } from './engine/consolidation-scheduler.js';
import { registerRoutes } from './api/routes.js';
import { DEFAULT_AGENT_CONFIG } from './types/agent.js';
import { getEmbedder } from './core/embeddings.js';
import { getReranker } from './core/reranker.js';
import { getExpander } from './core/query-expander.js';
import { initLogger } from './core/logger.js';

const PORT = parseInt(process.env.AWM_PORT ?? '8400', 10);
const DB_PATH = process.env.AWM_DB_PATH ?? 'memory.db';
const API_KEY = process.env.AWM_API_KEY ?? null;

async function main() {
  // Auto-backup: copy DB to backups/ on startup (cheap insurance)
  if (existsSync(DB_PATH)) {
    const dbDir = dirname(resolve(DB_PATH));
    const backupDir = resolve(dbDir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = resolve(backupDir, `${basename(DB_PATH, '.db')}-${ts}.db`);
    try {
      copyFileSync(resolve(DB_PATH), backupPath);
      console.log(`Backup: ${backupPath}`);
    } catch (err) {
      console.log(`Backup skipped: ${(err as Error).message}`);
    }
  }

  // Logger — write activity to awm.log alongside the DB
  initLogger(DB_PATH);

  // Storage
  const store = new EngramStore(DB_PATH);

  // Integrity check
  const integrity = store.integrityCheck();
  if (!integrity.ok) {
    console.error(`DB integrity check FAILED: ${integrity.result}`);
    // Close corrupt DB, restore from backup, and exit for process manager to restart
    store.close();
    const dbDir = dirname(resolve(DB_PATH));
    const backupDir = resolve(dbDir, 'backups');
    if (existsSync(backupDir)) {
      const backups = readdirSync(backupDir)
        .filter(f => f.endsWith('.db'))
        .sort()
        .reverse();
      if (backups.length > 0) {
        const restorePath = resolve(backupDir, backups[0]);
        console.error(`Attempting restore from: ${restorePath}`);
        try {
          copyFileSync(restorePath, resolve(DB_PATH));
          console.error('Restore complete — exiting for restart with restored DB');
          process.exit(1);
        } catch (restoreErr) {
          console.error(`Restore failed: ${(restoreErr as Error).message}`);
        }
      }
    }
    console.error('No backup available — continuing with potentially corrupt DB');
  } else {
    console.log('  DB integrity check: ok');
  }

  // Engines
  const activationEngine = new ActivationEngine(store);
  const connectionEngine = new ConnectionEngine(store, activationEngine);
  const stagingBuffer = new StagingBuffer(store, activationEngine);
  const evictionEngine = new EvictionEngine(store);
  const retractionEngine = new RetractionEngine(store);
  const evalEngine = new EvalEngine(store);
  const consolidationEngine = new ConsolidationEngine(store);
  const consolidationScheduler = new ConsolidationScheduler(store, consolidationEngine);

  // API — disable Fastify's default request logging (too noisy for hive polling)
  const app = Fastify({ logger: false });

  // Bearer token auth — only enforced when AWM_API_KEY is explicitly set and non-empty
  if (API_KEY && API_KEY !== 'NONE' && API_KEY.length > 1) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/health') return; // Health check is always public
      const bearer = req.headers.authorization;
      const xApiKey = req.headers['x-api-key'] as string | undefined;
      if (bearer === `Bearer ${API_KEY}` || xApiKey === API_KEY) return;
      reply.code(401).send({ error: 'Unauthorized' });
    });
    console.log('API key auth enabled (AWM_API_KEY set)');
  }

  registerRoutes(app, {
    store, activationEngine, connectionEngine,
    evictionEngine, retractionEngine, evalEngine,
    consolidationEngine, consolidationScheduler,
  });

  // Coordination module (opt-in via AWM_COORDINATION=true)
  let heartbeatPruneTimer: ReturnType<typeof setInterval> | null = null;
  const { isCoordinationEnabled, initCoordination } = await import('./coordination/index.js');
  if (isCoordinationEnabled()) {
    initCoordination(app, store.getDb());
    // Prune stale heartbeat events every 30s (keeps assignment/command events permanently)
    // Purge dead agents older than 24h every 30s to prevent table bloat
    const { pruneOldHeartbeats, purgeDeadAgents } = await import('./coordination/stale.js');
    heartbeatPruneTimer = setInterval(() => {
      const pruned = pruneOldHeartbeats(store.getDb());
      if (pruned > 0) console.log(`[coordination] pruned ${pruned} old heartbeat event(s)`);
      const purged = purgeDeadAgents(store.getDb());
      if (purged > 0) console.log(`[coordination] purged ${purged} dead agent(s) older than 24h`);
    }, 30_000);
  } else {
    console.log('  Coordination module disabled (set AWM_COORDINATION=true to enable)');
  }

  // Background tasks
  stagingBuffer.start(DEFAULT_AGENT_CONFIG.stagingTtlMs);
  consolidationScheduler.start();

  // Periodic hot backup every 10 minutes (keep last 6 = 1hr coverage)
  const dbDir = dirname(resolve(DB_PATH));
  const backupDir = resolve(dbDir, 'backups');
  mkdirSync(backupDir, { recursive: true });

  // Cleanup old backups on startup (older than 2 hours)
  try {
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();
    for (const f of readdirSync(backupDir).filter(f => f.endsWith('.db'))) {
      const match = f.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      if (match) {
        const fileDate = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
        if (now - fileDate.getTime() > TWO_HOURS_MS) {
          unlinkSync(resolve(backupDir, f));
        }
      }
    }
  } catch { /* cleanup is non-fatal */ }

  const backupTimer = setInterval(() => {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = resolve(backupDir, `${basename(DB_PATH, '.db')}-${ts}.db`);
      store.backup(backupPath);
      // Prune: keep only last 6 backups
      const backups = readdirSync(backupDir).filter(f => f.endsWith('.db')).sort();
      while (backups.length > 6) {
        const old = backups.shift()!;
        try { unlinkSync(resolve(backupDir, old)); } catch { /* non-fatal */ }
      }
    } catch (err) {
      console.warn(`[backup] failed: ${(err as Error).message}`);
    }
  }, 10 * 60_000); // 10 minutes

  // Pre-load ML models (downloads on first run: embeddings ~22MB, reranker ~22MB, expander ~80MB)
  getEmbedder().catch(err => console.warn('Embedding model unavailable:', err.message));
  getReranker().catch(err => console.warn('Reranker model unavailable:', err.message));
  getExpander().catch(err => console.warn('Query expander model unavailable:', err.message));

  // Start server
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`AgentWorkingMemory v0.6.0 listening on port ${PORT}`);

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(backupTimer);
    if (heartbeatPruneTimer) clearInterval(heartbeatPruneTimer);
    consolidationScheduler.stop();
    stagingBuffer.stop();
    try { store.walCheckpoint(); } catch { /* non-fatal */ }
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
