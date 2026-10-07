import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, StateChange } from '../jmap/types';
import { FakeJmap } from '../sync/fake-jmap';
import { CalendarStore } from './store';

const WEEK1 = { start: '2026-10-04T00:00:00Z', end: '2026-10-11T00:00:00Z' };
const WEEK2 = { start: '2026-10-11T00:00:00Z', end: '2026-10-18T00:00:00Z' };

const occ = (id: string, utcStart: string): CalendarEvent => ({
  id, baseEventId: 'b1', recurrenceId: utcStart.slice(0, 19), calendarIds: { c1: true }, start: utcStart.slice(0, 19), utcStart,
});
const change = (CalendarEvent: string): StateChange => ({ '@type': 'StateChange', changed: { a1: { CalendarEvent } } });

function setup() {
  const server = new FakeJmap();
  server.calendars.set('c1', { id: 'c1', name: 'Personal', color: '#1a73e8', sortOrder: 0, isDefault: true, isVisible: true });
  server.baseEvents.set('b1', { id: 'b1', calendarIds: { c1: true }, title: 'Standup', start: '2026-10-05T09:00:00', timeZone: 'UTC', duration: 'PT30M' });
  server.occurrences.push(occ('o1', '2026-10-05T09:00:00Z'), occ('o2', '2026-10-12T09:00:00Z'));
  const toast = vi.fn();
  const client = server.client();
  const store = createRoot(() => new CalendarStore(client, toast, 'UTC'));
  const queries = () => server.calls.filter((c) => c === 'CalendarEvent/query').length;
  return { server, client, store, toast, queries };
}

