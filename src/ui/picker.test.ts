import { describe, expect, it } from 'vitest';
import { pickerScore } from './picker';

describe('pickerScore', () => {
  it('ranks exact over prefix over word start over substring over subsequence', () => {
    const scores = ['Receipts', 'Receipts 2025', 'Clients/Receipts', 'Prereceipts', 'Rare cheap trips'].map((l) => pickerScore(l, 'receipts'));
    expect(scores).toEqual([5, 4, 3, 2, null]);
    expect(pickerScore('Receipts', 'rcp')).toBe(1);
  });

  it('ignores case and surrounding space', () => {
    expect(pickerScore('Receipts', '  RECEIPTS ')).toBe(5);
  });

  it('hides rows that do not match', () => {
    expect(pickerScore('Receipts', 'xyz')).toBeNull();
  });

  it('is positive for every match, so a row scored 0 sorts last', () => {
    for (const q of ['r', 'rec', 'receipts', 'rps']) expect(pickerScore('Receipts', q)).toBeGreaterThan(0);
  });
});
