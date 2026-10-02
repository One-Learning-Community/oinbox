import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createNav, missingViewText, type ListHandle } from './nav';

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

describe('missingViewText', () => {
  it('says a mailbox is not found only for a name that can never appear', () => {
    expect(missingViewText(false, true)).toBe('Mailbox not found.');
    expect(missingViewText(false, false)).toBe('Loading…');
  });

  it('never says so for a label: it is still arriving, or the view is about to leave for the Inbox', () => {
    expect(missingViewText(true, true)).toBe('Loading…');
    expect(missingViewText(true, false)).toBe('Loading…');
  });
});