describe('CalendarStore', () => {
  it('loads calendars', async () => {
    const { store } = setup();
    await store.loadCalendars();
    expect(store.state.calendars.c1?.name).toBe('Personal');
  });

  it('shows the merged events of a range', async () => {
    const { store } = setup();
    await store.show(WEEK1);
    expect(store.state.events.map((e) => [e.id, e.title, e.end])).toEqual([['o1', 'Standup', '2026-10-05T09:30:00.000Z']]);
    expect(store.state.loading).toBe(false);
  });

  it('serves a revisited range from the cache', async () => {
    const { store, queries } = setup();
    await store.show(WEEK1);
    await store.show(WEEK2);
    await store.show(WEEK1);
    expect(queries()).toBe(2);
    expect(store.state.events.map((e) => e.id)).toEqual(['o1']);
  });

  it('applies only the newest request when an older response arrives late', async () => {
    const { server, store } = setup();
    let release!: () => void;
    server.holds.push(new Promise<void>((r) => (release = r)));
    const slow = store.show(WEEK1);
    await store.show(WEEK2);
    release();
    await slow;
    expect(store.state.events.map((e) => e.id)).toEqual(['o2']);
  });

  it('clears the cache and refetches the visible range when CalendarEvent state changes', async () => {
    const { server, store, queries } = setup();
    await store.show(WEEK1);
    server.baseEvents.get('b1')!.title = 'Renamed';
    server.calendarEventState++;
    store.onStateChange(change(`ce${server.calendarEventState}`));
    await vi.waitFor(() => expect(store.state.events[0]?.title).toBe('Renamed'));
    const before = queries();
    await store.show(WEEK2);
    expect(queries()).toBe(before + 1);
  });

  it('ignores a state change it has already seen', async () => {
    const { store, queries } = setup();
    await store.show(WEEK1);
    store.onStateChange(change('ce0'));
    await Promise.resolve();
    expect(queries()).toBe(1);
  });

  // Review focus 4
  it('does not cache a response that was in flight when the state changed', async () => {
    const { server, store, queries } = setup();
    let release!: () => void;
    server.holds.push(new Promise<void>((r) => (release = r)));
    const stale = store.show(WEEK1); // answered with 'Standup', delivered later
    server.baseEvents.get('b1')!.title = 'Renamed';
    server.calendarEventState++;
    store.onStateChange(change('ce1'));
    await vi.waitFor(() => expect(store.state.events[0]?.title).toBe('Renamed'));
    release();
    await stale;
    expect(store.state.events[0]?.title).toBe('Renamed');
    await store.show(WEEK2);
    const before = queries();
    await store.show(WEEK1); // from cache, and the cache must hold the fresh result
    expect(queries()).toBe(before);
    expect(store.state.events[0]?.title).toBe('Renamed');
  });

  it('drops other cached ranges when a fetch sees a newer state than the one they were fetched at', async () => {
    const { server, store } = setup();
    await store.show(WEEK1); // cached at ce0
    server.baseEvents.get('b1')!.title = 'Renamed'; // changed from another device
    server.calendarEventState++;
    await store.show(WEEK2); // fetched at ce1, before the push arrives
    store.onStateChange(change('ce1')); // already seen, so ignored
    await store.show(WEEK1);
    expect(store.state.events[0]?.title).toBe('Renamed');
  });

  it('refetches after a push reconnect', async () => {
    const { store, queries } = setup();
    await store.show(WEEK1);
    store.onConnected();
    await vi.waitFor(() => expect(queries()).toBe(2));
  });

  it('keeps the events on screen and toasts once per failure streak', async () => {
    const { server, store, toast } = setup();
    await store.show(WEEK1);
    server.failCalendarQueries = true;
    await store.show(WEEK2);
    await store.show(WEEK2);
    expect(store.state.events.map((e) => e.id)).toEqual(['o1']);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![1]).toBe('error');
    server.failCalendarQueries = false;
    await store.show(WEEK2);
    expect(store.state.events.map((e) => e.id)).toEqual(['o2']);
    server.failCalendarQueries = true;
    await store.refresh();
    expect(toast).toHaveBeenCalledTimes(2);
  });

  // Review focus 5
  it('does nothing when the session has no calendars account', async () => {
    const { server, client, store } = setup();
    client.useSession({ ...client.session, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' } });
    await store.show(WEEK1);
    await store.loadCalendars();
    store.onConnected();
    store.onStateChange(change('ce5'));
    expect(server.calls.filter((c) => c.startsWith('Calendar'))).toEqual([]);
  });

  it('toggles hidden calendars and persists them', () => {
    localStorage.clear();
    const { store } = setup();
    expect(store.hidden().has('c1')).toBe(false);
    store.toggleHidden('c1');
    expect(store.hidden().has('c1')).toBe(true);
    expect(JSON.parse(localStorage.getItem('oinbox.calendar.hidden')!)).toEqual(['c1']);
    store.toggleHidden('c1');
    expect(store.hidden().has('c1')).toBe(false);
  });
});

describe('CalendarStore writes', () => {
  it('creates an event without notifying, then refetches the range', async () => {
    const { server, store, queries } = setup();
    await store.show(WEEK1);
    const before = queries();
    const r = await store.createEvent({ calendarIds: { c1: true }, title: 'Dentist', start: '2026-10-06T14:00:00', timeZone: 'UTC', duration: 'PT1H' });
    expect(r).toEqual({ ok: true });
    expect(server.calendarSets[0]).toMatchObject({ sendSchedulingMessages: false, create: { new: { title: 'Dentist' } } });
    await vi.waitFor(() => expect(queries()).toBeGreaterThan(before));
    await vi.waitFor(() => expect(store.state.events.map((e) => e.title)).toContain('Dentist'));
  });

  it('updates by base event id and passes the notify choice', async () => {
    const { server, store } = setup();
    await store.show(WEEK1);
    expect(await store.updateEvent('b1', { start: '2026-10-05T10:00:00' }, true)).toEqual({ ok: true });
    expect(server.calendarSets[0]).toMatchObject({ sendSchedulingMessages: true, update: { b1: { start: '2026-10-05T10:00:00' } } });
  });

  it('deletes by base event id', async () => {
    const { server, store } = setup();
    await store.show(WEEK1);
    expect(await store.deleteEvent('b1', false)).toEqual({ ok: true });
    expect(server.calendarSets[0]).toMatchObject({ sendSchedulingMessages: false, destroy: ['b1'] });
    await vi.waitFor(() => expect(store.state.events).toEqual([]));
  });

  it('reports a vanished event and refetches', async () => {
    const { store, queries } = setup();
    await store.show(WEEK1);
    const before = queries();
    expect(await store.updateEvent('nope', { title: 'x' }, false)).toEqual({ ok: false, error: 'That event no longer exists.' });
    await vi.waitFor(() => expect(queries()).toBeGreaterThan(before));
  });

  it('returns a server failure instead of throwing', async () => {
    const { server, store } = setup();
    server.failCalendarSets = true;
    const r = await store.updateEvent('b1', { title: 'x' }, false);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining('calendar store unavailable') });
  });
});

