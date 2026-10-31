/**
 * Query shape routes the final blend weight (src/core/query-shape.ts, activation.ts).
 * Run: npx vitest run tests/core/query-shape.test.ts
 */
import { describe, it, expect } from 'vitest';
import { isNaturalQuery } from '../../src/core/query-shape.js';

describe('isNaturalQuery', () => {
  it('treats questions as natural', () => {
    expect(isNaturalQuery('how do I deploy RosterKeep')).toBe(true);
    expect(isNaturalQuery('Why did the Plot tab get pulled out of the Compendium?')).toBe(true);
    expect(isNaturalQuery('deploy command for the app?')).toBe(true);
  });

  it('treats sentences heavy in function words as natural', () => {
    expect(isNaturalQuery('the thing we decided about the backup of the medical key')).toBe(true);
  });

  it('treats keyword lookups as keyword', () => {
    expect(isNaturalQuery('settlement lock period close SettlementService.closeRun')).toBe(false);
    expect(isNaturalQuery('FIN-05 Multi-Stripe Connect destination-charge routing payment_transactions.platform_fee')).toBe(false);
    expect(isNaturalQuery('quick wins bundle sponsor_contract')).toBe(false);
  });

  it('treats empty input as keyword', () => {
    expect(isNaturalQuery('')).toBe(false);
    expect(isNaturalQuery('   ')).toBe(false);
  });
});
