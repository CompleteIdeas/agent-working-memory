/**
 * Write-time questions, step 1: for a fixed SAMPLE store, ask a small model for the natural
 * questions each memory answers, as a writing agent would at save time.
 *
 * Fairness: every memory in the sample gets questions, not only the golds. The sample is the
 * natural-language fixture's golds plus random memories of the same agents (seeded), and both
 * arms of wq-eval.ts search exactly this sample.
 *
 * Privacy: memory text goes through AWM's own redaction (secrets and contact details masked)
 * before it leaves the machine. Output is gitignored (tests/realstore-eval/nl-*.json).
 *
 * Known bias, stated up front: fixture-nl.json was also written by a model that saw each gold
 * memory, so generated questions may resemble the fixture's more than a real user's would.
 * The prompt here differs, and wq-eval.ts reports the overlap so it can be judged.
 *
 *   CIDEAS key read from the user environment; npx tsx tests/realstore-eval/wq-generate.ts [N_OTHERS]
 *   -> tests/realstore-eval/nl-wq.json
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AWM_REDACT = 'mask'; process.env.AWM_REDACT_PII = 'mask';
const { redactText } = await import('../../src/core/redact.js');

const dir = import.meta.dirname;
const OUT = join(dir, 'nl-wq.json');
const N_OTHERS = Number(process.argv[2] ?? 1800);
const MODEL = 'claude-haiku-5-5';
const key = process.env.CIDEAS_ANTHROPIC_API_KEY
  ?? execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('CIDEAS_ANTHROPIC_API_KEY','User')"], { encoding: 'utf8' }).trim();
if (!key) throw new Error('CIDEAS_ANTHROPIC_API_KEY not set');

const nl = JSON.parse(readFileSync(join(dir, 'fixture-nl.json'), 'utf8'));
const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });
const pool = db.prepare(`SELECT id, agent_id, concept, content FROM engrams WHERE agent_id IN ('work','personal')
  AND stage = 'active' AND retracted = 0 AND (superseded_by IS NULL OR superseded_by = '') ORDER BY id`).all() as Array<{ id: string; agent_id: string; concept: string; content: string }>;
const golds = new Set((nl.items as any[]).map((i) => i.goldId));
let x = 20261031;
const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
const others = pool.filter((m) => !golds.has(m.id)).map((m) => ({ m, r: rnd() })).sort((a, b) => a.r - b.r).slice(0, N_OTHERS).map((o) => o.m);
const sample = [...pool.filter((m) => golds.has(m.id)), ...others];

const out: { model: string; sample: string[]; questions: Record<string, string[]> } = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8')) : { model: MODEL, sample: sample.map((m) => m.id), questions: {} };
out.sample = sample.map((m) => m.id);

const PROMPT = (concept: string, content: string) => `You are saving a note to your long-term memory. Later, someone may ask about it in ordinary words, without remembering its exact wording, file names or identifiers.

Write exactly 3 short questions this note answers, the way a colleague would actually ask them: plain conversational language, no IDs, no file paths, no quoting distinctive words from the note. Vary them: what happened or was decided, why, and a practical "how do I / where is" question if the note supports one.

Note title: ${concept}
Note:
${content.slice(0, 3000)}

Reply with the 3 questions only, one per line, no numbering.`;

async function ask(concept: string, content: string): Promise<string[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: PROMPT(concept, content) }] }),
    });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j: any = await res.json();
    const text: string = j.content?.map((c: any) => c.text ?? '').join('') ?? '';
    return text.split('\n').map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim()).filter((l) => l.length > 8).slice(0, 3);
  }
  throw new Error('API retries exhausted');
}

const todo = sample.filter((m) => !out.questions[m.id]?.length);
process.stderr.write(`sample ${sample.length} (${golds.size} golds) · to generate ${todo.length}\n`);
const CONC = 6;
let done = 0;
for (let i = 0; i < todo.length; i += CONC) {
  await Promise.all(todo.slice(i, i + CONC).map(async (m) => {
    const c = redactText(m.concept).text, b = redactText(m.content).text;
    out.questions[m.id] = await ask(c, b);
  }));
  done += Math.min(CONC, todo.length - i);
  if (done % 120 < CONC) { writeFileSync(OUT, JSON.stringify(out)); process.stderr.write(`  ${done}/${todo.length}\n`); }
}
writeFileSync(OUT, JSON.stringify(out));
console.log(`questions for ${Object.keys(out.questions).length} memories -> ${OUT}`);
