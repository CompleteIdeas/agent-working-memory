/**
 * Coordination Module Tests
 *
 * Tests all coordination endpoints and the feature flag.
 * Run: npx tsx tests/coordination.test.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

// Test the module directly (no HTTP server needed for unit tests)
import { initCoordinationTables } from '../src/coordination/schema.js';
import { cleanSlate, detectStale, cleanupStale } from '../src/coordination/stale.js';
import { registerCoordinationRoutes } from '../src/coordination/routes.js';
import { isCoordinationEnabled } from '../src/coordination/index.js';

const DB_PATH = join(tmpdir(), `awm-coord-test-${Date.now()}.db`);
let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let baseUrl: string;

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

async function fetch(path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: any }> {
  const url = `${baseUrl}${path}`;
  const resp = await globalThis.fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

async function setup() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initCoordinationTables(db);

  app = Fastify({ logger: false });
  registerCoordinationRoutes(app, db);
  await app.listen({ port: 0, host: '127.0.0.1' });

  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('unexpected address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`Test server on ${baseUrl}`);
}

async function teardown() {
  await app.close();
  db.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
}

// ─── Feature Flag ─────────────────────────────────────────────

async function testFeatureFlag() {
  console.log('\n--- Feature Flag ---');
  const orig = process.env.AWM_COORDINATION;

  delete process.env.AWM_COORDINATION;
  assert(!isCoordinationEnabled(), 'disabled when env not set');

  process.env.AWM_COORDINATION = 'false';
  assert(!isCoordinationEnabled(), 'disabled when set to false');

  process.env.AWM_COORDINATION = 'true';
  assert(isCoordinationEnabled(), 'enabled when set to true');

  process.env.AWM_COORDINATION = '1';
  assert(isCoordinationEnabled(), 'enabled when set to 1');

  // Restore
  if (orig !== undefined) process.env.AWM_COORDINATION = orig;
  else delete process.env.AWM_COORDINATION;
}

// ─── Checkin / Checkout ────────────────────────────────────────

async function testCheckin() {
  console.log('\n--- Checkin ---');

  const { status, data } = await fetch('/checkin', {
    method: 'POST',
    body: { name: 'Worker-A', role: 'worker', capabilities: ['coding', 'testing'] },
  });

  assert(status === 201, `first checkin returns 201 (got ${status})`);
  assert(data.action === 'registered', 'action is registered');
  assert(data.status === 'idle', 'status is idle');
  assert(typeof data.agentId === 'string', 'returns agentId');

  // Heartbeat
  const { status: s2, data: d2 } = await fetch('/checkin', {
    method: 'POST',
    body: { name: 'Worker-A', role: 'worker' },
  });
  assert(s2 === 200, `heartbeat returns 200 (got ${s2})`);
  assert(d2.action === 'heartbeat', 'action is heartbeat');
  assert(d2.agentId === data.agentId, 'same agentId on heartbeat');

  return data.agentId as string;
}

async function testCheckout(agentId: string) {
  console.log('\n--- Checkout ---');

  const { status, data } = await fetch('/checkout', {
    method: 'POST',
    body: { agentId },
  });
  assert(status === 200, 'checkout returns 200');
  assert(data.ok === true, 'checkout ok');
}

// ─── Assignments ──────────────────────────────────────────────

async function testAssignments(agentId: string) {
  console.log('\n--- Assignments ---');

  // Create unassigned task
  const { status, data } = await fetch('/assign', {
    method: 'POST',
    body: { task: 'Fix the login bug', description: 'Users cannot log in after password reset' },
  });
  assert(status === 201, `assign returns 201 (got ${status})`);
  assert(data.status === 'pending', 'unassigned task is pending');
  const assignmentId = data.assignmentId;

  // Agent asks for work — should auto-claim
  const { data: d2 } = await fetch(`/assignment?agentId=${agentId}`);
  assert(d2.assignment !== null, 'auto-claimed pending task');
  assert(d2.assignment.id === assignmentId, 'claimed the right task');
  assert(d2.assignment.status === 'assigned', 'status is assigned after claim');

  // Update to in_progress
  const { data: d3 } = await fetch(`/assignment/${assignmentId}`, {
    method: 'PATCH',
    body: { status: 'in_progress' },
  });
  assert(d3.ok === true, 'update to in_progress ok');

  // Complete
  const { data: d4 } = await fetch(`/assignment/${assignmentId}`, {
    method: 'PATCH',
    body: { status: 'completed', result: 'Fixed by adding null check' },
  });
  assert(d4.ok === true, 'complete ok');

  // Agent should now be idle
  const row = db.prepare(`SELECT status, current_task FROM coord_agents WHERE id = ?`).get(agentId) as { status: string; current_task: string | null };
  assert(row.status === 'idle', 'agent back to idle after completion');
  assert(row.current_task === null, 'current_task cleared');

  // No more assignments
  const { data: d5 } = await fetch(`/assignment?agentId=${agentId}`);
  assert(d5.assignment === null, 'no more assignments');

  return assignmentId;
}

// ─── Direct assignment to agent ───────────────────────────────

async function testDirectAssignment(agentId: string) {
  console.log('\n--- Direct Assignment ---');

  const { status, data } = await fetch('/assign', {
    method: 'POST',
    body: { agentId, task: 'Write unit tests' },
  });
  assert(status === 201, 'direct assign returns 201');
  assert(data.status === 'assigned', 'directly assigned');

  const row = db.prepare(`SELECT status FROM coord_agents WHERE id = ?`).get(agentId) as { status: string };
  assert(row.status === 'working', 'agent status is working after direct assign');

  // Complete it
  await fetch(`/assignment/${data.assignmentId}`, {
    method: 'PATCH',
    body: { status: 'completed', result: 'Done' },
  });
}

// ─── Locks ────────────────────────────────────────────────────

async function testLocks(agentId: string) {
  console.log('\n--- Locks ---');

  // Acquire
  const { status, data } = await fetch('/lock', {
    method: 'POST',
    body: { agentId, filePath: 'src/index.ts', reason: 'editing' },
  });
  assert(status === 200, 'lock acquired');
  assert(data.action === 'acquired', 'action is acquired');

  // Refresh (same agent, same file)
  const { data: d2 } = await fetch('/lock', {
    method: 'POST',
    body: { agentId, filePath: 'src/index.ts' },
  });
  assert(d2.action === 'refreshed', 'lock refreshed by same agent');

  // Conflict (different agent)
  // First register another agent
  const { data: other } = await fetch('/checkin', {
    method: 'POST',
    body: { name: 'Worker-B', role: 'worker' },
  });
  const { status: s3 } = await fetch('/lock', {
    method: 'POST',
    body: { agentId: other.agentId, filePath: 'src/index.ts' },
  });
  assert(s3 === 409, 'lock conflict returns 409');

  // List locks
  const { data: d4 } = await fetch('/locks');
  assert(d4.locks.length >= 1, 'locks list has entries');

  // Release
  const { data: d5 } = await fetch('/lock', {
    method: 'DELETE',
    body: { agentId, filePath: 'src/index.ts' },
  });
  assert(d5.ok === true, 'lock released');

  // Checkout other agent to clean up
  await fetch('/checkout', { method: 'POST', body: { agentId: other.agentId } });
}

// ─── Commands ─────────────────────────────────────────────────

async function testCommands() {
  console.log('\n--- Commands ---');

  // Issue BUILD_FREEZE
  const { status, data } = await fetch('/command', {
    method: 'POST',
    body: { command: 'BUILD_FREEZE', reason: 'deploying to prod' },
  });
  assert(status === 201, 'command issued');
  assert(data.command === 'BUILD_FREEZE', 'command is BUILD_FREEZE');

  // Poll
  const { data: d2 } = await fetch('/command');
  assert(d2.active === true, 'active commands found');
  assert(d2.command === 'BUILD_FREEZE', 'highest priority is BUILD_FREEZE');

  // RESUME clears
  await fetch('/command', {
    method: 'POST',
    body: { command: 'RESUME' },
  });

  const { data: d3 } = await fetch('/command');
  assert(d3.active === false, 'no active commands after RESUME');
}

// ─── Findings ─────────────────────────────────────────────────

async function testFindings(agentId: string) {
  console.log('\n--- Findings ---');

  const { status } = await fetch('/finding', {
    method: 'POST',
    body: { agentId, category: 'bug', severity: 'error', description: 'Null pointer in auth handler', filePath: 'src/auth.ts' },
  });
  assert(status === 201, 'finding reported');

  const { data } = await fetch('/findings');
  assert(data.findings.length >= 1, 'findings list has entries');
  assert(data.findings[0].category === 'bug', 'finding category correct');

  // Summary
  const { data: d2 } = await fetch('/findings/summary');
  assert(d2.total >= 1, 'summary total correct');

  // Resolve
  const findingId = data.findings[0].id;
  await fetch(`/finding/${findingId}/resolve`, { method: 'POST' });
  const { data: d3 } = await fetch('/findings/summary');
  assert(d3.total === 0, 'no open findings after resolve');
}

// ─── Status ───────────────────────────────────────────────────

async function testStatus(agentId: string) {
  console.log('\n--- Status ---');

  const { data } = await fetch('/status');
  assert(data.agents !== undefined, 'status has agents');
  assert(data.assignments !== undefined, 'status has assignments');
  assert(data.locks !== undefined, 'status has locks');
  assert(data.stats !== undefined, 'status has stats');
}

// ─── Workers ──────────────────────────────────────────────────

async function testWorkers(agentId: string) {
  console.log('\n--- Workers ---');

  const { data } = await fetch('/workers');
  assert(data.count >= 1, 'workers count >= 1');
  assert(Array.isArray(data.workers), 'workers is array');

  const worker = data.workers.find((w: { id: string }) => w.id === agentId);
  assert(worker !== undefined, 'our agent is in workers list');
}

// ─── Stale ────────────────────────────────────────────────────

async function testStale() {
  console.log('\n--- Stale Detection ---');

  // Manually make an agent stale
  db.prepare(`UPDATE coord_agents SET last_seen = datetime('now', '-300 seconds') WHERE name = 'Worker-A'`).run();

  const stale = detectStale(db, 120);
  assert(stale.length >= 1, 'stale agent detected');

  const { stale: cleaned, cleaned: count } = cleanupStale(db, 120);
  assert(cleaned.length >= 1, 'stale cleanup found agents');

  const agent = db.prepare(`SELECT status FROM coord_agents WHERE name = 'Worker-A'`).get() as { status: string };
  assert(agent.status === 'dead', 'stale agent marked dead');
}

// ─── Events ───────────────────────────────────────────────────

async function testEvents() {
  console.log('\n--- Events ---');

  const { data } = await fetch('/events');
  assert(Array.isArray(data.events), 'events is array');
  assert(data.events.length > 0, 'events recorded from previous tests');
}

// ─── Tables Not Created Without Flag ──────────────────────────

function testBackwardCompat() {
  console.log('\n--- Backward Compatibility ---');

  // A fresh DB without initCoordinationTables should not have coord_ tables
  const freshPath = join(tmpdir(), `awm-coord-compat-${Date.now()}.db`);
  const freshDb = new Database(freshPath);
  freshDb.pragma('journal_mode = WAL');

  const tables = freshDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'coord_%'`).all();
  assert(tables.length === 0, 'no coord_ tables in fresh DB');

  freshDb.close();
  unlinkSync(freshPath);
}

// ─── Run All ──────────────────────────────────────────────────

async function main() {
  console.log('=== Coordination Module Tests ===\n');

  testBackwardCompat();
  await testFeatureFlag();

  await setup();
  try {
    const agentId = await testCheckin();
    await testAssignments(agentId);
    await testDirectAssignment(agentId);
    await testLocks(agentId);
    await testCommands();
    await testFindings(agentId);
    await testStatus(agentId);
    await testWorkers(agentId);
    await testEvents();
    await testStale();
  } finally {
    await teardown();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
