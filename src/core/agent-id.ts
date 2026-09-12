// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Fallback agent identity when AWM_AGENT_ID / WORKER_NAME are unset.
 *
 * Derived from the project directory so a plain `claude` launch still binds to
 * the right store: `Personal-Projects` → 'personal'; everything else → 'work'.
 * The AWM package itself lives under Personal-Projects, so an AgentSynapse
 * checkout is guarded first — a stray server cwd must not mis-bind.
 *
 * ONE definition, three consumers that must agree:
 *   - src/mcp.ts — what the server actually binds to
 *   - src/adapters/common.ts — what `awm setup` reports and seeds
 *   - the shipped hook scripts (src/adapters/hook-scripts.ts) carry a
 *     line-for-line JavaScript mirror, because a hook cannot import from dist.
 *     tests/adapters/hook-scripts.test.ts asserts the mirror agrees with this.
 */
export function deriveAgentFromDir(dir: string): string {
  const d = String(dir ?? '').replace(/\\/g, '/');
  if (/\/AgentSynapse\//i.test(d)) return 'work';
  return /\/Personal-Projects(\/|$)/i.test(d) ? 'personal' : 'work';
}

/** The agent id a server process would resolve to for `dir`, honouring the env first. */
export function resolveAgentId(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.AWM_AGENT_ID ?? env.WORKER_NAME ?? deriveAgentFromDir(dir);
}
