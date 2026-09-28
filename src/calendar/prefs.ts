import type { Id } from '../jmap/types';

// Per-browser calendar display preferences. Never synced to the server in slice 1.

const VIEW_KEY = 'oinbox.calendar.view';
const HIDDEN_KEY = 'oinbox.calendar.hidden';
const VIEWS = ['dayGridMonth', 'timeGridWeek', 'timeGridDay'];

export function loadView(narrow: boolean): string {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v && VIEWS.includes(v)) return v;
  } catch {
    // Storage blocked: fall through to the default.
  }
  return narrow ? 'timeGridDay' : 'timeGridWeek';
}

export function saveView(view: string): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Storage blocked: the view just won't be remembered.
  }
}

export function loadHidden(): Set<Id> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveHidden(ids: ReadonlySet<Id>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage blocked: hiding lasts for this page load only.
  }
}
