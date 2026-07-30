// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance identity (D3, 2026-07-30).
 *
 * Answers "which AWM am I talking to?" — the recurring confusion class where
 * sessions mix up the hosted multi-agent connector with the local instance,
 * or run blind to sibling agent spaces in the same store (an evaluation once
 * analyzed this project without seeing the `personal` space that held its
 * design decisions).
 *
 * Exposed as the `memory_whoami` MCP tool and the `GET /whoami` HTTP route.
 * Read-only; additive module.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { getConfiguredBackend, getConfiguredPath } from '../storage/factory.js';

export interface WhoamiInfo {
  agentId: string;
  workspace: string | null;
  surface: 'mcp' | 'http';
  mode: 'standalone' | 'hive';
  backend: string;
  storePath: string;
  version: string;
  codePath: string;
  pid: number;
  ports: { http: number | null; hookSidecar: number | null };
  siblingAgents: string[];
}

/** Store subset whoami needs — every backend implements listAgentIds. */
export interface WhoamiStore {
  listAgentIds(): string[] | Promise<string[]>;
}

function packageRoot(): string {
  // src/core/whoami.ts (dev) and dist/core/whoami.js (build) both sit two
  // levels below the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(join(here, '..', '..'));
}

export async function buildWhoami(
  store: WhoamiStore,
  agentId: string,
  surface: 'mcp' | 'http',
): Promise<WhoamiInfo> {
  const coordination = process.env.AWM_COORDINATION === 'true' || process.env.AWM_COORDINATION === '1';
  let siblings: string[] = [];
  try {
    const all = await store.listAgentIds();
    siblings = all.filter(a => a !== agentId).sort();
  } catch { /* identity must never fail on a listing error */ }
  const httpPort = Number(process.env.AWM_PORT ?? '');
  const hookPort = Number(process.env.AWM_HOOK_PORT ?? '');
  return {
    agentId,
    workspace: process.env.AWM_WORKSPACE ?? null,
    surface,
    mode: coordination ? 'hive' : 'standalone',
    backend: getConfiguredBackend(),
    storePath: getConfiguredPath(),
    version: VERSION,
    codePath: packageRoot(),
    pid: process.pid,
    ports: {
      http: Number.isFinite(httpPort) && httpPort > 0 ? httpPort : null,
      hookSidecar: Number.isFinite(hookPort) && hookPort > 0 ? hookPort : null,
    },
    siblingAgents: siblings,
  };
}

/** Human-readable rendering for the MCP tool response. */
export function formatWhoami(w: WhoamiInfo): string {
  return [
    `Agent: ${w.agentId}${w.workspace ? ` (workspace: ${w.workspace})` : ''}`,
    `Mode: ${w.mode} · Surface: ${w.surface} · Version: ${w.version}`,
    `Backend: ${w.backend}`,
    `Store: ${w.storePath}`,
    `Code: ${w.codePath} (pid ${w.pid})`,
    `Ports: http=${w.ports.http ?? 'off'} hookSidecar=${w.ports.hookSidecar ?? 'off'}`,
    w.siblingAgents.length
      ? `Sibling agent spaces in this store: ${w.siblingAgents.join(', ')} — recall is scoped to '${w.agentId}'; other spaces need workspace recall, \`awm export --agent <id>\`, or a session configured for that agent.`
      : 'Sibling agent spaces in this store: none',
  ].join('\n');
}
