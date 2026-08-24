import { describe, it, expect, afterEach } from 'vitest';
import {
  parseTemporal, temporalEnabled, temporalBoost,
} from '../../src/core/temporal-query.js';

/** Fixed anchor: Monday 2026-08-24. All relative expectations key off this. */
const ASOF = Date.UTC(2026, 7, 24, 12, 0, 0);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const inWindow = (r: { from: number; to: number } | null, t: number) =>
  !!r && t >= r.from && t < r.to;

describe('parseTemporal — MUST be a strict no-op without a temporal cue', () => {
  // This is the highest-risk property. A matcher that fires on ordinary words
  // would silently reshape every recall in the store, and the damage would be
  // invisible because results would still look plausible.
  const noCue = [
    'azure app service plan capacity increase internal application',
    'showconnect scoring dressage penalties valid starter',
    'why do we get duplicate score rows',
    'equihub workspace assignment coordination hive',
    'the last item in the list',            // "last" WITHOUT a time unit
    'monday.com integration notes',         // weekday inside a product name
    'mayor election results parser',        // "may" as a substring
    'march through the migration steps',    // "march" as a verb
    'this week_number column is wrong',     // "this week" only as an identifier fragment
  ];
  for (const q of noCue) {
    it(`returns null for: "${q.slice(0, 46)}"`, () => {
      expect(parseTemporal(q, ASOF)).toBeNull();
    });
  }

  it('requires an explicit cue before a bare month name', () => {
    expect(parseTemporal('may deployment checklist', ASOF)).toBeNull();
    expect(parseTemporal('notes in May 2026', ASOF)).not.toBeNull();
  });
});

describe('parseTemporal — relative expressions', () => {
  it('"last Friday" resolves to the previous Friday', () => {
    const r = parseTemporal('azure plan from last Friday', ASOF);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('relative-day');
    expect(inWindow(r, day(2026, 8, 21))).toBe(true);   // Fri 21 Aug
    expect(inWindow(r, day(2026, 8, 10))).toBe(false);
  });

  it('"last Thursday or Friday" widens to cover BOTH days', () => {
    // Robert's actual phrasing. The "or" is an admission of uncertainty, so the
    // window must cover both rather than pick one.
    const r = parseTemporal('azure app plan from last Thursday or Friday', ASOF);
    expect(inWindow(r, day(2026, 8, 20))).toBe(true);   // Thu
    expect(inWindow(r, day(2026, 8, 21))).toBe(true);   // Fri
  });

  it('"last week" covers the preceding fortnight, not a knife-edge week', () => {
    const r = parseTemporal('deployment notes from last week', ASOF);
    expect(r!.kind).toBe('relative-week');
    expect(inWindow(r, day(2026, 8, 21))).toBe(true);
    expect(inWindow(r, day(2026, 8, 14))).toBe(true);
    expect(inWindow(r, day(2026, 6, 1))).toBe(false);
  });

  it('"yesterday" is a single day', () => {
    const r = parseTemporal('what did we decide yesterday', ASOF);
    expect(inWindow(r, day(2026, 8, 23))).toBe(true);
    expect(inWindow(r, day(2026, 8, 24))).toBe(false);
  });

  it('"recently" is a soft two-week window', () => {
    const r = parseTemporal('recently changed pipeline config', ASOF);
    expect(r!.kind).toBe('recent');
    expect(inWindow(r, day(2026, 8, 18))).toBe(true);
    expect(inWindow(r, day(2026, 7, 1))).toBe(false);
  });

  it('"last 3 days" honours the count', () => {
    const r = parseTemporal('errors in the last 3 days', ASOF);
    expect(inWindow(r, day(2026, 8, 22))).toBe(true);
    expect(inWindow(r, day(2026, 8, 10))).toBe(false);
  });
});

