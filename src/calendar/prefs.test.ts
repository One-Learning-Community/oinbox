import { beforeEach, describe, expect, it } from 'vitest';
import { loadHidden, loadView, saveHidden, saveView } from './prefs';

describe('calendar prefs', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to week view, or day view on narrow screens', () => {
    expect(loadView(false)).toBe('timeGridWeek');
    expect(loadView(true)).toBe('timeGridDay');
  });

  it('remembers a known view and ignores unknown ones', () => {
    saveView('dayGridMonth');
    expect(loadView(true)).toBe('dayGridMonth');
    localStorage.setItem('oinbox.calendar.view', 'listYear');
    expect(loadView(false)).toBe('timeGridWeek');
  });

  it('round-trips hidden calendars and survives corrupt storage', () => {
    saveHidden(new Set(['c2']));
    expect([...loadHidden()]).toEqual(['c2']);
    localStorage.setItem('oinbox.calendar.hidden', '{not json');
    expect(loadHidden().size).toBe(0);
    localStorage.setItem('oinbox.calendar.hidden', '[1, "c3"]');
    expect([...loadHidden()]).toEqual(['c3']);
  });
});
