/**
 * Write-time questions from an EMBEDDED model (plan 0.22 §4.4, the "natural" profile): the same
 * fixed sample as wq-generate.ts (Claude Haiku), so wq-eval.ts can compare the two fairly.
 * Runs locally through transformers.js; nothing leaves the machine. Resumable.
 *
 *   npx tsx tests/realstore-eval/wq-generate-local.ts [model]
 *   default model onnx-community/Qwen2.5-0.5B-Instruct (q4) -> tests/realstore-eval/nl-wq-local.json
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from '@huggingface/transformers';

process.env.AWM_REDACT = 'mask'; process.env.AWM_REDACT_PII = 'mask';
const { redactText } = await import('../../src/core/redact.js');

const dir = import.meta.dirname;
const MODEL = process.argv[2] ?? 'onnx-community/Qwen2.5-0.5B-Instruct';
const OUT = join(dir, 'nl-wq-local.json');
// The fair sample is the first 1,994 ids of nl-wq.json's list: the 194 natural-language golds,
// then 1,800 random memories (wq-generate.ts's seeded order; widening it to the whole store later
// appended the rest, so the prefix is unchanged). WQ_SAMPLE overrides the size.
const sample = (JSON.parse(readFileSync(join(dir, 'nl-wq.json'), 'utf8')) as { sample: string[] }).sample
  .slice(0, Number(process.env.WQ_SAMPLE ?? 1994));
const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });
const get = db.prepare('SELECT concept, content FROM engrams WHERE id = ?');

const out: { model: string; sample: string[]; questions: Record<string, string[]>; ms: number[] } = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8')) : { model: MODEL, sample, questions: {}, ms: [] };

/** Keep lines that are questions; strip numbering and bullets; drop inline answers. */
export function parseQuestions(reply: string): string[] {
  return reply.split('\n')
    .map((l) => l.replace(/^[\s>*\-–•]*(\d+[.)]\s*)?/, '').trim())
    .filter((l) => l.endsWith('?') && l.length >= 12 && l.length <= 200)
    .slice(0, 3);
}

const gen = await pipeline('text-generation', MODEL, { dtype: 'q4' });
const todo = sample.filter((id) => !out.questions[id]?.length);
process.stderr.write(`${MODEL}: ${todo.length} of ${sample.length} to generate\n`);
let done = 0;
for (const id of todo) {
  const m: any = get.get(id);
  if (!m) continue;
  const text = redactText(`${m.concept}. ${m.content}`).text.slice(0, 1500);
  const messages = [{ role: 'user', content: `Here is a note from a team's memory:\n\n${text}\n\nWrite 3 short questions a colleague might ask later that this note answers, in plain words, without IDs or file names. One per line, no numbering, questions only.` }];
  const t0 = performance.now();
  const res: any = await gen(messages, { max_new_tokens: 90, do_sample: false });
  out.ms.push(Math.round(performance.now() - t0));
  out.questions[id] = parseQuestions(res[0].generated_text.at(-1).content as string);
  if (++done % 25 === 0) { writeFileSync(OUT, JSON.stringify(out)); process.stderr.write(`  ${done}/${todo.length}\n`); }
}
writeFileSync(OUT, JSON.stringify(out));
const ms = [...out.ms].sort((a, b) => a - b);
console.log(`questions for ${Object.values(out.questions).filter((q) => q.length).length} of ${sample.length}; median ${ms[Math.floor(ms.length / 2)]} ms per memory -> ${OUT}`);
