#!/usr/bin/env node
// awm-used.cjs — installed by `awm setup` (hooks v0.20.0). Stop: tell this session's AWM which recalled memories the reply used.
// Re-running `awm setup` rewrites this file; put local changes elsewhere.
// Fails open: on any problem it prints nothing and exits 0.

// Implicit feedback (0.20). Posts the hook payload (transcript_path,
// session_id, cwd) to POST /hooks/used on this session's sidecar, which reads
// the turn's reply and tool calls from the transcript and credits the recalls
// they drew on. Measured before this hook: 12 feedback rows against 23,653
// recalls — the agent never rates recalls, so the learning loop ran on nothing.
// Also prints the write/recall reminder the Stop hook has always printed.
'use strict';
const http = require('http');

let finder = null;
try { finder = require('./awm-find-sidecar.cjs'); } catch (e) { finder = null; }

const TIMEOUT_MS = 4000;
const REMINDER = 'MEMORY: (1) Did you learn anything new? Call memory_write. (2) Are you about to work on a topic you might have prior knowledge about? Call memory_recall. (3) Switching tasks? Call memory_task_begin.';

let raw = '';
process.stdin.on('data', function (d) { raw += d; });
process.stdin.on('end', function () {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (e) { payload = {}; }
  if (!payload.hook_event_name) payload.hook_event_name = 'Stop';
  process.stdout.write(REMINDER + '\n');
  if (!finder) process.exit(0);
  main(payload).catch(function () { process.exit(0); });
});
process.stdin.on('error', function () { process.exit(0); });

async function main(payload) {
  const found = await finder.findSidecar(payload.cwd);
  const sc = found.sidecar;
  if (!sc) { finder.debugLog('used', { agent: found.config.agentId, sidecar: null, live: found.all.length }); process.exit(0); }
  const body = JSON.stringify(payload);
  const req = http.request({
    host: '127.0.0.1', port: sc.port, path: '/hooks/used', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': 'Bearer ' + found.config.secret,
    },
    timeout: TIMEOUT_MS,
  }, function (res) {
    res.resume();
    res.on('end', function () {
      finder.debugLog('used', { agent: found.config.agentId, port: sc.port, status: res.statusCode });
      process.exit(0);
    });
  });
  req.on('error', function () { process.exit(0); });
  req.on('timeout', function () { req.destroy(); process.exit(0); });
  req.end(body);
}
