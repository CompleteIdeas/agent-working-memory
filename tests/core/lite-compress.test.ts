import { describe, it, expect } from 'vitest';
import { liteCompress, retrieveOriginal } from '../../src/core/lite-compress.js';
import { decode } from '@toon-format/toon';

describe('liteCompress', () => {
  it('compresses a uniform JSON array to TOON and saves tokens', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: 1000 + i, status: i % 5 ? 'ok' : 'FATAL', latency_ms: 20 + i, region: 'us-east',
    }));
    const r = liteCompress(rows);
    expect(r.format).toBe('toon');
    expect(r.charsAfter).toBeLessThan(r.charsBefore);
    expect(r.ratio).toBeGreaterThan(0.3);
    expect(r.ref).toMatch(/^awm_orig_\d+$/);
  });

  it('is lossless — emitted TOON decodes back to the exact input', () => {
    const rows = [
      { id: 1, name: 'Blue Lake Trail', distanceKm: 7.5, companion: 'ana' },
      { id: 2, name: 'Ridge Overlook', distanceKm: 9.2, companion: 'luis' },
    ];
    const r = liteCompress(rows);
    expect(r.format).toBe('toon');
    expect(JSON.stringify(decode(r.text))).toBe(JSON.stringify(rows));
  });

  it('falls back to JSON when TOON would coerce a string-number (fidelity guard)', () => {
    // "00123" must NOT come back as the number 123.
    const data = [{ code: '00123', label: 'x' }, { code: '00456', label: 'y' }];
    const r = liteCompress(data);
    // Either it stayed JSON, or — if emitted — it must round-trip exactly.
    if (r.format === 'toon') {
      expect(JSON.stringify(decode(r.text))).toBe(JSON.stringify(data));
    } else {
      expect(r.format).toBe('json');
      expect(r.ref).toBeNull();
    }
  });

  it('passes prose through untouched', () => {
    const prose = 'AccountingService.closePeriod() must check BLOCKED server-side per schema/072.';
    const r = liteCompress(prose);
    expect(r.format).toBe('passthrough');
    expect(r.text).toBe(prose);
    expect(r.ref).toBeNull();
  });

  it('does not bother when savings are below threshold', () => {
    const tiny = [{ a: 1 }];
    const r = liteCompress(tiny, { minSavingChars: 1000 });
    expect(r.format).toBe('json');
    expect(r.ref).toBeNull();
  });

  it('accepts a JSON string as well as an object', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, v: i * 2, tag: 't' }));
    const r = liteCompress(JSON.stringify(rows));
    expect(r.format).toBe('toon');
    expect(r.ratio).toBeGreaterThan(0);
  });

  it('CCR-lite: retrieveOriginal returns the verbatim source for a ref', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, status: 'ok', n: i }));
    const r = liteCompress(rows);
    expect(r.ref).not.toBeNull();
    const original = retrieveOriginal(r.ref!);
    expect(original).toBe(JSON.stringify(rows, null, 2));
  });

  it('retrieveOriginal returns undefined for an unknown ref', () => {
    expect(retrieveOriginal('awm_orig_does_not_exist')).toBeUndefined();
  });
});
