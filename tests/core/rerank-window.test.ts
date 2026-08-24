import { describe, it, expect, afterEach } from 'vitest';
import {
  densestWindow, buildRerankPassage, rerankTruncation, rerankWindowMode,
} from '../../src/core/rerank-window.js';

const FILLER = 'routine deployment notes about unrelated pipeline scheduling and review process. ';
const pad = (n: number) => FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n);

describe('densestWindow', () => {
  it('returns content untouched when it already fits', () => {
    expect(densestWindow('short content', 'anything', 400)).toBe('short content');
  });

  it('finds a term buried far past the truncation point', () => {
    // The exact failure the live store hits: a hostname at char ~1500 that a
    // prefix-truncating reranker can never see.
    const content = pad(1500) + ' the host is psql-equihub-dev2.postgres.database.azure.com here ' + pad(1500);
    const win = densestWindow(content, 'which database host does the migration runner use', 400);
    expect(win).toContain('psql-equihub-dev2');
    expect(win.length).toBeLessThanOrEqual(402 + 2);  // budget + ellipses
  });

  it('beats a prefix when the answer is late — the whole point', () => {
    const content = pad(2000) + ' AADSTS700082 indicates inactivity expiry ' + pad(500);
    const prefix = content.slice(0, 400);
    const win = densestWindow(content, 'what error code indicates the refresh token expired', 400);
    expect(prefix).not.toContain('AADSTS700082');
    expect(win).toContain('AADSTS700082');
  });

  it('falls back to the head when no query term appears', () => {
    const content = 'alpha beta gamma ' + pad(1000);
    const win = densestWindow(content, 'zzzz nonexistent qqqq', 400);
    expect(win.startsWith('alpha beta gamma')).toBe(true);
  });

  it('falls back to the head when the query is all stopwords', () => {
    const content = 'alpha beta gamma ' + pad(1000);
    const win = densestWindow(content, 'what is the and for', 400);
    expect(win.startsWith('alpha beta gamma')).toBe(true);
  });

  it('prefers the window covering the MOST query terms, not merely the first hit', () => {
    // 'alpha' alone early; 'alpha' + 'beta' + 'gamma' together late.
    const content = 'alpha ' + pad(1200) + ' alpha beta gamma clustered here ' + pad(600);
    const win = densestWindow(content, 'alpha beta gamma', 300);
    expect(win).toContain('beta');
    expect(win).toContain('gamma');
  });

  it('respects the budget', () => {
    const content = pad(5000);
    for (const b of [100, 400, 1200]) {
      const win = densestWindow(content, 'deployment review', b);
      // allow for the two ellipsis characters
      expect(win.replace(/…/g, '').length).toBeLessThanOrEqual(b);
    }
  });

  it('handles regex-special characters in the query without throwing', () => {
    const content = pad(800) + ' the value is a.b-c_d here ' + pad(200);
    expect(() => densestWindow(content, 'what is a.b-c_d (really) [maybe]? +x', 400)).not.toThrow();
    expect(densestWindow(content, 'what is a.b-c_d', 400)).toContain('a.b-c_d');
  });
});

describe('buildRerankPassage', () => {
  it('always keeps the concept line', () => {
    const p = buildRerankPassage('My Concept', pad(2000), 'deployment', 400, 'query');
    expect(p.startsWith('My Concept: ')).toBe(true);
  });

  it('prefix mode reproduces the legacy behaviour exactly', () => {
    const content = pad(2000);
    const p = buildRerankPassage('C', content, 'anything', 400, 'prefix');
    expect(p).toBe(`C: ${content.slice(0, 400)}`);
  });

  it('query mode surfaces a late answer that prefix mode misses', () => {
    const content = pad(1800) + ' DUNNING is the parked state ' + pad(400);
    const prefix = buildRerankPassage('C', content, 'what state after failures', 400, 'prefix');
    const windowed = buildRerankPassage('C', content, 'what state after failures DUNNING', 400, 'query');
    expect(prefix).not.toContain('DUNNING');
    expect(windowed).toContain('DUNNING');
  });

  it('leaves short content identical in both modes', () => {
    const short = 'a brief memory about billing';
    expect(buildRerankPassage('C', short, 'billing', 400, 'query'))
      .toBe(buildRerankPassage('C', short, 'billing', 400, 'prefix'));
  });
});

describe('configuration defaults preserve shipped behaviour', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['AWM_RERANK_TRUNC', 'AWM_RERANK_WINDOW']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('truncation defaults to 400 and rejects nonsense', () => {
    delete process.env.AWM_RERANK_TRUNC;
    expect(rerankTruncation()).toBe(400);
    process.env.AWM_RERANK_TRUNC = '1200';
    expect(rerankTruncation()).toBe(1200);
    process.env.AWM_RERANK_TRUNC = 'not-a-number';
    expect(rerankTruncation()).toBe(400);
    process.env.AWM_RERANK_TRUNC = '-5';
    expect(rerankTruncation()).toBe(400);
  });

  it('window mode defaults to prefix', () => {
    delete process.env.AWM_RERANK_WINDOW;
    expect(rerankWindowMode()).toBe('prefix');
    process.env.AWM_RERANK_WINDOW = 'query';
    expect(rerankWindowMode()).toBe('query');
    process.env.AWM_RERANK_WINDOW = 'something-else';
    expect(rerankWindowMode()).toBe('prefix');
  });
});
