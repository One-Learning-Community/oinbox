import { describe, expect, it } from 'vitest';
import { RequestBuilder } from '../jmap/request';
import type { Calendar, CalendarEvent } from '../jmap/types';
import { addRangeCalls, parseDuration, rangeKey, toCalendarInput, toDisplayEvents, toUtcDate, type DisplayEvent } from './instances';

const base: CalendarEvent = {
  id: 'b1',
  calendarIds: { c1: true },
  title: 'Weekly sync',
  start: '2026-10-05T09:00:00',
  timeZone: 'America/New_York',
  duration: 'PT30M',
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' },
};

/** An occurrence exactly as Stalwart returns it from an expanded query. */
const occ = (id: string, recurrenceId: string, start: string, utcStart: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, baseEventId: 'b1', recurrenceId, calendarIds: { c1: true }, start, utcStart, ...extra,
});

describe('parseDuration', () => {
  it('parses JSCalendar durations', () => {
    expect(parseDuration('PT30M')).toEqual({ days: 0, ms: 30 * 60_000 });
    expect(parseDuration('P1DT2H')).toEqual({ days: 1, ms: 2 * 3_600_000 });
    expect(parseDuration('P2W')).toEqual({ days: 14, ms: 0 });
    expect(parseDuration('PT12H59M59S')).toEqual({ days: 0, ms: (12 * 3600 + 59 * 60 + 59) * 1000 });
  });
  it('treats missing or malformed durations as zero', () => {
    expect(parseDuration(undefined)).toEqual({ days: 0, ms: 0 });
    expect(parseDuration('')).toEqual({ days: 0, ms: 0 });
    expect(parseDuration('30 minutes')).toEqual({ days: 0, ms: 0 });
  });
});

