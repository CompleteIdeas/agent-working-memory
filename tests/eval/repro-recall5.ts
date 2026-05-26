/**
 * Recall@5 regression repro — trace one failing query end-to-end.
 *
 * Run: npx tsx tests/eval/repro-recall5.ts
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { embedBatch } from '../../src/core/embeddings.js';

interface Fact { id: string; concept: string; content: string; tags: string[]; }
interface Query { id: string; text: string; groundTruth: string[]; description: string; }

async function main() {
  const facts: Fact[] = JSON.parse(readFileSync(
    join(import.meta.dirname, 'fixtures/facts.json'), 'utf-8'));
  const queries: Query[] = JSON.parse(readFileSync(
    join(import.meta.dirname, 'fixtures/queries.json'), 'utf-8'));

  const tmp = mkdtempSync(join(tmpdir(), 'awm-repro-'));
  const store = new EngramStore(join(tmp, 'repro.db'));
  const activation = new ActivationEngine(store);

  console.log(`Embedding ${facts.length} facts (BGE-small)...`);
  const texts = facts.map(f => `${f.concept}: ${f.content}`);
  const embeddings = await embedBatch(texts);

  const idMap = new Map<string, string>();
  for (let i = 0; i < facts.length; i++) {
    const e = store.createEngram({
      agentId: 'repro',
      concept: facts[i].concept,
      content: facts[i].content,
      tags: facts[i].tags,
      embedding: embeddings[i],
    });
    idMap.set(facts[i].id, e.id);
  }
  console.log(`Inserted ${facts.length} facts.\n`);

  // Look at the first 5 queries — score breakdown for each
  for (let qi = 0; qi < 5; qi++) {
    const q = queries[qi];
    const truthFactId = q.groundTruth[0];
    const truthEngramId = idMap.get(truthFactId);

    console.log(`──── Query ${qi}: "${q.text.slice(0, 80)}"`);
    console.log(`     Truth fact id: ${truthFactId} → engram id ${truthEngramId}`);

    const results = await activation.activate({
      agentId: 'repro',
      context: q.text,
      limit: 10,
      useReranker: false,
      useExpansion: false,
      internal: true,
    });

    console.log(`     Returned ${results.length} results, confidence=${results[0]?.confidence?.toFixed(3) ?? 'n/a'}`);
    const truthRank = results.findIndex(r => r.engram.id === truthEngramId);
    console.log(`     Truth rank: ${truthRank >= 0 ? truthRank + 1 : 'NOT IN TOP-10'}`);

    // Top 5
    for (let i = 0; i < Math.min(5, results.length); i++) {
      const r = results[i];
      const isTruth = r.engram.id === truthEngramId ? ' ★' : '';
      const ps = r.phaseScores;
      console.log(`     ${i + 1}.${isTruth} [${r.score.toFixed(3)}] ${r.engram.concept} — text=${ps.textMatch.toFixed(2)} vec=${ps.vectorMatch.toFixed(2)} decay=${ps.decayScore.toFixed(2)} graph=${ps.graphBoost.toFixed(2)} reranker=${ps.rerankerScore.toFixed(2)}`);
    }

    // If truth not in top 5, show truth's rank and score
    if (truthRank >= 5 || truthRank < 0) {
      const truthHit = results.find(r => r.engram.id === truthEngramId);
      if (truthHit) {
        const ps = truthHit.phaseScores;
        console.log(`     TRUTH at rank ${truthRank + 1}: [${truthHit.score.toFixed(3)}] text=${ps.textMatch.toFixed(2)} vec=${ps.vectorMatch.toFixed(2)} decay=${ps.decayScore.toFixed(2)} graph=${ps.graphBoost.toFixed(2)} reranker=${ps.rerankerScore.toFixed(2)}`);
      } else {
        console.log(`     TRUTH MISSING from top-10 entirely`);
      }
    }
    console.log();
  }

  store.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
}

main().catch(err => { console.error(err); process.exit(1); });