describe('invitations', () => {
  const invite = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: 'x', uid: 'u1', method: 'request', sequence: 0, title: 'Review', ...over });

  it('parses an invitation blob', async () => {
    const { server, store } = setup();
    server.parsedBlobs.set('blob1', [invite()]);
    expect(await store.parseInvite('blob1')).toEqual({ ok: true, event: expect.objectContaining({ uid: 'u1' }) });
  });
  it('fails softly when the blob is unknown or yields no event', async () => {
    const { server, store } = setup();
    expect(await store.parseInvite('nope')).toEqual({ ok: false });
    server.parsedBlobs.set('empty', []);
    expect(await store.parseInvite('empty')).toEqual({ ok: false });
  });
  it('sends the parse capability in using', async () => {
    const { server, store } = setup();
    server.parsedBlobs.set('b', [invite()]);
    await store.parseInvite('b');
    expect(server.usings.at(-1)).toContain('urn:ietf:params:jmap:calendars:parse');
  });

  it('finds the copy by uid within the window, otherwise by scanning', async () => {
    const { server, store } = setup();
    server.baseEvents.set('b1', { ...server.baseEvents.get('b1')!, uid: 'u-near' });
    server.baseEvents.set('far', { id: 'far', uid: 'u-far', calendarIds: { c1: true }, title: 'Far', start: '2027-06-01T09:00:00', timeZone: 'UTC' });
    expect((await store.findByUid('u-near', '2026-10-05T09:00:00'))?.id).toBe('b1');
    expect((await store.findByUid('u-far', '2026-10-05T09:00:00'))?.id).toBe('far');
    expect(await store.findByUid('missing', '2026-10-05T09:00:00')).toBeNull();
  });
  it('rejects when the lookup itself fails, instead of reporting the copy missing, and retries next time', async () => {
    const { server, store } = setup();
    server.baseEvents.set('b1', { ...server.baseEvents.get('b1')!, uid: 'u1' });
    server.failCalendarQueries = true;
    await expect(store.findByUid('u1')).rejects.toThrow();
    server.failCalendarQueries = false;
    expect((await store.findByUid('u1'))?.id).toBe('b1');
  });
  it('caches a lookup until the store is refreshed', async () => {
    const { server, store } = setup();
    server.baseEvents.set('b1', { ...server.baseEvents.get('b1')!, uid: 'u1' });
    const gets = () => server.calls.filter((c) => c === 'CalendarEvent/get').length;
    await store.findByUid('u1');
    const before = gets();
    await store.findByUid('u1');
    expect(gets()).toBe(before);
    const v = store.version();
    await store.refresh();
    expect(store.version()).toBe(v + 1);
    await store.findByUid('u1');
    expect(gets()).toBeGreaterThan(before);
  });

  it('answers with scheduling messages on, patching only the participant status', async () => {
    const { server, store } = setup();
    expect(await store.rsvp('b1', 'a', 'accepted')).toEqual({ ok: true });
    expect(server.calendarSets.at(-1)).toMatchObject({ sendSchedulingMessages: true, update: { b1: { 'participants/a/participationStatus': 'accepted' } } });
  });
  it('parses a blob once; a parsed invitation never changes', async () => {
    const { server, store } = setup();
    server.parsedBlobs.set('b', [invite()]);
    await store.parseInvite('b');
    await store.parseInvite('b');
    expect(server.calls.filter((c) => c === 'CalendarEvent/parse')).toHaveLength(1);
  });
  it('does not cache a failed parse', async () => {
    const { server, store } = setup();
    expect(await store.parseInvite('late')).toEqual({ ok: false });
    server.parsedBlobs.set('late', [invite()]);
    expect((await store.parseInvite('late')).ok).toBe(true);
  });
  it('reads a server without the parse capability as no invitation', async () => {
    const { server, store } = setup();
    server.parseSupported = false;
    server.parsedBlobs.set('b', [invite()]);
    expect(await store.parseInvite('b')).toEqual({ ok: false });
    expect(server.calls).not.toContain('CalendarEvent/parse');
  });
  it('finds a copy beyond the first page of a scan', async () => {
    const { server, store } = setup();
    for (let i = 0; i < 650; i++) server.baseEvents.set(`bulk${i}`, { id: `bulk${i}`, uid: `bulk-uid-${i}`, calendarIds: { c1: true }, title: 'x', start: '2030-01-01T09:00:00', timeZone: 'UTC' });
    server.baseEvents.set('late', { id: 'late', uid: 'u-late', calendarIds: { c1: true }, title: 'L', start: '2031-01-01T09:00:00', timeZone: 'UTC' });
    expect((await store.findByUid('u-late'))?.id).toBe('late');
  });
  it('refuses a second answer for the same event while one is in flight', async () => {
    const { server, store } = setup();
    let release!: () => void;
    server.holds.push(new Promise<void>((r) => (release = r)));
    const first = store.rsvp('b1', 'a', 'accepted');
    expect(store.answering().has('b1')).toBe(true);
    expect(await store.rsvp('b1', 'a', 'declined')).toEqual({ ok: false, error: 'A reply is already being sent.' });
    release();
    await first;
    expect(store.answering().has('b1')).toBe(false);
    expect(server.calendarSets).toHaveLength(1);
  });
  it('reports a refused answer', async () => {
    const { server, store } = setup();
    expect(await store.rsvp('gone', 'a', 'declined')).toEqual({ ok: false, error: 'That event no longer exists.' });
    server.failCalendarSets = true;
    expect((await store.rsvp('b1', 'a', 'declined')).ok).toBe(false);
  });
});
