import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createNav, type ListHandle } from './nav';

const list = (ids: string[]): ListHandle => ({
  view: { slug: 'inbox' } as ListHandle['view'],
  count: () => ids.length,
  threadIdAt: (i) => ids[i] ?? null,
  indexOfThread: (id) => ids.indexOf(id),
  scrollToIndex: () => {},
});

describe('nav.targets', () => {
  it('uses the selection while its thread list is shown', () => {
    const nav = createRoot(() => createNav());
    nav.setList(list(['t1', 't2']));
    nav.setSelected(new Set(['t2']));
    expect(nav.targets()).toEqual(['t2']);
  });

  it('ignores a selection left behind on a page without a thread list (e.g. /calendar)', () => {
    const nav = createRoot(() => createNav());
    nav.setList(list(['t1', 't2']));
    nav.setSelected(new Set(['t2']));
    nav.setList(null); // ThreadList unmounted: the user went to the calendar
    expect(nav.targets()).toEqual([]);
  });
});
