/**
 * Natural-language fixture, step 1: a deterministic sample of gold memories to write questions for.
 *
 * Both existing fixtures are keyword-shaped (identifiers, topic words), and the identifier
 * one is BM25-friendly by construction. This samples memories a person would plausibly ask
 * about — substantial (≥ 200 chars), retrievable, canonical or working, both agents — and
 * writes them, with each memory's RARE words (df ≤ 3 in the store), to nl-candidates.json so
 * the question writer can be told which words it must not lean on.
 *
 *   npx tsx tests/realstore-eval/nl-sample.ts [n=220]
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const N = Number(process.argv[2] ?? 220);
const db = new Database(join(import.meta.dirname, 'snapshot', 'store.db'), { readonly: true });
const STOP = new Set('the a an and or of to in on for is are was were be been with what when where which who how did do does have has had at by from as it this that not but all any can will would should could into than then there their they them its also only just more most some such very via per use used using new now one two'.split(' '));
// Trailing punctuation is stripped: 'api.' at a sentence end is the word 'api', and counting it
// separately understated how common ordinary words are.
const tok = (s: string) => (s.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? []).map((t) => t.replace(/[._-]+$/, '')).filter((t) => t.length >= 3 && !STOP.has(t));

const rows = db.prepare(`SELECT id, agent_id, concept, content, memory_class FROM engrams
  WHERE stage = 'active' AND retracted = 0 AND (superseded_by IS NULL OR superseded_by = '')
    AND agent_id IN ('work', 'personal') AND memory_class IN ('canonical', 'working')
    AND length(content) >= 200`).all() as Array<{ id: string; agent_id: string; concept: string; content: string; memory_class: string }>;

const df = new Map<string, number>();
for (const r of db.prepare(`SELECT concept, content FROM engrams WHERE stage = 'active' AND retracted = 0`).all() as any[]) {
  for (const t of new Set(tok(`${r.concept} ${r.content}`))) df.set(t, (df.get(t) ?? 0) + 1);
}
db.close();

// Deterministic sample: LCG shuffle, seed fixed so the fixture can be rebuilt.
let x = 20261030;
const a = [...rows];
for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
const sample = a.slice(0, N).map((r) => ({
  goldId: r.id, agent: r.agent_id, memoryClass: r.memory_class, concept: r.concept,
  content: r.content.slice(0, 1500),
  rareWords: [...new Set(tok(`${r.concept} ${r.content}`))].filter((t) => (df.get(t) ?? 0) <= 3).slice(0, 40),
}));
writeFileSync(join(import.meta.dirname, 'nl-candidates.json'), JSON.stringify(sample, null, 1));
writeFileSync(join(import.meta.dirname, 'nl-df.json'), JSON.stringify(Object.fromEntries([...df].filter(([, n]) => n <= 3))));
console.log(`pool ${rows.length} · sampled ${sample.length} · work ${sample.filter((s) => s.agent === 'work').length} / personal ${sample.filter((s) => s.agent === 'personal').length}`);
