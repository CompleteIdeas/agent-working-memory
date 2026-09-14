#!/usr/bin/env node
// awm-checkpoint.cjs — installed by `awm setup` (hooks v0.14.6). PreCompact / SessionEnd: checkpoint this session into ITS agent's AWM.
// Re-running `awm setup` rewrites this file; put local changes elsewhere.
// Fails open: on any problem it prints nothing and exits 0.

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
