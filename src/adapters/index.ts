// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter registry — lazy-loads adapters by ID.
 */

import type { CLIAdapter } from './types.js';

const adapters = new Map<string, () => Promise<CLIAdapter>>();

adapters.set('claude-code', () => import('./claude-code.js').then(m => m.default));
adapters.set('codex', () => import('./codex.js').then(m => m.default));
adapters.set('cursor', () => import('./cursor.js').then(m => m.default));
adapters.set('http', () => import('./http.js').then(m => m.default));

// Aliases
adapters.set('claude', () => import('./claude-code.js').then(m => m.default));

export function listAdapters(): string[] {
  return ['claude-code', 'codex', 'cursor', 'http'];
}

export async function getAdapter(id: string): Promise<CLIAdapter> {
  const factory = adapters.get(id);
  if (!factory) {
    const valid = listAdapters().join(', ');
    throw new Error(`Unknown target: "${id}". Valid targets: ${valid}`);
  }
  return factory();
}
