// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * AWM Plugin contract.
 *
 * Plugins extend coordination with custom behavior by subscribing to
 * events, adding routes, or querying the DB. They are loaded at startup
 * via AWM_PLUGINS env var (comma-separated module paths).
 *
 * Example plugin:
 *   import type { AWMPlugin } from 'agent-working-memory';
 *   export default {
 *     name: 'my-plugin',
 *     register(ctx) {
 *       ctx.events.on('assignment.completed', (evt) => {
 *         console.log(`Task done: ${evt.assignmentId}`);
 *       });
 *     },
 *   } satisfies AWMPlugin;
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CoordinationEventBus } from './events.js';

/** Context passed to plugin register(). */
export interface AWMPluginContext {
  /** Typed event bus — subscribe to coordination events. */
  events: CoordinationEventBus;
  /** Raw better-sqlite3 database handle (coordination tables). */
  db: Database.Database;
  /** Fastify instance — add custom routes if needed. */
  fastify: FastifyInstance;
}

/** Plugin contract. Every AWM plugin must export this shape. */
export interface AWMPlugin {
  /** Unique plugin name (for logging and dedup). */
  name: string;
  /** Called once at startup with the plugin context. */
  register(ctx: AWMPluginContext): void | Promise<void>;
  /** Optional cleanup on shutdown. */
  teardown?(): void | Promise<void>;
}
