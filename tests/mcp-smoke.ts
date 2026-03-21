/**
 * MCP Smoke Test — verifies all 5 tools work via the MCP protocol.
 *
 * Spawns the MCP server as a child process and sends JSON-RPC messages
 * over stdio, just like Claude Code would.
 *
 * Run: npx tsx tests/mcp-smoke.ts
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `awm-mcp-smoke-${Date.now()}.db`);
const MCP_SCRIPT = join(import.meta.dirname, '..', 'src', 'mcp.ts');

let requestId = 1;
let buffer = '';
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

const proc = spawn(process.execPath, [
  '--import', 'tsx',
  MCP_SCRIPT,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AWM_DB_PATH: DB_PATH, AWM_AGENT_ID: 'smoke-test' },
});

proc.stderr.on('data', (d: Buffer) => {
  // MCP server logs to stderr — ignore
});

proc.stdout.on('data', (d: Buffer) => {
  buffer += d.toString();
  // MCP uses newline-delimited JSON-RPC
  const lines = buffer.split('\n');
  buffer = lines.pop()!;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!.resolve(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function send(method: string, params: any = {}): Promise<any> {
  const id = requestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    proc.stdin.write(msg);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }
    }, 10000);
  });
}

function pass(name: string, detail: string) {
  console.log(`  [PASS] ${name} — ${detail}`);
}
function fail(name: string, detail: string) {
  console.log(`  [FAIL] ${name} — ${detail}`);
  failures++;
}

let failures = 0;

async function main() {
  console.log('MCP Smoke Test');
  console.log(`DB: ${DB_PATH}`);
  console.log('');

  // 1. Initialize
  console.log('=== INITIALIZATION ===');
  try {
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    });
    if (init.result?.serverInfo?.name === 'agent-working-memory') {
      pass('Initialize', `Server: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
    } else {
      fail('Initialize', `Unexpected response: ${JSON.stringify(init.result)}`);
    }

    // Send initialized notification
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  } catch (e: any) {
    fail('Initialize', e.message);
  }

  // 2. List tools
  console.log('\n=== TOOL LISTING ===');
  try {
    const tools = await send('tools/list', {});
    const toolNames = tools.result?.tools?.map((t: any) => t.name) ?? [];
    const expected = ['memory_write', 'memory_recall', 'memory_feedback', 'memory_retract', 'memory_stats'];
    const allPresent = expected.every(n => toolNames.includes(n));
    if (allPresent) {
      pass('List tools', `Found all 5: ${toolNames.join(', ')}`);
    } else {
      fail('List tools', `Missing tools. Found: ${toolNames.join(', ')}`);
    }
  } catch (e: any) {
    fail('List tools', e.message);
  }

  // 3. memory_write
  console.log('\n=== TOOL CALLS ===');
  let writeEngramId: string | null = null;
  try {
    const write = await send('tools/call', {
      name: 'memory_write',
      arguments: {
        concept: 'SQLite FTS5 search',
        content: 'This project uses SQLite with FTS5 for full-text search with BM25 ranking',
        event_type: 'causal',
        surprise: 0.6,
        causal_depth: 0.7,
        resolution_effort: 0.5,
      },
    });
    const text = write.result?.content?.[0]?.text ?? '';
    if (text.includes('Memory stored')) {
      // Extract ID from response
      const idMatch = text.match(/ID:\s*([a-f0-9-]+)/);
      writeEngramId = idMatch?.[1] ?? null;
      pass('memory_write', text.split('\n')[0]);
    } else {
      fail('memory_write', `Unexpected: ${text}`);
    }
  } catch (e: any) {
    fail('memory_write', e.message);
  }

  // Write a second memory for association testing
  try {
    await send('tools/call', {
      name: 'memory_write',
      arguments: {
        concept: 'BM25 ranking algorithm',
        content: 'BM25 is the ranking function used by FTS5 for relevance scoring in text search',
        event_type: 'causal',
        surprise: 0.5,
        causal_depth: 0.6,
        resolution_effort: 0.4,
      },
    });
  } catch {}

  // 4. memory_recall
  try {
    const recall = await send('tools/call', {
      name: 'memory_recall',
      arguments: {
        context: 'full-text search SQLite database ranking',
        limit: 5,
      },
    });
    const text = recall.result?.content?.[0]?.text ?? '';
    if (text.includes('Recalled') && text.includes('SQLite')) {
      pass('memory_recall', `${text.split('\n')[0]}`);
    } else if (text.includes('No relevant')) {
      fail('memory_recall', 'No memories found');
    } else {
      fail('memory_recall', `Unexpected: ${text.substring(0, 100)}`);
    }
  } catch (e: any) {
    fail('memory_recall', e.message);
  }

  // 5. memory_feedback
  if (writeEngramId) {
    try {
      const fb = await send('tools/call', {
        name: 'memory_feedback',
        arguments: {
          engram_id: writeEngramId,
          useful: true,
          context: 'Smoke test — verifying feedback works',
        },
      });
      const text = fb.result?.content?.[0]?.text ?? '';
      if (text.includes('useful') && text.includes('increased')) {
        pass('memory_feedback', text);
      } else {
        fail('memory_feedback', `Unexpected: ${text}`);
      }
    } catch (e: any) {
      fail('memory_feedback', e.message);
    }
  } else {
    fail('memory_feedback', 'No engram ID from write step');
  }

  // 6. memory_retract
  // Write a wrong memory first
  let wrongId: string | null = null;
  try {
    const wrong = await send('tools/call', {
      name: 'memory_write',
      arguments: {
        concept: 'wrong fact for testing',
        content: 'JavaScript uses tabs for indentation by default',
        event_type: 'decision',
        decision_made: true,
        surprise: 0.5,
        causal_depth: 0.4,
      },
    });
    const text = wrong.result?.content?.[0]?.text ?? '';
    const idMatch = text.match(/ID:\s*([a-f0-9-]+)/);
    wrongId = idMatch?.[1] ?? null;
  } catch {}

  if (wrongId) {
    try {
      const retract = await send('tools/call', {
        name: 'memory_retract',
        arguments: {
          engram_id: wrongId,
          reason: 'JavaScript has no default indentation — it depends on project config',
          correction: 'JavaScript indentation style is determined by project configuration (ESLint, Prettier). Common styles are 2 spaces or 4 spaces.',
        },
      });
      const text = retract.result?.content?.[0]?.text ?? '';
      if (text.includes('retracted') && text.includes('Correction stored')) {
        pass('memory_retract', text);
      } else {
        fail('memory_retract', `Unexpected: ${text}`);
      }
    } catch (e: any) {
      fail('memory_retract', e.message);
    }
  } else {
    fail('memory_retract', 'Could not create wrong memory to retract');
  }

  // 7. memory_stats
  try {
    const stats = await send('tools/call', {
      name: 'memory_stats',
      arguments: {},
    });
    const text = stats.result?.content?.[0]?.text ?? '';
    if (text.includes('Active memories') && text.includes('smoke-test')) {
      pass('memory_stats', text.split('\n').slice(0, 3).join(', '));
    } else {
      fail('memory_stats', `Unexpected: ${text.substring(0, 200)}`);
    }
  } catch (e: any) {
    fail('memory_stats', e.message);
  }

  // --- Report ---
  console.log('\n' + '='.repeat(50));
  if (failures === 0) {
    console.log('ALL MCP SMOKE TESTS PASSED');
  } else {
    console.log(`${failures} TEST(S) FAILED`);
  }
  console.log('='.repeat(50));

  // Cleanup
  proc.kill();
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(DB_PATH + '-wal'); } catch {}
  try { unlinkSync(DB_PATH + '-shm'); } catch {}

  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  proc.kill();
  process.exit(1);
});
