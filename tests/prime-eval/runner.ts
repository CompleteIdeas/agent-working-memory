/**
 * Prime-hook evaluation — end-to-end against the real sidecar.
 *
 * Spawns the MCP server (which starts the hook sidecar in the same process),
 * seeds memories over MCP, then POSTs to /hooks/prime exactly as a Claude Code
 * UserPromptSubmit hook would. No LLM involved.
 *
 * Answers three questions:
 *   1. Does it inject useful context for an on-topic prompt?
 *   2. Does it STAY SILENT for an off-topic one? (the property that matters —
 *      this runs on every prompt)
 *   3. Does it respect the token cap?
 *
 * Run: npx tsx tests/prime-eval/runner.ts
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DB_PATH = join(tmpdir(), `awm-prime-${Date.now()}.db`);
const MCP_SCRIPT = join(import.meta.dirname, '..', '..', 'src', 'mcp.ts');
const PORT = 8477;                       // off the default to avoid collisions
const SECRET = 'prime-eval-secret';

let requestId = 1;
let buffer = '';
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

const proc = spawn(process.execPath, ['--import', 'tsx', MCP_SCRIPT], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AWM_DB_PATH: DB_PATH,
    AWM_AGENT_ID: 'prime-eval',
    AWM_HOOK_PORT: String(PORT),
    AWM_HOOK_SECRET: SECRET,
  },
});
proc.stderr.on('data', () => {});
proc.stdout.on('data', (d: Buffer) => {
  buffer += d.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop()!;
  for (const line of lines) {
    const t = line.trim(); if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (m.id && pending.has(m.id)) { pending.get(m.id)!.resolve(m); pending.delete(m.id); }
    } catch {}
  }
});

function send(method: string, params: any = {}, timeoutMs = 120000): Promise<any> {
  const id = requestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)); } }, timeoutMs);
  });
}
const call = (name: string, args: any) => send('tools/call', { name, arguments: args });

async function prime(body: any): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${PORT}/hooks/prime`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  return r.json();
}

const MEMORIES: Array<[string, string]> = [
  ['period close BLOCKED enforced server-side',
   'AccountingService.closePeriod() enforces the BLOCKED state server-side per schema/072-period-close.sql. A client-only check previously allowed a direct API call to bypass it, which is how period 2026-03 got closed twice.'],
  ['magic-link rate limit is 5 per 15 minutes',
   'The magic-link endpoint rate limits to 5 requests per 15 minutes per email, enforced in AuthService.requestMagicLink() against the login_attempts table. Exceeding it returns 429 with Retry-After.'],
  ['state management standardised on Zustand',
   'The team standardised on Zustand for client state in January. Redux was explicitly rejected because the boilerplate cost outweighed the devtools benefit at this codebase size. Do not reintroduce Redux.'],
];

let failures = 0;
const pass = (n: string, d: string) => console.log(`  [PASS] ${n} — ${d}`);
const fail = (n: string, d: string) => { console.log(`  [FAIL] ${n} — ${d}`); failures++; };

async function main() {
  console.log('Prime-Hook Evaluation');
  console.log(`DB: ${DB_PATH}  sidecar: 127.0.0.1:${PORT}\n`);

  await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'prime-eval', version: '1.0.0' },
  });

  process.stdout.write('Seeding');
  for (const [concept, content] of MEMORIES) {
    await call('memory_write', {
      concept, content, project: 'Eval', topic: 'eng',
      intent: 'decision', confidence_level: 'verified', memory_class: 'canonical',
    });
    process.stdout.write('.');
  }
  console.log(` ${MEMORIES.length} written\n`);

  console.log('=== 1. ON-TOPIC PROMPT (should inject) ===');
  const onTopic = await prime({ prompt: 'why does closing an accounting period fail sometimes?' });
  if (onTopic.inject && /period|close/i.test(onTopic.inject)) {
    pass('on-topic injection', `${onTopic.kept}/${onTopic.total} memories, ~${onTopic.tokens} tok`);
    console.log(`         ${onTopic.inject.split('\n')[1]?.slice(0, 110) ?? ''}`);
  } else {
    fail('on-topic injection', `inject empty or irrelevant (reason=${onTopic.reason})`);
  }

  console.log('\n=== 2. OFF-TOPIC PROMPT (should stay silent) ===');
  const offTopic = await prime({ prompt: 'what is the best pasta recipe for a dinner party' });
  if (!offTopic.inject) {
    pass('off-topic abstention', `silent (reason=${offTopic.reason}), 0 tokens spent`);
  } else {
    fail('off-topic abstention', `injected ~${offTopic.tokens} tok on an unrelated prompt: ${offTopic.inject.slice(0, 90)}`);
  }

  console.log('\n=== 3. TOKEN CAP ===');
  // Must use a prompt we KNOW injects, or abstention makes this vacuous: an
  // empty injection trivially fits any cap and proves nothing. The first version
  // of this test used a diffuse multi-topic prompt and "passed" at 0/3 kept.
  let capOk = true;
  let capExercised = false;
  for (const cap of [400, 200, 100]) {
    const r = await prime({ prompt: 'why does closing an accounting period fail sometimes?', maxTokens: cap });
    const est = Math.max(Math.ceil((r.inject ?? '').split(/\s+/).filter(Boolean).length * 1.3), Math.ceil((r.inject ?? '').length / 4));
    const ok = est <= cap;
    if (!ok) capOk = false;
    if ((r.kept ?? 0) > 0) capExercised = true;
    console.log(`    cap ${String(cap).padEnd(5)} actual ${String(est).padEnd(5)} kept ${r.kept}/${r.total}  ${ok ? 'ok' : 'OVER'}`);
  }
  if (!capExercised) fail('token cap', 'VACUOUS — nothing was ever injected, so no cap was actually tested');
  else if (!capOk) fail('token cap', 'a cap was exceeded');
  else pass('token cap', 'caps respected with real injections');

  console.log('\n=== 4. EMPTY PROMPT (must not error) ===');
  const empty = await prime({ prompt: '' });
  empty.inject === '' && empty.reason === 'no-prompt'
    ? pass('empty prompt', 'returns empty injection, no error')
    : fail('empty prompt', JSON.stringify(empty).slice(0, 100));

  console.log('\n==================================================');
  console.log(failures === 0 ? 'ALL PRIME TESTS PASSED' : `${failures} TEST(S) FAILED`);
  console.log('==================================================');
  proc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); proc.kill(); process.exit(1); });
