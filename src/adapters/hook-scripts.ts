// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code hook scripts shipped by `awm setup` (0.14.6).
 *
 * WHY SCRIPTS AND NOT INLINE CURL
 * -------------------------------
 * Until 0.14.5 `awm setup` wrote PreCompact/SessionEnd hooks as one-line curl
 * commands with the sidecar port and the bearer secret baked into
 * settings.json. Three things broke, each silently:
 *
 *   1. The port was fixed (8401, falling back to 8402). Since 0.14.2 every MCP
 *      process binds the first free port in 8401..8410, so a session that lands
 *      on 8403 had no hooks at all — and with two pools open, the fallback
 *      posted a work session's checkpoint into the personal pool's process.
 *   2. The secret was a literal in settings.json. When the secret file was
 *      regenerated the hooks got 401s, and `curl -sf` hid them. Observed twice.
 *   3. There was no prime hook. The only mechanism that injects memory without
 *      the model choosing to call recall was a documentation page.
 *
 * These scripts resolve everything at run time: which agent this session is
 * (from the MCP config that governs its cwd), which sidecar belongs to that
 * agent (by probing the port range and reading /health), and the secret (from
 * the same config, or the secret file next to the database). Nothing here is
 * baked in at setup time except a fallback record in ~/.claude/hooks/awm-hooks.json.
 *
 * Every script fails OPEN: any problem prints nothing and exits 0. A hook that
 * blocks a prompt or a compaction is worse than no hook.
 *
 * The JavaScript bodies deliberately avoid template literals so they can live
 * inside these TypeScript template strings without escaping.
 */

/** Bumped when any shipped script changes; written into awm-hooks.json and the
 *  script headers so `awm doctor` can tell a stale install from a current one. */
export const AWM_HOOKS_VERSION = '0.14.6';

/** File whose presence turns the prime hook off without uninstalling it. */
export const PRIME_DISABLE_FILE = 'awm-prime.disabled';

const HEADER = (name: string, purpose: string) => `#!/usr/bin/env node
// ${name} — installed by \`awm setup\` (hooks v${AWM_HOOKS_VERSION}). ${purpose}
// Re-running \`awm setup\` rewrites this file; put local changes elsewhere.
// Fails open: on any problem it prints nothing and exits 0.
`;

// ─── awm-find-sidecar.cjs ────────────────────────────────────────────────────

