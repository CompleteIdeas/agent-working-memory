// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Simple file logger for AWM activity.
 *
 * Appends one line per event to data/awm.log (next to memory.db).
 * Format: ISO timestamp | agent | event | detail
 *
 * Designed for dev pilot observability — know at a glance what's happening.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let logPath: string | null = null;

export function initLogger(dbPath: string): void {
  const dir = dirname(resolve(dbPath));
  mkdirSync(dir, { recursive: true });
  logPath = resolve(dir, 'awm.log');
}

export function log(agentId: string, event: string, detail: string): void {
  if (!logPath) return;
  const ts = new Date().toISOString();
  const line = `${ts} | ${agentId} | ${event} | ${detail}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    // Logging should never crash the server
  }
}

export function getLogPath(): string | null {
  return logPath;
}
