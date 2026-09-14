#!/usr/bin/env node
// awm-prime.cjs — installed by `awm setup` (hooks v0.14.6). UserPromptSubmit: prime the turn with relevant memories, or stay silent.
// Re-running `awm setup` rewrites this file; put local changes elsewhere.
// Fails open: on any problem it prints nothing and exits 0.

// The PRIME phase of the AWM-native harness (docs/patterns/awm-native-harness.md).
// Posts the prompt to POST /hooks/prime on this session's sidecar and injects the
// returned text as additionalContext. The sidecar decides what to inject, formats
// it, abstains when confidence is low and caps the token budget — see
// src/hooks/prime.ts — so this file stays thin.
//
// Turn it off without uninstalling: create ~/.claude/hooks/awm-prime.disabled
// (an empty file). Remove the file to turn it back on. `awm doctor` reports which.
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
const DISABLE_FILE = path.join(os.homedir(), '.claude', 'hooks', 'awm-prime.disabled');

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
