/**
 * Instrument the salience filter on both backends.
 *
 * Drives the same 6-turn auth+db corpus into SQLite + PGlite via the actual
 * write-pipeline, and on each write logs:
 *   - the top BM25 score returned by computeNoveltyWithMatch
 *   - the computed novelty
 *   - the final salience score + disposition
 *
 * This tells us WHERE in the pipeline the two backends diverge.
 *
 * Run: npx tsx scripts/trace-salience.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { PGliteEngramStore } from '../src/storage/pglite.js';
import { computeNoveltyWithMatch, evaluateSalience } from '../src/core/salience.js';
import { embed } from '../src/core/embeddings.js';

const AGENT = 'salience-trace';

const TURNS: Array<{ concept: string; content: string }> = [
  { concept: 'user: How should we handle JWT for the API?', content: 'How should we handle JWT for the API?' },
  { concept: 'assistant: For JWT, use HS256 algorithm.', content: 'For JWT, use HS256 algorithm. Access tokens expire in 15 minutes, refresh tokens in 7 days. Store refresh tokens in HttpOnly cookies with sameSite=strict. Validate signature on every request via middleware.' },
  { concept: 'user: Should we add rate limiting to the auth endpoints?', content: 'Should we add rate limiting to the auth endpoints?' },
  { concept: 'assistant: Yes, critical for auth endpoints.', content: 'Yes, critical for auth endpoints. Use express-rate-limit with these limits: /auth/login: 5 attempts per 15 minutes per IP, /auth/refresh: 10 per minute, /auth/register: 3 per hour.' },
  { concept: 'user: What about RBAC for the admin panel?', content: 'What about RBAC for the admin panel?' },
  { concept: 'assistant: Implement role-based access control.', content: 'Implement role-based access control with these roles: admin (full access), editor (CRUD on content), viewer (read-only). Use authorize() middleware that checks JWT claims for role.' },
];

async function trace(label: string, factory: () => Promise<{ store: any; close: () => Promise<void> | void }>) {
  console.log('\n====== ' + label + ' ======');
  console.log('seq | bm25Top | novelty | salience | dispo    | concept');
  console.log('----+---------+---------+----------+----------+---------------------------------');
  const { store, close } = await factory();
  for (let i = 0; i < TURNS.length; i++) {
    const t = TURNS[i];
    // Pre-embed the same way write-pipeline.ts does in v0.8.5+
    const vec = await embed(`${t.concept} ${t.content}`);
    // Run the novelty check the same way write-pipeline.ts does
    const novelty = await computeNoveltyWithMatch(store, AGENT, t.concept, t.content, null, vec);

    // Run the salience eval with default features (matches write-pipeline)
    const salience = evaluateSalience({
      content: t.content,
      eventType: 'observation',
      surprise: 0.3,
      decisionMade: false,
      causalDepth: 0.3,
      resolutionEffort: 0.3,
      novelty: novelty.novelty,
    });

    console.log(
      String(i + 1).padStart(3) + ' | ' +
      novelty.matchScore.toFixed(3) + '   | ' +
      novelty.novelty.toFixed(3) + '   | ' +
      salience.score.toFixed(3) + '    | ' +
      salience.disposition.padEnd(8) + ' | ' +
      t.concept.slice(0, 50),
    );

    // Persist the engram so subsequent novelty checks see it.
    // Also store the embedding so the next iteration's cosine channel
    // has something to search against (matches write-pipeline.ts behavior).
    await store.createEngram({
      agentId: AGENT,
      concept: t.concept,
      content: t.content,
      salience: salience.score,
      confidence: 0.45,
      salienceFeatures: salience.features,
      embedding: vec,
    });
  }
  await close();
}

async function main() {
  await trace('SQLite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-sal-sq-'));
    const store = new EngramStore(join(tmp, 'test.db'));
    return {
      store, close: () => {
        store.close();
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      },
    };
  });

  await trace('PGlite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awm-sal-pg-'));
    const store = new PGliteEngramStore(join(tmp, 'pg'));
    await store.ready();
    return {
      store, close: async () => {
        await store.close();
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      },
    };
  });
}

main().catch(err => { console.error(err); process.exit(1); });