describe('toDisplayEvents', () => {
  it('takes title and duration from the base event for a plain occurrence', () => {
    const [e] = toDisplayEvents([occ('o1', '2026-10-05T09:00:00', '2026-10-05T09:00:00', '2026-10-05T13:00:00Z')], [base]);
    expect(e).toMatchObject({ id: 'o1', baseEventId: 'b1', title: 'Weekly sync', allDay: false, start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T13:30:00.000Z', calendarIds: ['c1'] });
  });

  it('merges a sparse override (start only): Stalwart omits the title and sends a bogus duration', () => {
    const b = { ...base, recurrenceOverrides: { '2026-10-12T09:00:00': { start: '2026-10-12T11:00:00' } } };
    // Verbatim shape from the 2026-09-28 spike: no title, duration PT12H59M59S.
    const o = occ('o2', '2026-10-12T09:00:00', '2026-10-12T11:00:00', '2026-10-12T15:00:00Z', { duration: 'PT12H59M59S' });
    const [e] = toDisplayEvents([o], [b]);
    expect(e).toMatchObject({ title: 'Weekly sync', start: '2026-10-12T15:00:00.000Z', end: '2026-10-12T15:30:00.000Z' });
  });

  it('applies an override that sets title and duration', () => {
    const b = { ...base, recurrenceOverrides: { '2026-10-12T09:00:00': { start: '2026-10-12T11:00:00', title: 'Moved sync', duration: 'PT1H' } } };
    const [e] = toDisplayEvents([occ('o2', '2026-10-12T09:00:00', '2026-10-12T11:00:00', '2026-10-12T15:00:00Z')], [b]);
    expect(e).toMatchObject({ title: 'Moved sync', end: '2026-10-12T16:00:00.000Z' });
  });

  it('drops an occurrence whose override excludes it', () => {
    const b = { ...base, recurrenceOverrides: { '2026-10-19T09:00:00': { excluded: true } } };
    expect(toDisplayEvents([occ('o3', '2026-10-19T09:00:00', '2026-10-19T09:00:00', '2026-10-19T13:00:00Z')], [b])).toEqual([]);
  });

  it('ignores JSON-pointer override keys without throwing', () => {
    const b = { ...base, recurrenceOverrides: { '2026-10-05T09:00:00': { 'participants/p1/participationStatus': 'accepted', title: 'Sync (override)' } } };
    const [e] = toDisplayEvents([occ('o1', '2026-10-05T09:00:00', '2026-10-05T09:00:00', '2026-10-05T13:00:00Z')], [b]);
    expect(e!.title).toBe('Sync (override)');
    expect(e).not.toHaveProperty(['participants/p1/participationStatus']);
  });

  it('places a floating all-day event on its own date, whatever the browser time zone', () => {
    const allDay: CalendarEvent = { id: 'b2', calendarIds: { c1: true }, title: 'Release freeze', start: '2026-10-06T00:00:00', showWithoutTime: true, duration: 'P1D' };
    // Server computed utcStart in Pacific/Auckland (UTC+13): the previous UTC day. Must not matter.
    const o: CalendarEvent = { id: 'o4', baseEventId: 'b2', calendarIds: { c1: true }, start: '2026-10-06T00:00:00', utcStart: '2026-10-05T11:00:00Z' };
    const [e] = toDisplayEvents([o], [allDay]);
    expect(e).toMatchObject({ allDay: true, start: '2026-10-06', end: '2026-10-07' });
  });

  it('gives a multi-day all-day event an exclusive end date', () => {
    const b: CalendarEvent = { id: 'b3', calendarIds: { c1: true }, title: 'Offsite', start: '2026-10-08T00:00:00', showWithoutTime: true, duration: 'P2D' };
    const [e] = toDisplayEvents([{ id: 'o5', baseEventId: 'b3', start: '2026-10-08T00:00:00', utcStart: '2026-10-08T00:00:00Z' }], [b]);
    expect(e).toMatchObject({ start: '2026-10-08', end: '2026-10-10' });
  });

  it('uses utcStart for an event in another time zone', () => {
    const b: CalendarEvent = { id: 'b4', calendarIds: { c1: true }, title: 'London call', start: '2026-10-07T15:00:00', timeZone: 'Europe/London', duration: 'PT45M' };
    const [e] = toDisplayEvents([{ id: 'o6', baseEventId: 'b4', start: '2026-10-07T15:00:00', utcStart: '2026-10-07T14:00:00Z' }], [b]);
    expect(e).toMatchObject({ start: '2026-10-07T14:00:00.000Z', end: '2026-10-07T14:45:00.000Z' });
  });

  // Review focus 1
  it('ends a timed event that crosses midnight on the right later day', () => {
    const b: CalendarEvent = { id: 'b5', calendarIds: { c1: true }, title: 'Night job', start: '2026-10-07T22:00:00', timeZone: 'UTC', duration: 'P1DT2H' };
    const [e] = toDisplayEvents([{ id: 'o7', baseEventId: 'b5', start: '2026-10-07T22:00:00', utcStart: '2026-10-07T22:00:00Z' }], [b]);
    expect(e!.end).toBe('2026-10-09T00:00:00.000Z');
  });

  // Review focus 2
  it('renders an event with no duration as zero-length', () => {
    const b: CalendarEvent = { id: 'b6', calendarIds: { c1: true }, title: 'Reminder', start: '2026-10-07T08:00:00', timeZone: 'UTC' };
    const [e] = toDisplayEvents([{ id: 'o8', baseEventId: 'b6', start: '2026-10-07T08:00:00', utcStart: '2026-10-07T08:00:00Z' }], [b]);
    expect(e!.end).toBe(e!.start);
  });

  it('falls back to "(No title)" and extracts location, description and participants', () => {
    const b: CalendarEvent = {
      id: 'b7', calendarIds: { c1: true }, title: '   ', description: 'Agenda', start: '2026-10-07T08:00:00', timeZone: 'UTC', duration: 'PT1H',
      locations: { l1: { name: 'Room 4' } },
      participants: {
        a: { name: 'Alice Example', calendarAddress: 'mailto:alice@example.test', participationStatus: 'accepted' },
        b: { calendarAddress: 'mailto:bob@example.test' },
      },
    };
    const [e] = toDisplayEvents([{ id: 'o9', baseEventId: 'b7', start: '2026-10-07T08:00:00', utcStart: '2026-10-07T08:00:00Z' }], [b]);
    expect(e).toMatchObject({
      title: '(No title)', location: 'Room 4', description: 'Agenda',
      participants: [
        { name: 'Alice Example', address: 'alice@example.test', status: 'accepted' },
        { name: 'bob@example.test', address: 'bob@example.test', status: 'needs-action' },
      ],
    });
  });

  it('falls back to the occurrence itself when its base event is missing', () => {
    const [e] = toDisplayEvents([{ id: 'o10', baseEventId: 'gone', title: 'Orphan', start: '2026-10-07T08:00:00', utcStart: '2026-10-07T08:00:00Z', duration: 'PT15M', calendarIds: { c1: true } }], []);
    expect(e).toMatchObject({ title: 'Orphan', end: '2026-10-07T08:15:00.000Z' });
  });
});

describe('edit-relevant fields', () => {
  const plain: CalendarEvent = { id: 'p1', calendarIds: { c1: true }, title: 'Dentist', start: '2026-10-06T14:00:00', timeZone: 'America/New_York', duration: 'PT1H', isOrigin: true };
  const plainOcc: CalendarEvent = { id: 'o9', baseEventId: 'p1', calendarIds: { c1: true }, start: '2026-10-06T14:00:00', utcStart: '2026-10-06T18:00:00Z' };

  it('exposes isOrigin, timeZone and a non-recurring flag', () => {
    const [e] = toDisplayEvents([plainOcc], [plain]);
    expect(e).toMatchObject({ isOrigin: true, recurring: false, timeZone: 'America/New_York' });
  });

  it('flags a series as recurring, and a missing isOrigin as false', () => {
    const [e] = toDisplayEvents([occ('o1', '2026-10-05T09:00:00', '2026-10-05T09:00:00', '2026-10-05T13:00:00Z')], [base]);
    expect(e).toMatchObject({ recurring: true, isOrigin: false });
  });

  it('marks owner participants', () => {
    const withGuests: CalendarEvent = { ...plain, participants: {
      a: { calendarAddress: 'mailto:alice@x.test', roles: { owner: true, attendee: true } },
      b: { calendarAddress: 'mailto:bob@x.test', roles: { attendee: true } },
    } };
    const [e] = toDisplayEvents([plainOcc], [withGuests]);
    expect(e!.participants.map((p) => [p.address, p.owner])).toEqual([['alice@x.test', true], ['bob@x.test', false]]);
  });

  it('asks the server for the new base properties', () => {
    const b = new RequestBuilder();
    addRangeCalls(b, 'a1', { start: '2026-10-04T00:00:00Z', end: '2026-10-11T00:00:00Z' }, 'UTC');
    const bases = b.build([]).methodCalls[2]!;
    expect(bases[1].properties).toEqual(expect.arrayContaining(['isOrigin', 'recurrenceRule']));
  });
});

describe('toCalendarInput', () => {
  const calendars: Record<string, Calendar> = {
    c1: { id: 'c1', name: 'Personal', color: '#1a73e8', sortOrder: 0, isDefault: true, isVisible: true },
    c2: { id: 'c2', name: 'Team', color: null, sortOrder: 1, isDefault: false, isVisible: true },
  };
  const ev: DisplayEvent = {
    id: 'o1', baseEventId: 'b1', calendarIds: ['c1', 'c2'], title: 'T', start: '2026-10-07T08:00:00.000Z', end: '2026-10-07T09:00:00.000Z',
    allDay: false, color: null, location: null, description: null, participants: [], isOrigin: true, recurring: false, timeZone: null,
  };

  it("uses the event's colour, then the first visible calendar's colour, then none (defaultColor)", () => {
    expect(toCalendarInput({ ...ev, color: '#ff0000' }, calendars, new Set())!.color).toBe('#ff0000');
    expect(toCalendarInput(ev, calendars, new Set())!.color).toBe('#1a73e8');
    expect(toCalendarInput(ev, calendars, new Set(['c1']))!.color).toBeUndefined();
  });

  // Review focus 3
  it('keeps an event visible while any of its calendars is visible', () => {
    expect(toCalendarInput(ev, calendars, new Set(['c1']))).not.toBeNull();
    expect(toCalendarInput(ev, calendars, new Set(['c1', 'c2']))).toBeNull();
  });
});

describe('range helpers', () => {
  it('formats UTC dates without milliseconds (JMAP UTCDate)', () => {
    expect(toUtcDate(new Date('2026-10-04T04:00:00.000Z'))).toBe('2026-10-04T04:00:00Z');
  });

  it('builds query → occurrences → base events as one chained request', () => {
    const b = new RequestBuilder();
    const range = { start: '2026-10-04T04:00:00Z', end: '2026-10-11T04:00:00Z' };
    addRangeCalls(b, 'a1', range, 'America/New_York');
    const [q, inst, bases] = b.build([]).methodCalls;
    expect(q![0]).toBe('CalendarEvent/query');
    expect(q![1]).toMatchObject({ accountId: 'a1', filter: { after: range.start, before: range.end }, expandRecurrences: true, timeZone: 'America/New_York' });
    expect(inst![1]['#ids']).toEqual({ resultOf: q![2], name: 'CalendarEvent/query', path: '/ids' });
    expect(bases![1]['#ids']).toEqual({ resultOf: inst![2], name: 'CalendarEvent/get', path: '/list/*/baseEventId' });
    expect(bases![1].properties).toEqual(expect.arrayContaining(['recurrenceOverrides', 'participants', 'locations', 'description']));
    expect(rangeKey(range)).toBe('2026-10-04T04:00:00Z/2026-10-11T04:00:00Z');
  });

  it('accepts a six-week month grid that crosses the autumn DST change (42 local days + 1h)', () => {
    // FullCalendar's Oct 2026 grid in America/New_York: Sep 27 00:00 EDT → Nov 8 00:00 EST.
    const range = { start: '2026-09-27T04:00:00Z', end: '2026-11-08T05:00:00Z' };
    expect(() => addRangeCalls(new RequestBuilder(), 'a1', range, 'America/New_York')).not.toThrow();
  });

  it('refuses ranges longer than six weeks', () => {
    expect(() => addRangeCalls(new RequestBuilder(), 'a1', { start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z' }, 'UTC')).toThrow(/42 days/);
  });
});
