/**
 * Abstention evaluation — what should `require_confidence` default to?
 *
 * H3 in docs/archive/improvement-hypotheses-2026-08-23.md proposes making abstention the
 * default. That is a behaviour change with a real downside — abstain too eagerly
 * and AWM goes quiet on queries it could have answered — so the threshold should
 * come from measurement, not intuition. This sweeps it and prints the trade.
 *
 * GROUND TRUTH
 *   ON-TOPIC  queries each have exactly one memory that SHOULD be recalled.
 *   OFF-TOPIC queries have no correct answer at all; the right behaviour is
 *             silence, and anything returned is wasted tokens.
 *
 * METRICS (per threshold)
 *   hit rate        — on-topic queries where the expected memory came back
 *   false-answer    — off-topic queries that returned anything at all
 *   wasted tokens   — tokens spent on off-topic queries (pure loss)
 *   useful tokens   — tokens spent on on-topic queries that actually hit
 *   efficiency      — useful / (useful + wasted)
 *
 * Run: npx tsx tests/abstention-eval/runner.ts
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DB_PATH = join(tmpdir(), `awm-abstain-${Date.now()}.db`);
const MCP_SCRIPT = join(import.meta.dirname, '..', '..', 'src', 'mcp.ts');

let requestId = 1;
let buffer = '';
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

const proc = spawn(process.execPath, ['--import', 'tsx', MCP_SCRIPT], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AWM_DB_PATH: DB_PATH, AWM_AGENT_ID: 'abstain-eval' },
});
proc.stderr.on('data', () => {});
proc.stdout.on('data', (d: Buffer) => {
  buffer += d.toString();
  const lines = buffer.split('\n'); buffer = lines.pop()!;
  for (const line of lines) {
    const t = line.trim(); if (!t) continue;
    try { const m = JSON.parse(t); if (m.id && pending.has(m.id)) { pending.get(m.id)!.resolve(m); pending.delete(m.id); } } catch {}
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
const call = (n: string, a: any) => send('tools/call', { name: n, arguments: a });
const textOf = (r: any): string => r?.result?.content?.[0]?.text ?? '';
const est = (s: string) => Math.max(Math.ceil(s.split(/\s+/).filter(Boolean).length * 1.3), Math.ceil(s.length / 4));

/** [concept, content, a query that SHOULD find it] */
const SEEDS: Array<[string, string, string]> = [
  ['period close BLOCKED enforced server-side',
   'AccountingService.closePeriod() enforces the BLOCKED state server-side per schema/072-period-close.sql. A client-only check let a direct API call bypass it, which is how period 2026-03 was closed twice.',
   'why can an accounting period be closed twice'],
  ['magic-link rate limit 5 per 15 minutes',
   'The magic-link endpoint rate limits to 5 requests per 15 minutes per email in AuthService.requestMagicLink(), backed by the login_attempts table. Exceeding it returns 429 with Retry-After.',
   'what is the rate limit on magic link sign in'],
  ['state management standardised on Zustand',
   'The team standardised on Zustand for client state in January. Redux was rejected because the boilerplate outweighed the devtools benefit at this size. Do not reintroduce Redux.',
   'which state management library should I use here'],
  ['nightly export job builds qualifying results',
   'The nightly SQL Agent job rebuilds the qualifying-results export tables at 04:20. It drops and recreates them, so a mid-run read can see an empty table.',
   'when does the nightly results export run'],
  ['duplicate score rows come from create-on-load',
   'Duplicate score rows come from a non-atomic find-or-create that runs on scoring-screen load, combined with a OneToOne mapping the schema never enforced with a unique index. Two tabs race and both insert.',
   'why do we get duplicate score rows'],
  ['XC elimination toggle destroys the entry id',
   'patchValue on a bare FormControl replaces rather than merges, so toggling elimination wiped the division entry id and the next save 404d. Fixed by merging with setValue.',
   'what caused the cross country elimination bug'],
];

/** Queries with no correct answer in the store — silence is the right response. */
const OFF_TOPIC = [
  'best pasta recipe for a dinner party',
  'how do I train for a marathon in twelve weeks',
  'what is the weather forecast for Tuesday in Lisbon',
  'recommend a science fiction novel from the 1970s',
  'how do I repot an orchid without killing it',
  'what are the rules of cricket lbw',
];

const THRESHOLDS = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40];

