// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const PORT = parseInt(process.env.AWM_PORT ?? '8400', 10);
const DB_PATH = process.env.AWM_DB_PATH ?? 'memory.db';
const API_KEY = process.env.AWM_API_KEY ?? null;

async function main() {
  // Storage
  const store = new EngramStore(DB_PATH);

  // Engines
  const activationEngine = new ActivationEngine(store);
  const connectionEngine = new ConnectionEngine(store, activationEngine);
  const stagingBuffer = new StagingBuffer(store, activationEngine);
  const evictionEngine = new EvictionEngine(store);
  const retractionEngine = new RetractionEngine(store);
  const evalEngine = new EvalEngine(store);
  const consolidationEngine = new ConsolidationEngine(store);
  const consolidationScheduler = new ConsolidationScheduler(store, consolidationEngine);

  // API
  const app = Fastify({ logger: true });

  // Bearer token auth — only enforced when AWM_API_KEY is set
  if (API_KEY) {
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

  // Background tasks
  stagingBuffer.start(DEFAULT_AGENT_CONFIG.stagingTtlMs);
  consolidationScheduler.start();

  // Pre-load ML models (downloads on first run: embeddings ~22MB, reranker ~22MB, expander ~80MB)
  getEmbedder().catch(err => console.warn('Embedding model unavailable:', err.message));
  getReranker().catch(err => console.warn('Reranker model unavailable:', err.message));
  getExpander().catch(err => console.warn('Query expander model unavailable:', err.message));

  // Start server
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`AgentWorkingMemory v0.3.0 listening on port ${PORT}`);

  // Graceful shutdown
  const shutdown = () => {
    consolidationScheduler.stop();
    stagingBuffer.stop();
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
