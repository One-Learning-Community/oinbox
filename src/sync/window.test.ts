import { describe, expect, it } from 'vitest';
import { applyQueryChanges, missingPages } from './window';

describe('applyQueryChanges', () => {
  it('removes then inserts by index (RFC 8620 §5.6)', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const out = applyQueryChanges(ids, { removed: ['b', 'd'], added: [{ id: 'x', index: 0 }, { id: 'b', index: 2 }], total: 4 });
    expect(out).toEqual(['x', 'a', 'b', 'c']);
  });

  it('keeps unloaded slots as holes and follows the new total', () => {
    const ids: (string | null)[] = ['a', 'b', null, null, null];
    const out = applyQueryChanges(ids, { removed: [], added: [{ id: 'n', index: 0 }], total: 6 });
    expect(out).toEqual(['n', 'a', 'b', null, null, null]);
  });

  it('shrinks when total shrinks', () => {
    expect(applyQueryChanges(['a', 'b', null], { removed: ['a'], added: [], total: 2 })).toEqual(['b', null]);
  });

  it('pads with holes when an added index lands past the loaded prefix', () => {
    expect(applyQueryChanges(['a'], { removed: [], added: [{ id: 'z', index: 3 }], total: 4 })).toEqual(['a', null, null, 'z']);
  });
});

describe('missingPages', () => {
  it('lists page starts whose slots are not loaded', () => {
    const ids = Array.from({ length: 250 }, (_, i) => (i < 100 ? `e${i}` : null));
    expect(missingPages(ids, 90, 170, 50)).toEqual([100, 150]);
    expect(missingPages(ids, 0, 60, 50)).toEqual([]);
  });

  it('clamps to the list length', () => {
    expect(missingPages([null, null], 0, 500, 50)).toEqual([0]);
  });
});
