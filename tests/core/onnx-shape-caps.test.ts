/**
 * Input-shape caps for the ONNX models (2026-10-16).
 *
 * onnxruntime-node's CPU arena keeps the largest tensor a model has ever run, so the
 * caps bound process memory. These tests pin the two things the caps must NOT change
 * (chunking leaves scores and vectors alone) and the one thing the query cap MUST change:
 * a long query used to push every passage out of the cross-encoder's 512-token window.
 *
 * Run: npx vitest run tests/core/onnx-shape-caps.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { AutoTokenizer, type PreTrainedTokenizer } from '@huggingface/transformers';
import { capRerankQuery, inProcessRerank } from '../../src/core/reranker.js';
import { inProcessEmbed } from '../../src/core/embeddings.js';

const PASSAGES = [
  'Stripe live keys move real money; store them only in Windows user environment variables.',
  'RosterKeep medical alerts are encrypted at rest with AES-256-GCM under MEDICAL_ENCRYPTION_KEY.',
  'The cross-encoder is ms-marco-MiniLM-L-6-v2 and is most of warm recall latency.',
  'Cloudflare R2 bucket roster-keep-com is private and served only through presigned URLs.',
  'NovelForge chapter redrafts need about 8.7k tokens of prose for the longest chapter.',
  'SQLite in WAL mode lets several Claude Code sessions open the same memory store.',
  'The demo tenant was rebuilt with three seasons and data behind every shipped feature.',
  'Deploy target: the PostRoom app is deployed to Railway with railway up from a Dockerfile build.',
  'Magic-link sign-in uses the www host as its canonical base URL.',
  'Consolidation runs on a sleep schedule instead of in the middle of recall traffic.',
  'Hook sidecars bind the first free port in 8401-8410 and match agentId on /health.',
  'PGlite is single-process only; a second MCP process aborts against the same directory.',
  'Query expansion with flan-t5-small is skipped for queries longer than fifty characters.',
  'BM25 indexes the tags, but the embedding sees only concept and content.',
  'The prime hook injects recalled memories that clear a confidence gate on each prompt.',
  'Abstention withholds results when the score distribution has no clear winner.',
  'Rate limiting applies per agent on the HTTP API.',
  'The public benchmark corpus is the only suite with recall headroom left.',
  'Railway project rowos hosts the rowos-app service for RosterKeep.',
  'The installer picks SQLite by default and PGlite only when asked.',
];
// The answer sits mid-list: with flat scores a stable sort keeps index order, so a gold at
// index 0 would 'win' a tie and hide exactly the failure these tests exist to catch.
const GOLD = PASSAGES.findIndex(p => p.startsWith('Deploy target'));

// ~700 tokens of unrelated paste, the shape the prime hook sends when a prompt carries a log.
const PASTE = Array.from({ length: 70 }, (_, i) =>
  `line ${i}: INFO worker heartbeat ok queue=${i * 7} latency_ms=${(i * 13) % 97} status=green`).join('\n');

let tok: PreTrainedTokenizer;
beforeAll(async () => {
  tok = await AutoTokenizer.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2');
}, 120_000);

describe('capRerankQuery', () => {
  it('returns a query under the cap unchanged', () => {
    const q = 'which platform hosts the PostRoom deploy?';
    expect(capRerankQuery(tok, q, 128)).toBe(q);
  });

  it('keeps the first and last halves of a long query, at about the cap', () => {
    const q = `alphaquestion about the deploy\n${PASTE}\nomegaquestion where does it run`;
    const capped = capRerankQuery(tok, q, 128);
    // Re-encoding a decoded split can shift a word boundary by a token or two.
    expect(tok.encode(capped, { add_special_tokens: false }).length).toBeLessThanOrEqual(130);
    expect(capped).not.toMatch(/(^|\s)##/);
    expect(capped).toMatch(/alphaquestion about the deploy/);
    expect(capped).toMatch(/omegaquestion where does it run/);
    expect(capped).not.toMatch(/line 35:/);
  });

  it('0 disables the cap', () => {
    const q = `start ${PASTE} end`;
    expect(capRerankQuery(tok, q, 0)).toBe(q);
  });
});

describe('rerank chunking', () => {
  it('scores in chunks of 8 match one 20-pair batch', async () => {
    const q = 'which platform hosts the PostRoom deploy?';
    const one = await inProcessRerank({ query: q, passages: PASSAGES }, { batch: 0, queryTokens: 0 });
    const chunked = await inProcessRerank({ query: q, passages: PASSAGES }, { batch: 8, queryTokens: 0 });
    expect(chunked.map(r => r.index)).toEqual(one.map(r => r.index));
    const byIndex = new Map(one.map(r => [r.index, r.score]));
    for (const r of chunked) expect(Math.abs(r.score - byIndex.get(r.index)!)).toBeLessThan(1e-5);
    expect(chunked[0].index).toBe(GOLD);
  }, 120_000);
});

describe('long queries (the ranking bug the query cap fixes)', () => {
  it('finds the answer when the question comes before a long paste', async () => {
    const query = `Where is the PostRoom app deployed — which hosting platform?\n${PASTE}`;
    const capped = await inProcessRerank({ query, passages: PASSAGES }, { queryTokens: 128 });
    expect(capped[0].index).toBe(GOLD);
    expect(capped[0].score - capped[1].score).toBeGreaterThan(0.1);
  }, 120_000);

  it('reads the passages again when the question comes after a long paste', async () => {
    // Weaker than the case above, and measured so: on 100 real-store fixture queries with a
    // ~600-token paste in FRONT of the question, the cap took success@1 from 7% to 26%
    // (21 queries better, 0 worse), not to the short-query 93%; the question is a small
    // share of the 64-token tail. What the cap guarantees here is that the passages are
    // scored at all.
    const query = `${PASTE}\nWhere is the PostRoom app deployed — which hosting platform?`;
    const capped = await inProcessRerank({ query, passages: PASSAGES }, { queryTokens: 128 });
    expect(capped[0].score - capped[capped.length - 1].score).toBeGreaterThan(0.05);
  }, 120_000);

  it('without the cap, a long query pushes the passages out of the window', async () => {
    // Documents the old behaviour: transformers.js cuts a too-long pair from the END,
    // which is the passage, so every pair becomes the same query-only input.
    const query = `Where is the PostRoom app deployed — which hosting platform?\n${PASTE}`;
    const old = await inProcessRerank({ query, passages: PASSAGES }, { queryTokens: 0 });
    const spread = old[0].score - old[old.length - 1].score;
    expect(spread).toBeLessThan(1e-4);
  }, 120_000);
});

describe('embedding chunking', () => {
  it('vectors from chunks of 8 match one 20-text batch', async () => {
    const texts = [...PASSAGES.slice(0, 19), `long one ${PASTE}`];
    const args = { texts, pooling: 'mean' as const, dimensions: 384 };
    const one = await inProcessEmbed(args, 0);
    const chunked = await inProcessEmbed(args, 8);
    expect(chunked.length).toBe(20);
    for (let i = 0; i < 20; i++) {
      const maxDiff = one[i].reduce((m, x, j) => Math.max(m, Math.abs(x - chunked[i][j])), 0);
      expect(maxDiff).toBeLessThan(1e-5);
    }
  }, 120_000);
});

describe('cap env parsing', () => {
  it('an invalid value falls back to the default instead of disabling the cap', async () => {
    const { vi } = await import('vitest');
    const prev = process.env.AWM_RERANK_QUERY_TOKENS;
    process.env.AWM_RERANK_QUERY_TOKENS = 'off';
    try {
      vi.resetModules();
      const fresh = await import('../../src/core/reranker.js');
      const query = `Where is the PostRoom app deployed — which hosting platform?\n${PASTE}`;
      const r = await fresh.inProcessRerank({ query, passages: PASSAGES });
      expect(r[0].index).toBe(GOLD); // a disabled cap would leave every score equal
    } finally {
      if (prev === undefined) delete process.env.AWM_RERANK_QUERY_TOKENS; else process.env.AWM_RERANK_QUERY_TOKENS = prev;
    }
  }, 120_000);
});
