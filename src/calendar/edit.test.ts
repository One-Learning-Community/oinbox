import { describe, expect, it } from 'vitest';
import type { Calendar } from '../jmap/types';
import type { DisplayEvent } from './instances';
import { defaultCalendarId, editability, formatDuration, hasGuests, localDateTime, newEventFromSelection, patchForDrop, writableCalendars } from './edit';

const cal = (id: string, over: Partial<Calendar> = {}): Calendar => ({
  id, name: id, color: null, sortOrder: 0, isDefault: false, isVisible: true, myRights: { mayWriteAll: true }, ...over,
});
const calendars = { c1: cal('c1', { isDefault: true }), ro: cal('ro', { myRights: { mayWriteAll: false } }), c2: cal('c2', { sortOrder: 1 }) };

const ev = (over: Partial<DisplayEvent> = {}): DisplayEvent => ({
  id: 'o1', baseEventId: 'b1', calendarIds: ['c1'], title: 'T', start: '2026-10-06T18:00:00.000Z', end: '2026-10-06T19:00:00.000Z',
  allDay: false, color: null, location: null, description: null, participants: [], isOrigin: true, recurring: false, timeZone: 'America/New_York', ...over,
});

describe('editability', () => {
  it('allows an organised single event on a writable calendar', () => {
    expect(editability(ev(), calendars)).toEqual({ editable: true });
  });
  it('refuses recurring events', () => {
    expect(editability(ev({ recurring: true }), calendars)).toMatchObject({ editable: false, reason: expect.stringMatching(/recurring/i) });
  });
  it('refuses events the user was invited to', () => {
    expect(editability(ev({ isOrigin: false }), calendars)).toMatchObject({ editable: false, reason: expect.stringMatching(/invited/i) });
  });
  it('refuses a calendar without write rights, or with unknown rights', () => {
    expect(editability(ev({ calendarIds: ['ro'] }), calendars)).toMatchObject({ editable: false, reason: expect.stringMatching(/read-only/i) });
    expect(editability(ev({ calendarIds: ['gone'] }), calendars)).toMatchObject({ editable: false });
    const noRights = { c1: { ...calendars.c1, myRights: undefined } };
    expect(editability(ev(), noRights)).toMatchObject({ editable: false });
  });
});

describe('hasGuests', () => {
  const p = (owner: boolean) => ({ name: 'n', address: 'a@x', status: 'accepted', owner });
  it('is false with no participants or only the owner', () => {
    expect(hasGuests(ev())).toBe(false);
    expect(hasGuests(ev({ participants: [p(true)] }))).toBe(false);
  });
  it('is true when a non-owner participant exists', () => {
    expect(hasGuests(ev({ participants: [p(true), p(false)] }))).toBe(true);
  });
});

describe('time helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(30 * 60_000)).toBe('PT30M');
    expect(formatDuration(3_600_000)).toBe('PT1H');
    expect(formatDuration(90 * 60_000)).toBe('PT1H30M');
    expect(formatDuration(26 * 3_600_000)).toBe('P1DT2H');
    expect(formatDuration(0)).toBe('PT0S');
  });
  it('renders an instant as local time in a zone', () => {
    expect(localDateTime(new Date('2026-10-06T18:00:00Z'), 'America/New_York')).toBe('2026-10-06T14:00:00');
    expect(localDateTime(new Date('2026-10-06T18:00:00Z'), 'Europe/London')).toBe('2026-10-06T19:00:00');
  });
});

describe('patchForDrop', () => {
  const NY = 'America/New_York';
  it('moves a timed event, keeping its zone out of the patch and its length', () => {
    const patch = patchForDrop(ev(), new Date('2026-10-07T18:00:00Z'), new Date('2026-10-07T19:00:00Z'), false, NY);
    expect(patch).toEqual({ start: '2026-10-07T14:00:00', duration: 'PT1H' });
  });
  it("writes the new wall time in the event's own zone", () => {
    const london = ev({ timeZone: 'Europe/London' });
    const patch = patchForDrop(london, new Date('2026-10-07T18:00:00Z'), new Date('2026-10-07T19:30:00Z'), false, NY);
    expect(patch).toEqual({ start: '2026-10-07T19:00:00', duration: 'PT1H30M' });
  });
  it('uses the browser zone for a floating event and does not add a timeZone', () => {
    const patch = patchForDrop(ev({ timeZone: null }), new Date('2026-10-07T18:00:00Z'), new Date('2026-10-07T19:00:00Z'), false, NY);
    expect(patch).toEqual({ start: '2026-10-07T14:00:00', duration: 'PT1H' });
  });
  it('moves an all-day event by date and keeps a multi-day length', () => {
    const allDay = ev({ allDay: true, start: '2026-10-08', end: '2026-10-10', timeZone: null });
    const patch = patchForDrop(allDay, new Date(2026, 9, 9), new Date(2026, 9, 11), true, NY);
    expect(patch).toEqual({ start: '2026-10-09T00:00:00', duration: 'P2D' });
  });
  it('converts a timed event dropped on the all-day row', () => {
    const patch = patchForDrop(ev(), new Date(2026, 9, 7), null, true, NY);
    expect(patch).toEqual({ start: '2026-10-07T00:00:00', showWithoutTime: true, duration: 'P1D', timeZone: null });
  });
  it('converts an all-day event dropped on the time grid, with a one-hour default', () => {
    const allDay = ev({ allDay: true, start: '2026-10-08', end: '2026-10-09', timeZone: null });
    const patch = patchForDrop(allDay, new Date('2026-10-09T18:00:00Z'), null, false, NY);
    expect(patch).toEqual({ start: '2026-10-09T14:00:00', duration: 'PT1H', showWithoutTime: false, timeZone: NY });
  });
});

describe('newEventFromSelection', () => {
  it('builds a timed event in the browser zone', () => {
    const e = newEventFromSelection({ start: new Date('2026-10-07T18:00:00Z'), end: new Date('2026-10-07T19:00:00Z'), allDay: false }, 'c1', 'Dentist', 'America/New_York');
    expect(e).toEqual({ calendarIds: { c1: true }, title: 'Dentist', start: '2026-10-07T14:00:00', timeZone: 'America/New_York', duration: 'PT1H' });
  });
  it('builds an all-day event spanning the selected days (the end is exclusive)', () => {
    const e = newEventFromSelection({ start: new Date(2026, 9, 7), end: new Date(2026, 9, 9), allDay: true }, 'c1', 'Trip', 'America/New_York');
    expect(e).toEqual({ calendarIds: { c1: true }, title: 'Trip', start: '2026-10-07T00:00:00', showWithoutTime: true, duration: 'P2D' });
  });
});

describe('calendar choice', () => {
  it('lists writable calendars by sort order and prefers the writable default', () => {
    expect(writableCalendars(calendars).map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(defaultCalendarId(calendars)).toBe('c1');
  });
  it('falls back to the first writable calendar, or none', () => {
    expect(defaultCalendarId({ ro: calendars.ro, c2: calendars.c2 })).toBe('c2');
    expect(defaultCalendarId({ ro: calendars.ro })).toBeUndefined();
  });
});
