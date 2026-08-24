/**
 * Can the small LLM already in AWM do write-time categorisation?
 *
 * AWM already loads Xenova/flan-t5-small (~80MB ONNX) for query expansion, so
 * using it for categorisation costs no new dependency, no network, no money —
 * the deployment cost is already paid. The open question is CAPABILITY: 80M
 * params is small, and the failure mode that matters is confident nonsense.
 *
 * The target problem, measured on the live store: 94.3% of tagged memories are
 * missing at least one of their own topical terms from the body, and 66.2% of
 * those terms never appear in the text. That is what made a real memory
 * ("private plan memory peaked 88%, scale P1v3 -> P2v3") unreachable by the
 * words its author actually used to ask for it ("azure app service plan
 * capacity") — it was not in the top 40 candidates.
 *
 * Two prompting strategies are compared, because they have very different
 * expected reliability on a model this size:
 *   OPEN   — "what system/product is this about?" (free generation; flexible,
 *            but small models hallucinate plausible-sounding nouns)
 *   CHOICE — pick from a fixed label set mined from the store's existing topic
 *            tags (classification; much easier for an 80M model, and it cannot
 *            invent a category that does not exist in this domain)
 *
 * Scored against ground truth that already exists: the topical tags the author
 * attached but never wrote into the body. If the model recovers those, it is
 * doing the job. Latency is reported because this only makes sense at WRITE
 * time if it stays off the critical path.
 *
 * Run: npx tsx tests/realstore-eval/flan-category-probe.ts
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';
// getExpander(), not expandQuery(): the latter has a skip heuristic that bails
// on long/complex input, so it silently returned the prompt unchanged and the
// first version of this probe measured nothing at 0ms.
import { getExpander } from '../../src/core/query-expander.js';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const db = new Database(SNAP, { readonly: true });

// Label set mined from the store itself — the domain's real category vocabulary.
const tagRows = db.prepare(`
  SELECT tags FROM engrams
  WHERE stage='active' AND retracted=0 AND agent_id IN ('work','personal') AND tags IS NOT NULL
`).all() as Array<{ tags: string }>;
const freq = new Map<string, number>();
for (const r of tagRows) {
  let t: string[] = [];
  try { t = JSON.parse(r.tags); } catch { continue; }
  for (const tag of t) {
    const m = /^(?:topic|proj|project)=(.+)$/.exec(tag);
    if (!m) continue;
    for (const w of m[1].toLowerCase().split(/[-_\s]+/)) {
      if (w.length > 3) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
}
const LABELS = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([w]) => w);
console.log(`label set mined from store (top ${LABELS.length}):`);
console.log('  ' + LABELS.join(', ') + '\n');

// Probe memories: real ones whose tag terms are missing from the body — i.e.
// exactly the population this would need to fix.
const probes = db.prepare(`
  SELECT id, concept, content, tags FROM engrams
  WHERE stage='active' AND retracted=0 AND agent_id IN ('work','personal')
    AND memory_class='canonical' AND LENGTH(content) > 500
  ORDER BY created_at DESC LIMIT 12
`).all() as Array<{ id: string; concept: string; content: string; tags: string }>;

const missingTerms = (r: typeof probes[0]) => {
  let t: string[] = [];
  try { t = JSON.parse(r.tags ?? '[]'); } catch { /* */ }
  const body = `${r.concept} ${r.content}`.toLowerCase();
  return [...new Set(t.filter(x => /^(?:topic|proj|project)=/.test(x))
    .flatMap(x => x.split('=')[1].toLowerCase().split(/[-_\s]+/))
    .filter(w => w.length > 3 && !body.includes(w)))];
};

const pipe = await getExpander();
async function ask(prompt: string): Promise<{ out: string; ms: number }> {
  const t0 = process.hrtime.bigint();
  const r: any = await pipe(prompt, { max_new_tokens: 12, no_repeat_ngram_size: 2 });
  const out = Array.isArray(r) ? (r[0]?.generated_text ?? '') : '';
  return { out: String(out).trim(), ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

let openHits = 0, choiceHits = 0, scored = 0, openMs = 0, choiceMs = 0;
for (const p of probes) {
  const missing = missingTerms(p);
  const snippet = `${p.concept}. ${p.content.slice(0, 320)}`;

  const open = await ask(`What system or product is this note about? Answer with one or two words. Note: ${snippet} Answer:`);
  const choice = await ask(`Which category best fits this note? Options: ${LABELS.slice(0, 12).join(', ')}. Note: ${snippet} Category:`);
  openMs += open.ms; choiceMs += choice.ms;

  if (missing.length) {
    scored++;
    const o = open.out.toLowerCase(), c = choice.out.toLowerCase();
    if (missing.some(m => o.includes(m))) openHits++;
    if (missing.some(m => c.includes(m))) choiceHits++;
  }

  console.log(`  ${p.concept.slice(0, 46)}`);
  console.log(`     missing from body: [${missing.slice(0, 5).join(', ') || '(none)'}]`);
  console.log(`     OPEN   -> "${open.out.slice(0, 52)}"  (${open.ms.toFixed(0)}ms)`);
  console.log(`     CHOICE -> "${choice.out.slice(0, 52)}"  (${choice.ms.toFixed(0)}ms)`);
}

console.log(`\n=== recovers a genuinely missing category term (${scored} scorable probes) ===`);
console.log(`  OPEN   ${openHits}/${scored}   avg ${(openMs / probes.length).toFixed(0)}ms`);
console.log(`  CHOICE ${choiceHits}/${scored}   avg ${(choiceMs / probes.length).toFixed(0)}ms`);
console.log(`\n  (write path already costs ~300ms for embedding, so anything under ~200ms is affordable at WRITE time;`);
console.log(`   recall is ~900ms warm and already 90% reranker, so read-time use is a much harder sell.)`);
db.close();
