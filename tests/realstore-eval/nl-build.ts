/**
 * Natural-language fixture, step 3: vet the written questions mechanically and build
 * fixture-nl.json, which runner.ts (REALSTORE_FIXTURE=fixture-nl.json) and baselines.ts read as-is.
 *
 * The writer saw each answer while writing its question, which is exactly how a fixture ends
 * up keyword-shaped. So a question is kept only if, checked against the STORE rather than the
 * writer's word:
 *   - it uses at most one word that occurs in ≤ 3 memories (store-rare), whatever the writer said
 *   - it carries no identifier-shaped token (path, dotted name, snake_case, digits-in-word, URL)
 *   - its answer quote is a literal substring of the gold memory
 *
 *   npx tsx tests/realstore-eval/nl-build.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dirname;
const cands = JSON.parse(readFileSync(join(dir, 'nl-candidates.json'), 'utf8')) as Array<{ goldId: string; agent: string; content: string; memoryClass: string }>;
const qs = JSON.parse(readFileSync(join(dir, 'nl-questions.json'), 'utf8')) as Array<any>;
const rare = JSON.parse(readFileSync(join(dir, 'nl-df.json'), 'utf8')) as Record<string, number>;
const byId = new Map(cands.map((c) => [c.goldId, c]));

const STOP = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that not but all any can will would should could into than then there their they them its also only just more most some such very via per use used using new now one two'.split(' '));
const IDENTIFIER = /[\\/]|\b\w+\.\w+\.\w+\b|\b[a-z]+_[a-z0-9_]+\b|\b[a-z]*\d+[a-z]+\w*\b|\bhttps?:|\b[a-z]+[A-Z]\w*\b/;

const kept: any[] = [], rejected: Array<{ goldId: string; why: string; question?: string }> = [];
for (const q of qs) {
  if (q.skipped) { rejected.push({ goldId: q.goldId, why: `skipped by writer: ${q.skipped}` }); continue; }
  const c = byId.get(q.goldId);
  if (!c) { rejected.push({ goldId: q.goldId, why: 'unknown goldId' }); continue; }
  const words = (q.question.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? []).map((t: string) => t.replace(/[._-]+$/, '')).filter((t: string) => t.length >= 3 && !STOP.has(t));
  const rareUsed = [...new Set(words.filter((w: string) => rare[w] !== undefined))];
  if (rareUsed.length > 1) { rejected.push({ goldId: q.goldId, why: `uses ${rareUsed.length} store-rare words`, question: q.question }); continue; }
  if (IDENTIFIER.test(q.question)) { rejected.push({ goldId: q.goldId, why: 'identifier-shaped token', question: q.question }); continue; }
  if (!q.answerQuote || !c.content.includes(q.answerQuote)) { rejected.push({ goldId: q.goldId, why: 'answer quote not in the memory', question: q.question }); continue; }
  kept.push({ query: q.question, goldId: q.goldId, agent: c.agent, memoryClass: c.memoryClass, form: q.form, rareWordsInQuery: rareUsed.length });
}

writeFileSync(join(dir, 'fixture-nl.json'), JSON.stringify({
  note: 'Natural-language questions written per gold memory, then vetted against the store: ≤1 store-rare word (df ≤ 3), no identifier-shaped tokens, answer quote verified in the gold. Built by nl-sample.ts → (writer) → nl-build.ts.',
  generated: new Date().toISOString(), answerable: kept.length, items: kept, rejected,
}, null, 1));
const forms = kept.reduce((m: Record<string, number>, k) => ((m[k.form] = (m[k.form] ?? 0) + 1), m), {});
console.log(`kept ${kept.length} · rejected ${rejected.length}`);
console.log(`forms: ${JSON.stringify(forms)} · zero store-rare words: ${kept.filter((k) => k.rareWordsInQuery === 0).length}`);
const why = rejected.reduce((m: Record<string, number>, r) => { const k = r.why.replace(/\d+/, 'N').replace(/: .*/, ''); m[k] = (m[k] ?? 0) + 1; return m; }, {});
console.log(`rejections: ${JSON.stringify(why)}`);
