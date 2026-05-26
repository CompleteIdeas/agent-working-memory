/**
 * Cron matcher tests — verify the hand-rolled cron parser used by
 * the consolidation scheduler.
 *
 * Run: npx vitest run tests/scheduler/cron-match.test.ts
 */

import { describe, it, expect } from 'vitest';
import { cronMatches } from '../../src/engine/consolidation-scheduler.js';

// Helper: build a date at a specific moment without DST surprises.
function dt(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('cronMatches', () => {
  describe('default 3 AM daily ("0 3 * * *")', () => {
    const expr = '0 3 * * *';

    it('matches 3:00 AM on a Monday', () => {
      // 2026-05-25 was a Monday
      expect(cronMatches(dt(2026, 5, 25, 3, 0), expr)).toBe(true);
    });

    it('does NOT match 3:01 AM', () => {
      expect(cronMatches(dt(2026, 5, 25, 3, 1), expr)).toBe(false);
    });

    it('does NOT match 2:00 AM', () => {
      expect(cronMatches(dt(2026, 5, 25, 2, 0), expr)).toBe(false);
    });

    it('does NOT match 3:00 PM (15:00)', () => {
      expect(cronMatches(dt(2026, 5, 25, 15, 0), expr)).toBe(false);
    });

    it('matches 3:00 AM on any day of the week', () => {
      // Tuesday, Wednesday, Sunday
      expect(cronMatches(dt(2026, 5, 26, 3, 0), expr)).toBe(true);
      expect(cronMatches(dt(2026, 5, 27, 3, 0), expr)).toBe(true);
      expect(cronMatches(dt(2026, 5, 31, 3, 0), expr)).toBe(true);
    });
  });

  describe('step expression ("*/15 * * * *" = every 15 minutes)', () => {
    const expr = '*/15 * * * *';

    it('matches minute 0', () => {
      expect(cronMatches(dt(2026, 5, 25, 10, 0), expr)).toBe(true);
    });

    it('matches minute 15', () => {
      expect(cronMatches(dt(2026, 5, 25, 10, 15), expr)).toBe(true);
    });

    it('matches minute 30', () => {
      expect(cronMatches(dt(2026, 5, 25, 10, 30), expr)).toBe(true);
    });

    it('matches minute 45', () => {
      expect(cronMatches(dt(2026, 5, 25, 10, 45), expr)).toBe(true);
    });

    it('does NOT match minute 14', () => {
      expect(cronMatches(dt(2026, 5, 25, 10, 14), expr)).toBe(false);
    });

    it('does NOT match minute 16', () => {
      expect(cronMatches(dt(2026, 5, 25, 10, 16), expr)).toBe(false);
    });
  });

  describe('weekday range ("0 3 * * 1-5" = 3 AM weekdays)', () => {
    const expr = '0 3 * * 1-5';

    it('matches 3 AM Monday (1)', () => {
      expect(cronMatches(dt(2026, 5, 25, 3, 0), expr)).toBe(true);
    });

    it('matches 3 AM Friday (5)', () => {
      expect(cronMatches(dt(2026, 5, 29, 3, 0), expr)).toBe(true);
    });

    it('does NOT match 3 AM Saturday (6)', () => {
      expect(cronMatches(dt(2026, 5, 30, 3, 0), expr)).toBe(false);
    });

    it('does NOT match 3 AM Sunday (0)', () => {
      expect(cronMatches(dt(2026, 5, 31, 3, 0), expr)).toBe(false);
    });
  });

  describe('day-of-week 7 normalized to 0 (Sunday)', () => {
    it('matches 3 AM Sunday via 7', () => {
      const expr = '0 3 * * 7';
      expect(cronMatches(dt(2026, 5, 31, 3, 0), expr)).toBe(true); // Sunday
    });

    it('does NOT match 3 AM Monday via 7', () => {
      const expr = '0 3 * * 7';
      expect(cronMatches(dt(2026, 5, 25, 3, 0), expr)).toBe(false); // Monday
    });
  });

  describe('list expression ("0,30 * * * *" = on the hour and half-hour)', () => {
    const expr = '0,30 * * * *';

    it('matches minute 0', () => {
      expect(cronMatches(dt(2026, 5, 25, 14, 0), expr)).toBe(true);
    });

    it('matches minute 30', () => {
      expect(cronMatches(dt(2026, 5, 25, 14, 30), expr)).toBe(true);
    });

    it('does NOT match minute 15', () => {
      expect(cronMatches(dt(2026, 5, 25, 14, 15), expr)).toBe(false);
    });

    it('does NOT match minute 45', () => {
      expect(cronMatches(dt(2026, 5, 25, 14, 45), expr)).toBe(false);
    });
  });

  describe('specific day of month ("0 3 15 * *" = 3 AM on the 15th)', () => {
    const expr = '0 3 15 * *';

    it('matches 3 AM on the 15th of any month', () => {
      expect(cronMatches(dt(2026, 5, 15, 3, 0), expr)).toBe(true);
      expect(cronMatches(dt(2026, 6, 15, 3, 0), expr)).toBe(true);
    });

    it('does NOT match 3 AM on the 14th or 16th', () => {
      expect(cronMatches(dt(2026, 5, 14, 3, 0), expr)).toBe(false);
      expect(cronMatches(dt(2026, 5, 16, 3, 0), expr)).toBe(false);
    });
  });

  describe('invalid expressions', () => {
    it('returns false for too few fields', () => {
      expect(cronMatches(dt(2026, 5, 25, 3, 0), '0 3 * *')).toBe(false);
    });

    it('returns false for too many fields', () => {
      expect(cronMatches(dt(2026, 5, 25, 3, 0), '0 3 * * * *')).toBe(false);
    });

    it('returns false for empty expression', () => {
      expect(cronMatches(dt(2026, 5, 25, 3, 0), '')).toBe(false);
    });
  });
});
