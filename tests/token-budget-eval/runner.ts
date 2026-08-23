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
  ['period close BLOCKED check', 'AccountingService.closePeriod() enforces the BLOCKED state server-side per schema/072-period-close.sql. A client-only check previously allowed a direct API call to bypass the guard entirely, which is how period 2026-03 was closed twice.'],
  ['dressage score entry shorthand', 'The two-digit dressage shorthand converts only when the value is a multiple of five, so 65 becomes 6.5 but 68 is rejected. Mouse focus does not select existing content, so typing into an already-scored box appends rather than replaces.'],
  ['schedule slot release on scratch', 'Scratching an entry clears its pinny and releases schedule_slot rows by setting division_entry_id NULL and status open. Phase A and phase B disciplines are never released because the release is written as three hardcoded discipline comparisons.'],
  ['ride time swap divisionEntryId', 'The conflicts-tab swap payload omits divisionEntryId, which the new-scheduler branch has required since the scratched-entry guard was added. Every swap on a new-scheduler event therefore returns a 400 with No entry supplied for ride-time assignment.'],
  ['area championship placing rule', 'Area VII qualification requires a top-five placing at one Area VII event with five or more starters inside the published window, and current USEA membership. The published criteria say nothing about amateur or junior upgrade placings, unlike Area 1.'],
  ['USEF results export pipeline', 'Competition results reach USEF through a manual export tracked by results_sent_to_USEF on tbl_USEA_USEF_event_ids. It is a separate pipeline from the nightly AEC qualifying-results export tables, and the two fail independently.'],
  ['duplicate score rows root cause', 'Duplicate score rows come from a non-atomic find-or-create that runs on scoring-screen load, combined with a JPA OneToOne mapping the schema never enforced with a unique index. Two tabs or a refresh race both insert.'],
];

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
