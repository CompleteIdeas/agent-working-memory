import { describe, it, expect } from 'vitest';
import { validityState } from '../../src/core/validity.js';

const MARCH = Date.parse('2026-03-10T12:00:00Z');

describe('validityState', () => {
  it('is current when no bounds are set', () => {
    expect(validityState({}, MARCH)).toBe('current');
    expect(validityState({ validFrom: null, validTo: null }, MARCH)).toBe('current');
  });

  it('is expired once valid_to has passed', () => {
    // The live store on 2026-10-19 held 482 of these, all rendered "[valid until …]".
    expect(validityState({ validTo: '2026-01-15' }, MARCH)).toBe('expired');
  });

  it('a date-only valid_to holds THROUGH that day', () => {
    const lateThatDay = Date.parse('2026-01-15T23:30:00Z');
    expect(validityState({ validTo: '2026-01-15' }, lateThatDay)).toBe('current');
    expect(validityState({ validTo: '2026-01-15' }, lateThatDay + 60 * 60 * 1000)).toBe('expired');
  });

  it('a datetime valid_to is taken as written', () => {
    expect(validityState({ validTo: '2026-03-10T11:00:00Z' }, MARCH)).toBe('expired');
    expect(validityState({ validTo: '2026-03-10T13:00:00Z' }, MARCH)).toBe('current');
  });

  it('is not-yet-valid before valid_from', () => {
    expect(validityState({ validFrom: '2026-11-03' }, MARCH)).toBe('not-yet-valid');
    expect(validityState({ validFrom: '2026-03-01' }, MARCH)).toBe('current');
  });

  it('expired wins over not-yet-valid when both bounds are wrong', () => {
    expect(validityState({ validFrom: '2026-12-01', validTo: '2026-01-01' }, MARCH)).toBe('expired');
  });

  it('ignores an unparseable bound rather than hiding the memory', () => {
    expect(validityState({ validTo: 'next quarter' }, MARCH)).toBe('current');
    expect(validityState({ validFrom: 'soon' }, MARCH)).toBe('current');
  });
});
