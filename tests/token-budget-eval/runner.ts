/**
 * Token-budget evaluation — measures what `max_tokens` actually costs and saves.
 *
 * Drives the real MCP server over stdio (no LLM involved), seeds a store with
 * realistically-sized memories, then recalls the same query at several budgets
 * and reports the true size of each reply.
 *
 * The question it answers: does budgeting genuinely bound per-call cost, and
 * how much relevance is given up to get there?
 *
 * Run: npx tsx tests/token-budget-eval/runner.ts
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DB_PATH = join(tmpdir(), `awm-tokbudget-${Date.now()}.db`);
const MCP_SCRIPT = join(import.meta.dirname, '..', '..', 'src', 'mcp.ts');

let requestId = 1;
let buffer = '';
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

const proc = spawn(process.execPath, ['--import', 'tsx', MCP_SCRIPT], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AWM_DB_PATH: DB_PATH, AWM_AGENT_ID: 'tokbudget-eval' },
});
proc.stderr.on('data', () => {});
proc.stdout.on('data', (d: Buffer) => {
  buffer += d.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop()!;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!.resolve(msg); pending.delete(msg.id); }
    } catch {}
  }
});

function send(method: string, params: any = {}, timeoutMs = 120000): Promise<any> {
  const id = requestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }
    }, timeoutMs);
  });
}

const call = (name: string, args: any, timeoutMs?: number) =>
  send('tools/call', { name, arguments: args }, timeoutMs);

const textOf = (r: any): string => r?.result?.content?.[0]?.text ?? '';
const estTokens = (s: string) => {
  const words = s.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(words * 1.3), Math.ceil(s.length / 4));
};

// Realistic memory bodies — long, prose-heavy, the shape AWM actually stores.
const TOPICS = [
  ['auth magic-link rate limit', 'The magic-link endpoint rate limits to 5 requests per 15 minutes per email, enforced in AuthService.requestMagicLink() against the login_attempts table. Exceeding it returns 429 with a Retry-After header. This was added after a credential-stuffing probe in March filled the sessions table with dead rows.'],
  ['settlement run lock check', 'SettlementService.closeRun() enforces the LOCKED state server-side per schema/072-settlement-lock.sql. A client-only check previously allowed a direct API call to bypass the guard entirely, which is how run 2026-03 was closed twice.'],
  ['surcharge shorthand entry', 'The two-digit surcharge shorthand converts only when the value is a multiple of five, so 65 becomes 6.5 but 68 is rejected. Mouse focus does not select existing content, so typing into an already-filled box appends rather than replaces.'],
  ['depot slot release on cancel', 'Cancelling a consignment clears its slot_hold_until and releases depot_window rows by setting consignment_leg_id NULL and status open. Leg A and leg B routes are never released because the release is written as three hardcoded route comparisons.'],
  ['dispatch swap consignmentLegId', 'The conflicts-tab swap payload omits consignmentLegId, which the new-scheduler branch has required since the cancelled-consignment guard was added. Every swap on a new-scheduler depot therefore returns a 400 with No leg supplied for dispatch assignment.'],
  ['regional priority rule', 'Region EU2 priority requires a top-five ranking at one EU2 depot with five or more consignments inside the published window, and a current carrier agreement. The published criteria say nothing about partner or trial upgrades, unlike Region EU1.'],
  ['customs results export pipeline', 'Declaration outcomes reach the customs authority through a manual export tracked by results_sent_to_authority on tbl_declaration_authority_ids. It is a separate pipeline from the nightly aggregate qualifying-results export tables, and the two fail independently.'],
  ['duplicate charge rows root cause', 'Duplicate charge rows come from a non-atomic find-or-create that runs on invoice-screen load, combined with an ORM OneToOne mapping the schema never enforced with a unique index. Two tabs or a refresh race both insert.'],
];

// The bodies above are invented, in the fictional Harborview freight domain
// used by tests/realstore-eval/public-corpus.mjs. They were previously real
// memories from a private work store, naming real tables, stored procedures,
// business rules and one production incident. The eval measures token cost
// against realistic long prose; the domain is irrelevant to it, so there was
// never a reason for the fixture to carry someone's internal schema.

async function main() {
  console.log('Token-Budget Evaluation');
  console.log(`DB: ${DB_PATH}\n`);

  await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'tokbudget-eval', version: '1.0.0' },
  });

  // Seed
  process.stdout.write('Seeding memories');
  for (const [concept, content] of TOPICS) {
    await call('memory_write', {
      concept, content, project: 'Eval', topic: 'scoring',
      intent: 'finding', confidence_level: 'verified', memory_class: 'canonical',
    });
    process.stdout.write('.');
  }
  console.log(` ${TOPICS.length} written\n`);

  const QUERY = 'scoring entry problems and schedule slot handling';

  // Baseline: no budget
  const base = textOf(await call('memory_recall', { query: QUERY, limit: 8 }));
  const baseTok = estTokens(base);
  console.log('=== BASELINE (no max_tokens) ===');
  console.log(`  reply tokens: ${baseTok}`);
  console.log(`  footer: ${(base.match(/\[awm:[^\]]*\]/) ?? ['(none)'])[0]}\n`);

  // Budgeted runs
  console.log('=== BUDGETED ===');
  console.log('  budget   actual   kept   under?   savings vs baseline');
  const budgets = [1000, 600, 400, 250, 150, 80];
  const rows: any[] = [];
  for (const b of budgets) {
    const t = textOf(await call('memory_recall', { query: QUERY, limit: 8, max_tokens: b }));
    const tok = estTokens(t);
    const m = t.match(/(\d+)\/(\d+) results/);
    const kept = m ? `${m[1]}/${m[2]}` : 'all';
    const under = tok <= b ? 'yes' : 'NO';
    const saving = Math.round((1 - tok / baseTok) * 100);
    rows.push({ b, tok, kept, under, saving });
    console.log(`  ${String(b).padEnd(8)} ${String(tok).padEnd(8)} ${kept.padEnd(6)} ${under.padEnd(8)} ${saving}%`);
  }

  // Does the top-scored memory survive squeezing?
  console.log('\n=== TOP-RESULT RETENTION ===');
  const topConcept = (base.split('\n')[0].match(/\*\*(.+?)\*\*/) ?? [, ''])[1];
  let retained = 0;
  for (const b of budgets) {
    const t = textOf(await call('memory_recall', { query: QUERY, limit: 8, max_tokens: b }));
    if (topConcept && t.includes(topConcept)) retained++;
  }
  console.log(`  top result "${topConcept}" retained in ${retained}/${budgets.length} budgeted runs`);

  const overruns = rows.filter(r => r.under === 'NO');
  console.log('\n==================================================');
  console.log(overruns.length === 0
    ? 'PASS — no budget was exceeded'
    : `FAIL — ${overruns.length} budget overrun(s): ${overruns.map(o => o.b).join(', ')}`);
  console.log('==================================================');

  proc.kill();
  process.exit(overruns.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); proc.kill(); process.exit(1); });