export const FIND_SIDECAR_SCRIPT = HEADER(
  'awm-find-sidecar.cjs',
  'Shared resolver: which AWM sidecar belongs to THIS session.',
) + `
// Since AWM 0.14.2 each MCP process binds the first free port in
// [AWM_HOOK_PORT, +AWM_HOOK_PORT_RANGE), so "the sidecar is on 8401" is not a
// safe assumption: with N sessions open there are N sidecars and the one on
// 8401 may serve a different agent pool. This module (1) works out which agent
// a session started in \`cwd\` belongs to, from the MCP config that governs that
// directory, (2) probes the whole range in parallel (local, ~10 ms), and
// (3) returns the responder whose agentId matches — newest version first, then
// lowest port. No match → null, and callers fail open.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_NAME = 'agent-working-memory';
const PROBE_TIMEOUT_MS = 400;

function norm(p) { return String(p || '').replace(/\\\\/g, '/').replace(/\\/+$/, '').toLowerCase(); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; } }

// MIRROR of deriveAgentFromDir() in src/core/agent-id.ts — the server's own
// fallback when AWM_AGENT_ID is unset. Kept in sync by tests/adapters/hook-scripts.test.ts.
function deriveAgentFromDir(dir) {
  const d = String(dir || '').replace(/\\\\/g, '/');
  if (/\\/AgentSynapse\\//i.test(d)) return 'work';
  return /\\/Personal-Projects(\\/|$)/i.test(d) ? 'personal' : 'work';
}

// The AWM entry inside one MCP config file, if any. ~/.claude.json keeps
// project-scoped servers under projects[<path>].mcpServers.
function awmEntry(json, cwd) {
  if (!json) return null;
  if (json.mcpServers && json.mcpServers[SERVER_NAME]) return json.mcpServers[SERVER_NAME];
  if (json.projects && cwd) {
    for (const k of Object.keys(json.projects)) {
      if (norm(k) !== norm(cwd)) continue;
      const s = json.projects[k] && json.projects[k].mcpServers;
      if (s && s[SERVER_NAME]) return s[SERVER_NAME];
    }
  }
  return null;
}

/**
 * Resolve the configuration that governs a session started in \`cwd\`:
 * { agentId, secret, port, range, dbPath, source }.
 *
 * Order: the nearest .mcp.json / .claude/mcp.json walking up from cwd, then
 * ~/.mcp.json, then ~/.claude.json, then the record \`awm setup\` left in
 * ~/.claude/hooks/awm-hooks.json. Process env always wins for a given key.
 */
function resolveConfig(cwd) {
  cwd = cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const home = os.homedir();
  const candidates = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < 16; i++) {
    candidates.push(path.join(dir, '.mcp.json'), path.join(dir, '.claude', 'mcp.json'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(path.join(home, '.mcp.json'), path.join(home, '.claude.json'));

  let entry = null, source = null;
  for (const c of candidates) {
    const e = awmEntry(readJson(c), cwd);
    if (e) { entry = e; source = c; break; }
  }
  const env = (entry && entry.env) || {};
  const fallback = readJson(path.join(home, '.claude', 'hooks', 'awm-hooks.json')) || {};

  const agentId = process.env.AWM_AGENT_ID || env.AWM_AGENT_ID
    || (entry ? deriveAgentFromDir(cwd) : (fallback.agentId || deriveAgentFromDir(cwd)));
  const dbPath = env.AWM_DB_PATH || fallback.dbPath || null;
  let secret = process.env.AWM_HOOK_SECRET || env.AWM_HOOK_SECRET || '';
  if (!secret && dbPath) secret = readText(path.join(path.dirname(dbPath), '.awm-hook-secret'));
  if (!secret && fallback.secretPath) secret = readText(fallback.secretPath);
  const port = parseInt(process.env.AWM_HOOK_PORT || env.AWM_HOOK_PORT || fallback.hookPort || '8401', 10) || 8401;
  const range = Math.max(1, parseInt(process.env.AWM_HOOK_PORT_RANGE || env.AWM_HOOK_PORT_RANGE || fallback.hookPortRange || '10', 10) || 10);
  return { agentId: agentId, secret: secret, port: port, range: range, dbPath: dbPath, source: source };
}

function probe(port) {
  return new Promise(function (resolve) {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/health', timeout: PROBE_TIMEOUT_MS }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try {
          const j = JSON.parse(data);
          resolve(j && j.sidecar ? { port: port, agentId: j.agentId || null, version: j.version || '0.0.0', pid: j.pid || null } : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', function () { resolve(null); });
    req.on('timeout', function () { req.destroy(); resolve(null); });
  });
}

function versionKey(v) { return String(v || '0').split('.').map(function (n) { return parseInt(n, 10) || 0; }); }
function newer(a, b) {
  const ka = versionKey(a), kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] || 0) - (kb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** Every live sidecar in the configured range, regardless of agent. */
async function listSidecars(cfg) {
  const ports = [];
  for (let i = 0; i < cfg.range; i++) ports.push(cfg.port + i);
  return (await Promise.all(ports.map(probe))).filter(Boolean);
}

/**
 * The sidecar for this session, or null. Resolves to
 * { sidecar: {port, agentId, version, pid} | null, config, all: [...] }.
 */
async function findSidecar(cwd) {
  const cfg = resolveConfig(cwd);
  const all = await listSidecars(cfg);
  const mine = all.filter(function (s) { return s.agentId === cfg.agentId; });
  mine.sort(function (a, b) { return newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : a.port - b.port; });
  return { sidecar: mine[0] || null, config: cfg, all: all };
}

/** Optional trace for troubleshooting: AWM_HOOK_DEBUG=1 appends to ~/.claude/hooks/awm-hooks.log. */
function debugLog(hook, fields) {
  if (!process.env.AWM_HOOK_DEBUG) return;
  try {
    const line = Object.assign({ ts: new Date().toISOString(), hook: hook }, fields);
    fs.appendFileSync(path.join(os.homedir(), '.claude', 'hooks', 'awm-hooks.log'), JSON.stringify(line) + '\\n');
  } catch (e) { /* never matters */ }
}

module.exports = { resolveConfig, findSidecar, listSidecars, deriveAgentFromDir, debugLog, PROBE_TIMEOUT_MS };
`;

// ─── awm-checkpoint.cjs ──────────────────────────────────────────────────────

export const CHECKPOINT_HOOK_SCRIPT = HEADER(
  'awm-checkpoint.cjs',
  'PreCompact / SessionEnd: checkpoint this session into ITS agent\'s AWM.',
) + `
// Forwards the whole hook payload (hook_event_name, transcript_path, cwd,
// session_id) to POST /hooks/checkpoint on the sidecar that belongs to this
// session's agent. transcript_path matters: the sidecar parses it for the
// current task and active files, so the checkpoint is a real one, not a stub.
'use strict';
const http = require('http');

let finder = null;
try { finder = require('./awm-find-sidecar.cjs'); } catch (e) { process.exit(0); }

const TIMEOUT_MS = 5000;

let raw = '';
process.stdin.on('data', function (d) { raw += d; });
process.stdin.on('end', function () {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (e) { payload = {}; }
  if (!payload.hook_event_name) payload.hook_event_name = 'PreCompact';
  main(payload).catch(function () { process.exit(0); });
});
// A hook with nothing on stdin must still exit.
process.stdin.on('error', function () { process.exit(0); });

async function main(payload) {
  const found = await finder.findSidecar(payload.cwd);
  const sc = found.sidecar;
  if (!sc) {
    finder.debugLog('checkpoint', { event: payload.hook_event_name, agent: found.config.agentId, sidecar: null, live: found.all.length });
    process.exit(0);
  }
  const body = JSON.stringify(payload);
  const req = http.request({
    host: '127.0.0.1', port: sc.port, path: '/hooks/checkpoint', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': 'Bearer ' + found.config.secret,
    },
    timeout: TIMEOUT_MS,
  }, function (res) {
    res.resume();
    res.on('end', function () {
      finder.debugLog('checkpoint', { event: payload.hook_event_name, agent: found.config.agentId, port: sc.port, status: res.statusCode });
      process.exit(0);
    });
  });
  req.on('error', function () { process.exit(0); });
  req.on('timeout', function () { req.destroy(); process.exit(0); });
  req.end(body);
}
`;