describe('parseTemporal — absolute expressions', () => {
  it('an ISO date allows a few days of slack for misremembering', () => {
    const r = parseTemporal('capacity notes on 2026-05-01', ASOF);
    expect(r!.kind).toBe('absolute-date');
    expect(inWindow(r, day(2026, 5, 1))).toBe(true);
    expect(inWindow(r, day(2026, 5, 3))).toBe(true);
    expect(inWindow(r, day(2026, 5, 20))).toBe(false);
  });

  it('"in May 2026" covers exactly that month', () => {
    const r = parseTemporal('platform fee work in May 2026', ASOF);
    expect(inWindow(r, day(2026, 5, 15))).toBe(true);
    expect(inWindow(r, day(2026, 6, 1))).toBe(false);
    expect(inWindow(r, day(2026, 4, 30))).toBe(false);
  });

  it('December rolls the year correctly', () => {
    const r = parseTemporal('notes in December 2025', ASOF);
    expect(inWindow(r, day(2025, 12, 20))).toBe(true);
    expect(inWindow(r, day(2026, 1, 2))).toBe(false);
  });
});

describe('parseTemporal — stripping (this is where the measured loss came from)', () => {
  it('removes the temporal phrase so it cannot dilute BM25', () => {
    const r = parseTemporal('azure app plan capacity from last Friday', ASOF);
    expect(r!.stripped.toLowerCase()).not.toContain('friday');
    expect(r!.stripped.toLowerCase()).not.toContain('last');
    expect(r!.stripped).toContain('azure');
    expect(r!.stripped).toContain('capacity');
  });

  it('removes a bare ISO date and its "on" connective', () => {
    const r = parseTemporal('platform fee notes on 2026-05-01', ASOF);
    expect(r!.stripped).not.toMatch(/2026-05-01/);
    expect(r!.stripped.trim()).toBe('platform fee notes');
  });

  it('leaves the subject intact rather than shredding the query', () => {
    const r = parseTemporal('showconnect scoring finalize from last week', ASOF);
    expect(r!.stripped.split(/\s+/).length).toBeGreaterThanOrEqual(3);
  });
});

describe('configuration', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['AWM_TEMPORAL', 'AWM_TEMPORAL_BOOST']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('is OFF unless explicitly enabled', () => {
    delete process.env.AWM_TEMPORAL;
    expect(temporalEnabled()).toBe(false);
    process.env.AWM_TEMPORAL = '1';
    expect(temporalEnabled()).toBe(true);
  });

  it('boost is a positive default and rejects nonsense', () => {
    delete process.env.AWM_TEMPORAL_BOOST;
    expect(temporalBoost()).toBeGreaterThan(0);
    process.env.AWM_TEMPORAL_BOOST = '0';
    expect(temporalBoost()).toBe(0);          // strip-only arm
    process.env.AWM_TEMPORAL_BOOST = 'junk';
    expect(temporalBoost()).toBeGreaterThan(0);
  });
});

describe('regression — a BARE date must not be treated as a temporal filter', () => {
  // Memories routinely carry a date as part of their subject, where the date IS
  // the fact rather than a "when" qualifier. Treating those as temporal strips a
  // strongly discriminative term. Measured: a bare-date rule fired on 98 of
  // 1,316 (7.4%) real identifier queries and cost success@1 75.8% -> 75.0%.
  const bare = [
    'Hive close-out 2026-04-24 PASS slices delivered flags.test.ts',
    'FIXED 2026-08-21 event River Glen Fall e.event_area',
    'Legacy load progress 2026-06-11 225-231 applied import_job_def',
  ];
  for (const q of bare) {
    it(`ignores the bare date in: "${q.slice(0, 44)}"`, () => {
      expect(parseTemporal(q, ASOF)).toBeNull();
    });
  }

  it('still fires when an explicit cue is present', () => {
    for (const cue of ['on', 'from', 'since', 'before', 'after', 'around']) {
      expect(parseTemporal(`platform notes ${cue} 2026-05-01`, ASOF)).not.toBeNull();
    }
  });
});
