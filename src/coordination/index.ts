// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Coordination module entry point.
 * OFF by default, ON via AWM_COORDINATION=true.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { EngramStore } from '../storage/sqlite.js';
import { ZodError } from 'zod';
import { initCoordinationTables } from './schema.js';
import { registerCoordinationRoutes } from './routes.js';
import { cleanSlate, pruneOldHeartbeats, purgeDeadAgents } from './stale.js';

export type * from './types.js';

/** Active cleanup intervals — cleared on shutdown. */
const cleanupIntervals: NodeJS.Timeout[] = [];

/** Check if coordination is enabled via environment variable. */
export function isCoordinationEnabled(): boolean {
  const val = process.env.AWM_COORDINATION;
  return val === 'true' || val === '1';
}

/** Initialize the coordination module: create tables, clean slate, mount routes, error handler. */
export function initCoordination(app: FastifyInstance, db: Database.Database, store?: EngramStore): void {
  // Create coordination tables (idempotent)
  initCoordinationTables(db);

  // Clean slate: mark stale agents as dead from previous sessions
  cleanSlate(db);

  // CORS — allow localhost origins only (coordination is local-only)
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin ?? '';
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  // Body size limit — 50KB max for coordination requests
  app.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.bodyLimit) {
      routeOptions.bodyLimit = 50_000;
    }
  });

  // Mount all coordination HTTP routes
  registerCoordinationRoutes(app, db, store);

  // ZodError handler — coordination routes use .parse() which throws on invalid params
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(422).send({
        data: null,
        error: { code: 'VALIDATION_ERROR', message: error.issues[0].message, issues: error.issues },
      });
    }
    reply.status(error.statusCode ?? 500).send({
      data: null,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  });

  // Periodic cleanup: prune heartbeat events every 30 min, purge dead agents every hour
  cleanupIntervals.push(
    setInterval(() => {
      try { pruneOldHeartbeats(db); } catch { /* db may be closed */ }
    }, 30 * 60 * 1000),
    setInterval(() => {
      try { purgeDeadAgents(db, 24); } catch { /* db may be closed */ }
    }, 60 * 60 * 1000),
  );

  console.log('  Coordination module enabled');
}

/** Stop periodic cleanup intervals. Call on server shutdown. */
export function stopCoordinationCleanup(): void {
  for (const id of cleanupIntervals) clearInterval(id);
  cleanupIntervals.length = 0;
}