async function main() {
  console.log('Abstention Evaluation — sweeping require_confidence');
  console.log(`DB: ${DB_PATH}\n`);
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'abstain-eval', version: '1' } });

  process.stdout.write('Seeding');
  for (const [concept, content] of SEEDS) {
    await call('memory_write', {
      concept, content, project: 'Eval', topic: 'eng',
      intent: 'finding', confidence_level: 'verified', memory_class: 'canonical',
    });
    process.stdout.write('.');
  }
  console.log(` ${SEEDS.length} memories, ${SEEDS.length} on-topic + ${OFF_TOPIC.length} off-topic queries\n`);

  console.log('  thresh   hit-rate    false-answer   useful tok   wasted tok   efficiency');
  console.log('  ' + '-'.repeat(74));

  const rows: any[] = [];
  for (const th of THRESHOLDS) {
    let hits = 0, usefulTok = 0, falseAnswers = 0, wastedTok = 0;

    for (const [concept, , query] of SEEDS) {
      const t = textOf(await call('memory_recall',
        th === 0 ? { query, limit: 5 } : { query, limit: 5, require_confidence: th }));
      const answered = !/No relevant memories found/i.test(t) && t.trim().length > 0;
      const hit = answered && t.includes(concept);
      if (hit) { hits++; usefulTok += est(t); }
      else if (answered) { wastedTok += est(t); }   // answered, but with the wrong thing
    }

    for (const query of OFF_TOPIC) {
      const t = textOf(await call('memory_recall',
        th === 0 ? { query, limit: 5 } : { query, limit: 5, require_confidence: th }));
      const answered = !/No relevant memories found/i.test(t) && t.trim().length > 0;
      if (answered) { falseAnswers++; wastedTok += est(t); }
    }

    const hitRate = hits / SEEDS.length;
    const falseRate = falseAnswers / OFF_TOPIC.length;
    const eff = usefulTok + wastedTok > 0 ? usefulTok / (usefulTok + wastedTok) : 1;
    rows.push({ th, hitRate, falseRate, usefulTok, wastedTok, eff, netSaved: 0 });
    console.log(
      `  ${String(th).padEnd(8)} ${(hitRate * 100).toFixed(0).padStart(3)}% (${hits}/${SEEDS.length})   ` +
      `${(falseRate * 100).toFixed(0).padStart(3)}% (${falseAnswers}/${OFF_TOPIC.length})     ` +
      `${String(usefulTok).padStart(6)}      ${String(wastedTok).padStart(6)}       ${(eff * 100).toFixed(0)}%`);
  }

  // ECONOMIC MODEL — the reason raw "efficiency" is the wrong objective.
  //
  // Efficiency (useful / (useful + wasted)) reaches 100% partly by GOING QUIET,
  // so maximising it drives toward muteness. It also treats a miss as free, and
  // a miss is not free: when AWM abstains the agent goes and reads the codebase
  // instead, which AWM's own benchmark measures at ~2,106 tokens per file
  // retrieval. So the real question is not "how pure are the answers" but "how
  // many tokens did AWM actually save net of the ones it wasted".
  //
  //   hit          -> saves the fallback, minus what the recall itself cost
  //   miss         -> agent pays the fallback anyway; AWM contributed nothing
  //   wrong answer -> costs its tokens AND saves nothing
  const FALLBACK_TOKENS = 2106;
  for (const r of rows) {
    const hits = r.hitRate * SEEDS.length;
    const avgHitCost = hits > 0 ? r.usefulTok / hits : 0;
    r.netSaved = Math.round(hits * (FALLBACK_TOKENS - avgHitCost) - r.wastedTok);
  }

  console.log('\n  thresh   net tokens SAVED (hits x fallback avoided, minus waste)');
  console.log('  ' + '-'.repeat(60));
  for (const r of rows) {
    const bar = '#'.repeat(Math.max(0, Math.round(r.netSaved / 250)));
    console.log(`  ${String(r.th).padEnd(8)} ${String(r.netSaved).padStart(7)}  ${bar}`);
  }

  // Best by net tokens saved, tie-broken by hit rate.
  const best = [...rows].sort((a, b) => (b.netSaved - a.netSaved) || (b.hitRate - a.hitRate))[0];
  const baseline = rows[0];

  console.log('\n=== READING ===');
  console.log(`  baseline (no abstention): hit ${(baseline.hitRate * 100).toFixed(0)}%, ` +
              `false-answer ${(baseline.falseRate * 100).toFixed(0)}%, efficiency ${(baseline.eff * 100).toFixed(0)}%`);
  console.log(`  best threshold by NET TOKENS SAVED: ${best.th} — hit ${(best.hitRate * 100).toFixed(0)}%, ` +
              `false-answer ${(best.falseRate * 100).toFixed(0)}%, net saved ${best.netSaved} tok ` +
              `(baseline ${baseline.netSaved})`);
  const tokDelta = baseline.wastedTok - best.wastedTok;
  console.log(`  wasted tokens avoided at best threshold: ${tokDelta} ` +
              `(${baseline.wastedTok > 0 ? ((tokDelta / baseline.wastedTok) * 100).toFixed(0) : '0'}% of baseline waste)`);
  const hitCost = baseline.hitRate - best.hitRate;
  console.log(`  hit-rate paid for it: ${(hitCost * 100).toFixed(0)} points` +
              `${hitCost <= 0 ? ' (none — strictly better)' : ''}`);

  console.log('\n  NOTE: this is a 6-memory store. Confidence is a distribution shape, so');
  console.log('  thresholds do NOT transfer directly to a 22k-engram store. Treat the SHAPE');
  console.log('  of the curve as the finding, not the absolute number.');

  proc.kill();
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e); proc.kill(); process.exit(1); });
