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
import { cleanSlate } from './stale.js';

export type * from './types.js';

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

  console.log('  Coordination module enabled');
}
