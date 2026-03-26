// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Promise-based write mutex for SQLite coordination routes.
 *
 * SQLite only allows one writer at a time. Under burst from 5+ concurrent
 * workers, multiple async handlers can race for the write lock, causing
 * SQLITE_BUSY errors. This mutex serializes write operations (POST, PATCH,
 * PUT, DELETE) through a single-concurrency queue while keeping reads (GET)
 * unguarded for full parallelism.
 *
 * Usage: Register as a Fastify preHandler hook in the coordination module.
 */

/**
 * Creates a simple single-concurrency mutex.
 * acquire() returns a release function — call it when done.
 */
export function createWriteMutex(): {
  acquire(): Promise<() => void>;
  pending: () => number;
} {
  let queue: Array<(release: () => void) => void> = [];
  let locked = false;

  function release(): void {
    const next = queue.shift();
    if (next) {
      // Hand lock directly to next waiter (no unlock/relock gap)
      next(release);
    } else {
      locked = false;
    }
  }

  function acquire(): Promise<() => void> {
    if (!locked) {
      locked = true;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve) => {
      queue.push(resolve);
    });
  }

  return {
    acquire,
    pending: () => queue.length,
  };
}

/** HTTP methods that perform writes and need serialization. */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Routes that are safe to skip the mutex (read-only despite POST method). */
const READ_ONLY_ROUTES = new Set(['/next']);

/**
 * Check if a request needs write serialization.
 * GET/HEAD/OPTIONS are always reads. POST /next is a read (checkin is idempotent upsert
 * but low-contention). All other write methods go through the mutex.
 */
export function needsWriteLock(method: string, url: string): boolean {
  if (!WRITE_METHODS.has(method)) return false;
  // Strip query string for route matching
  const path = url.split('?')[0];
  if (READ_ONLY_ROUTES.has(path)) return false;
  return true;
}
