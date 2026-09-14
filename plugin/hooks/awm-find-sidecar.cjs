#!/usr/bin/env node
// awm-find-sidecar.cjs — installed by `awm setup` (hooks v0.14.6). Shared resolver: which AWM sidecar belongs to THIS session.
// Re-running `awm setup` rewrites this file; put local changes elsewhere.
// Fails open: on any problem it prints nothing and exits 0.

// Since AWM 0.14.2 each MCP process binds the first free port in
// [AWM_HOOK_PORT, +AWM_HOOK_PORT_RANGE), so "the sidecar is on 8401" is not a
// safe assumption: with N sessions open there are N sidecars and the one on
// 8401 may serve a different agent pool. This module (1) works out which agent
// a session started in `cwd` belongs to, from the MCP config that governs that
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

function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; } }

// MIRROR of deriveAgentFromDir() in src/core/agent-id.ts — the server's own
// fallback when AWM_AGENT_ID is unset. Kept in sync by tests/adapters/hook-scripts.test.ts.
function deriveAgentFromDir(dir) {
  const d = String(dir || '').replace(/\\/g, '/');
  if (/\/AgentSynapse\//i.test(d)) return 'work';
  return /\/Personal-Projects(\/|$)/i.test(d) ? 'personal' : 'work';
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
 * Resolve the configuration that governs a session started in `cwd`:
 * { agentId, secret, port, range, dbPath, source }.
 *
 * Order: the nearest .mcp.json / .claude/mcp.json walking up from cwd, then
 * ~/.mcp.json, then ~/.claude.json, then the record `awm setup` left in
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
    fs.appendFileSync(path.join(os.homedir(), '.claude', 'hooks', 'awm-hooks.log'), JSON.stringify(line) + '\n');
  } catch (e) { /* never matters */ }
}

module.exports = { resolveConfig, findSidecar, listSidecars, deriveAgentFromDir, debugLog, PROBE_TIMEOUT_MS };
