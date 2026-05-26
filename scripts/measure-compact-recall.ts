/**
 * Measure test:tokens with granularity:'compact' against current MAX combine rule.
 *
 * Runs the full test:tokens corpus + recall challenges, but requests
 * `granularity: 'compact'` and uses the `summary` field instead of full content.
 * Compares against full-content baseline.
 *
 * Run: npx tsx scripts/measure-compact-recall.ts <baseUrl>
 *      (defaults to http://localhost:8400)
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const TMP_DIR = join(tmpdir(), 'awm-compact-measure');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

let reqCounter = 0;
async function api(method: string, path: string, body?: any): Promise<any> {
  await new Promise(r => setTimeout(r, 20));
  const url = `${BASE_URL}${path}`;
  let cmd = `curl -sf -X ${method}`;
  if (body) {
    const tmpFile = join(TMP_DIR, `req_${reqCounter++}.json`);
    writeFileSync(tmpFile, JSON.stringify(body));
    cmd += ` -H "Content-Type: application/json" -d @"${tmpFile.replace(/\\/g, '/')}"`;
  }
  cmd += ` "${url}"`;
  const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
  return JSON.parse(result);
}

const estTokens = (s: string) => Math.ceil(s.length / 4);

// Pull TURNS + CHALLENGES from the real runner
const runnerSrc = readFileSync(join(import.meta.dirname, '..', 'tests', 'token-savings', 'runner.ts'), 'utf-8');
const hMatch = runnerSrc.match(/const CONVERSATION_HISTORY: ConversationTurn\[\] = \[([\s\S]+?)\n\];/);
if (!hMatch) throw new Error('CONVERSATION_HISTORY not found');
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const TURNS: Array<{ role: string; content: string; task: string }> = new Function(`return [${hMatch[1]}\n];`)();
const cMatch = runnerSrc.match(/const RECALL_CHALLENGES[^=]*=\s*\[([\s\S]+?)\n\];/);
if (!cMatch) throw new Error('RECALL_CHALLENGES not found');
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const CHALLENGES: Array<{ name: string; query: string; expectedKeywords: string[] }> = new Function(`return [${cMatch[1]}\n];`)();

async function main() {
  const reg = await api('POST', '/agent/register', { name: 'compact-measure' });
  const agentId = reg.id;
  console.log('Agent: ' + agentId);

  // Seed
  for (const t of TURNS) {
    const hasFact = t.content.length > 80;
    const hasDecision = /decided|chose|use|implement|create|add|set up|switch|replace/i.test(t.content);
    const hasNumber = /\d+/.test(t.content);
    await api('POST', '/memory/write', {
      agentId,
      concept: `${t.task} ${t.role} conversation`,
      content: t.content,
      tags: [t.task, t.role],
      eventType: hasDecision ? 'decision' : hasFact ? 'causal' : 'observation',
      surprise: hasDecision ? 0.6 : hasNumber ? 0.5 : 0.3,
      causalDepth: hasDecision ? 0.7 : hasFact ? 0.6 : 0.3,
      resolutionEffort: hasFact ? 0.5 : 0.3,
      decisionMade: hasDecision,
    });
  }
  await new Promise(r => setTimeout(r, 2500));

  // Run challenges in two modes — full content vs compact summary
  console.log('\nChallenge       | mode    | tokens | kw match');
  console.log('----------------+---------+--------+---------');
  let fullTok = 0, compactTok = 0, fullKw = 0, compactKw = 0, totalKw = 0;
  for (const ch of CHALLENGES) {
    const resFull = await api('POST', '/memory/activate', { agentId, context: ch.query, limit: 5, includeStaging: true });
    const resCompact = await api('POST', '/memory/activate', { agentId, context: ch.query, limit: 5, includeStaging: true, granularity: 'compact' });

    const fullCtx = (resFull.results ?? []).map((r: any) => r.engram?.content ?? '').join('\n');
    const compactCtx = (resCompact.results ?? []).map((r: any) => r.summary ?? r.engram?.content ?? '').join('\n');

    const ft = estTokens(fullCtx), ct = estTokens(compactCtx);
    fullTok += ft; compactTok += ct;

    let fkw = 0, ckw = 0;
    for (const kw of ch.expectedKeywords) {
      if (fullCtx.toLowerCase().includes(kw.toLowerCase())) fkw++;
      if (compactCtx.toLowerCase().includes(kw.toLowerCase())) ckw++;
    }
    fullKw += fkw; compactKw += ckw; totalKw += ch.expectedKeywords.length;

    console.log(
      ch.name.padEnd(15) + ' | full    | ' + String(ft).padStart(6) + ' | ' + fkw + '/' + ch.expectedKeywords.length
    );
    console.log(
      ch.name.padEnd(15) + ' | compact | ' + String(ct).padStart(6) + ' | ' + ckw + '/' + ch.expectedKeywords.length
    );
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Full mode:    ${fullTok} tokens, ${fullKw}/${totalKw} keywords (${(fullKw/totalKw*100).toFixed(1)}%)`);
  console.log(`Compact mode: ${compactTok} tokens, ${compactKw}/${totalKw} keywords (${(compactKw/totalKw*100).toFixed(1)}%)`);
  console.log(`Token reduction: ${((1 - compactTok/fullTok) * 100).toFixed(1)}%`);
  console.log(`Accuracy delta: ${((compactKw - fullKw)/totalKw * 100).toFixed(1)}pp`);
}

main().catch(err => { console.error(err); process.exit(1); });