// ─── awm-prime.cjs ───────────────────────────────────────────────────────────

export const PRIME_HOOK_SCRIPT = HEADER(
  'awm-prime.cjs',
  'UserPromptSubmit: prime the turn with relevant memories, or stay silent.',
) + `
// The PRIME phase of the AWM-native harness (docs/patterns/awm-native-harness.md).
// Posts the prompt to POST /hooks/prime on this session's sidecar and injects the
// returned text as additionalContext. The sidecar decides what to inject, formats
// it, abstains when confidence is low and caps the token budget — see
// src/hooks/prime.ts — so this file stays thin.
//
// Turn it off without uninstalling: create ~/.claude/hooks/${PRIME_DISABLE_FILE}
// (an empty file). Remove the file to turn it back on. \`awm doctor\` reports which.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let finder = null;
try { finder = require('./awm-find-sidecar.cjs'); } catch (e) { process.exit(0); }

// A slow AWM must never delay a prompt. Warm recall with rerank measures 1.4–1.8 s
// on a 30k-memory store; 4 s leaves margin. Connection refused returns in ~100 ms.
const TIMEOUT_MS = 4000;
const MIN_PROMPT_LEN = 15;   // skip "yes" / "ok" / "go on" turns
// Set-level confidence below which the sidecar injects nothing. 0.10 rather than
// the 0.25 once documented as "balanced": measured 2026-09-11, 0.25 silenced
// specific prompts with one clear winner (top score 0.26–0.38) while passing a
// vague one at 0.92. The gate is on the shape of the score distribution, not on
// relevance, so specific questions are exactly the ones a high threshold loses.
const MIN_CONFIDENCE = 0.10;
const DISABLE_FILE = path.join(os.homedir(), '.claude', 'hooks', '${PRIME_DISABLE_FILE}');

let raw = '';
process.stdin.on('data', function (d) { raw += d; });
process.stdin.on('end', function () {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (e) { process.exit(0); }
  main(payload).catch(function () { process.exit(0); });
});
process.stdin.on('error', function () { process.exit(0); });

function extractPrompt(j) {
  for (const key of ['prompt', 'message', 'user_prompt', 'text', 'input']) {
    if (typeof j[key] === 'string' && j[key].trim()) return j[key];
  }
  return null;
}

async function main(payload) {
  if (fs.existsSync(DISABLE_FILE)) process.exit(0);
  const prompt = extractPrompt(payload);
  if (!prompt || prompt.trim().length < MIN_PROMPT_LEN) process.exit(0);

  const found = await finder.findSidecar(payload.cwd);
  const sc = found.sidecar;
  if (!sc) {
    finder.debugLog('prime', { agent: found.config.agentId, sidecar: null, live: found.all.length });
    process.exit(0);
  }

  const body = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: payload.session_id,
    cwd: payload.cwd,
    prompt: prompt,
    minConfidence: MIN_CONFIDENCE,
  });
  const req = http.request({
    host: '127.0.0.1', port: sc.port, path: '/hooks/prime', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': 'Bearer ' + found.config.secret,
    },
    timeout: TIMEOUT_MS,
  }, function (res) {
    let data = '';
    res.on('data', function (c) { data += c; });
    res.on('end', function () {
      let out = null;
      try { out = JSON.parse(data); } catch (e) { out = null; }
      const inject = out && typeof out.inject === 'string' ? out.inject : '';
      finder.debugLog('prime', { agent: found.config.agentId, port: sc.port, status: res.statusCode, kept: out && out.kept, total: out && out.total, reason: out && out.reason });
      if (res.statusCode === 200 && inject) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: inject },
        }));
      }
      process.exit(0);
    });
  });
  req.on('error', function () { process.exit(0); });
  req.on('timeout', function () { req.destroy(); process.exit(0); });
  req.end(body);
}
`;

/** Everything `awm setup` places in ~/.claude/hooks/. */
export const HOOK_SCRIPTS: ReadonlyArray<{ file: string; source: string }> = [
  { file: 'awm-find-sidecar.cjs', source: FIND_SIDECAR_SCRIPT },
  { file: 'awm-checkpoint.cjs', source: CHECKPOINT_HOOK_SCRIPT },
  { file: 'awm-prime.cjs', source: PRIME_HOOK_SCRIPT },
];

/** The fallback record the finder reads when no MCP config governs a cwd. */
export interface HooksRecord {
  version: string;
  agentId: string;
  dbPath: string;
  secretPath: string;
  hookPort: string;
  hookPortRange: string;
  installedAt: string;
}
