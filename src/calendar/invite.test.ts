import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../jmap/types';
import { canRsvp, describeWhen, findInvitePart, inviteState, myParticipant, rsvpPatch } from './invite';

const part = (type: string, blobId: string | null = 'b1') => ({ partId: 'p', blobId, size: 1, type, name: null, cid: null, disposition: null });

describe('findInvitePart', () => {
  it('finds a text/calendar attachment', () => {
    expect(findInvitePart({ attachments: [part('image/png', 'x'), part('text/calendar', 'cal')] })).toEqual({ blobId: 'cal' });
  });
  it('ignores a part without a blob and any other type', () => {
    expect(findInvitePart({ attachments: [part('text/calendar', null), part('application/pdf')] })).toBeNull();
    expect(findInvitePart({ attachments: [] })).toBeNull();
  });
  it('matches the type with parameters and case', () => {
    expect(findInvitePart({ attachments: [part('TEXT/Calendar; method=REQUEST', 'c')] })).toEqual({ blobId: 'c' });
  });
});

const copy = (p: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e1', uid: 'u1', sequence: 0, status: 'confirmed',
  participants: {
    o: { calendarAddress: 'mailto:Bob@Example.test', roles: { owner: true }, participationStatus: 'accepted' },
    a: { calendarAddress: 'mailto:alice@example.test', roles: { attendee: true }, participationStatus: 'needs-action' },
  },
  ...p,
});

describe('myParticipant', () => {
  it('matches case-insensitively and ignores mailto:', () => {
    expect(myParticipant(copy(), new Set(['alice@example.test']))).toEqual({ id: 'a', status: 'needs-action' });
    expect(myParticipant(copy(), new Set(['bob@example.test']))?.id).toBe('o');
  });
  it('is null when the user is not listed, or there are no participants', () => {
    expect(myParticipant(copy(), new Set(['carol@example.test']))).toBeNull();
    expect(myParticipant(copy({ participants: null }), new Set(['alice@example.test']))).toBeNull();
  });
});

describe('inviteState', () => {
  const mine = { id: 'a', status: 'needs-action' as const };
  it('is missing without a copy, even for a cancellation', () => {
    expect(inviteState({ method: 'request', sequence: 0 }, null, null)).toEqual({ kind: 'missing' });
    expect(inviteState({ method: 'cancel', sequence: 1 }, null, null)).toEqual({ kind: 'missing' });
  });
  it('is cancelled by the message method or the copy status', () => {
    expect(inviteState({ method: 'cancel' }, copy(), mine)).toEqual({ kind: 'cancelled' });
    expect(inviteState({ method: 'request', sequence: 0 }, copy({ status: 'cancelled' }), mine)).toEqual({ kind: 'cancelled' });
  });
  it('is active with the current answer, and updated when the copy is newer than the message', () => {
    expect(inviteState({ method: 'request', sequence: 0 }, copy(), mine)).toEqual({ kind: 'active', answer: 'needs-action', updated: false });
    expect(inviteState({ method: 'request', sequence: 0 }, copy({ sequence: 2 }), { id: 'a', status: 'accepted' })).toEqual({ kind: 'active', answer: 'accepted', updated: true });
    expect(inviteState({ method: 'request', sequence: 2 }, copy({ sequence: 2 }), mine)).toMatchObject({ updated: false });
  });
  it('treats a missing participant as needs-action', () => {
    expect(inviteState({ method: 'request', sequence: 0 }, copy(), null)).toEqual({ kind: 'active', answer: 'needs-action', updated: false });
  });
});

describe('rsvpPatch', () => {
  it('patches the participant status', () => {
    expect(rsvpPatch('a', 'tentative')).toEqual({ 'participants/a/participationStatus': 'tentative' });
  });
});

describe('describeWhen', () => {
  const flat = (s: string) => s.replace(/[   ]/g, ' ');
  it('shows the event zone and the viewer zone when they differ', () => {
    const s = describeWhen({ start: '2026-12-08T10:00:00', timeZone: 'Europe/London', duration: 'PT1H' }, 'America/New_York');
    expect(flat(s)).toBe('Tue 8 Dec, 10:00–11:00 (Europe/London) · 5:00–6:00 AM your time');
  });
  it('omits the second part when the zones are equal, and for floating events', () => {
    expect(describeWhen({ start: '2026-12-08T10:00:00', timeZone: 'Europe/London', duration: 'PT1H' }, 'Europe/London')).toBe('Tue 8 Dec, 10:00–11:00 (Europe/London)');
    expect(describeWhen({ start: '2026-12-08T10:00:00', timeZone: null, duration: 'PT1H' }, 'Europe/London')).toBe('Tue 8 Dec, 10:00–11:00');
  });
  it('shows both meridiems when the viewer range crosses noon', () => {
    const s = describeWhen({ start: '2026-12-08T16:30:00', timeZone: 'Europe/London', duration: 'PT1H' }, 'America/New_York');
    expect(flat(s)).toBe('Tue 8 Dec, 16:30–17:30 (Europe/London) · 11:30 AM–12:30 PM your time');
  });
  it('shows an all-day event as dates only', () => {
    expect(describeWhen({ start: '2026-12-08T00:00:00', showWithoutTime: true, duration: 'P1D' }, 'America/New_York')).toBe('Tue 8 Dec');
    expect(describeWhen({ start: '2026-12-08T00:00:00', showWithoutTime: true, duration: 'P3D' }, 'America/New_York')).toBe('Tue 8 Dec – Thu 10 Dec');
  });
  it('returns an empty string for an event without a start', () => {
    expect(describeWhen({}, 'UTC')).toBe('');
  });
});

describe('canRsvp', () => {
  const calendars = { c1: { id: 'c1', name: 'c', color: null, sortOrder: 0, isDefault: true, isVisible: true, myRights: { mayRSVP: true } } };
  const mine = { id: 'a', status: 'needs-action' as const };
  const guestCopy = (p: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: 'e', calendarIds: { c1: true }, isOrigin: false, ...p });
  it('allows a guest on a calendar that permits answering', () => {
    expect(canRsvp(guestCopy(), mine, calendars)).toBe(true);
  });
  it('refuses the organiser: answering would email every guest', () => {
    expect(canRsvp(guestCopy({ isOrigin: true }), mine, calendars)).toBe(false);
  });
  it('refuses without a copy, a participant, or mayRSVP', () => {
    expect(canRsvp(null, mine, calendars)).toBe(false);
    expect(canRsvp(guestCopy(), null, calendars)).toBe(false);
    expect(canRsvp(guestCopy(), mine, { c1: { ...calendars.c1, myRights: { mayRSVP: false } } })).toBe(false);
  });
});

describe('describeWhen with a zone or start Intl rejects', () => {
  it('does not throw on a custom time zone id; it shows the wall time as floating', () => {
    expect(describeWhen({ start: '2026-12-08T10:00:00', timeZone: '/Customized Time Zone', duration: 'PT1H' }, 'UTC')).toBe('Tue 8 Dec, 10:00–11:00');
    expect(describeWhen({ start: '2026-12-08T10:00:00', timeZone: 'W. Europe Standard Time', duration: 'PT1H' }, 'UTC')).toBe('Tue 8 Dec, 10:00–11:00');
  });
  it('does not throw on an unparsable start', () => {
    expect(describeWhen({ start: 'garbage', timeZone: 'UTC', duration: 'PT1H' }, 'UTC')).toBe('');
  });
});

describe('describeWhen details', () => {
  const flat = (s: string) => s.replace(/[\u202f\u2009\u00a0]/g, ' ');
  it('names the viewer day when it differs from the event day', () => {
    const s = describeWhen({ start: '2026-12-08T01:00:00', timeZone: 'Europe/London', duration: 'PT1H' }, 'America/New_York');
    expect(flat(s)).toBe('Tue 8 Dec, 01:00–02:00 (Europe/London) · Mon 7 Dec 8:00–9:00 PM your time');
  });
  it('shows the end day of an overnight or multi-day event', () => {
    expect(describeWhen({ start: '2026-12-08T23:00:00', timeZone: 'Europe/London', duration: 'PT2H' }, 'Europe/London')).toBe('Tue 8 Dec, 23:00 – Wed 9 Dec, 01:00 (Europe/London)');
    expect(describeWhen({ start: '2026-12-08T10:00:00', timeZone: 'Europe/London', duration: 'P2D' }, 'Europe/London')).toBe('Tue 8 Dec, 10:00 – Thu 10 Dec, 10:00 (Europe/London)');
  });
  it('shows only the start of an event without a duration', () => {
    expect(describeWhen({ start: '2026-12-08T10:00:00', timeZone: 'Europe/London' }, 'Europe/London')).toBe('Tue 8 Dec, 10:00 (Europe/London)');
  });
  it('moves a start inside the spring-forward gap to the hour after it', () => {
    expect(describeWhen({ start: '2026-03-08T02:30:00', timeZone: 'America/New_York', duration: 'PT1H' }, 'America/New_York')).toBe('Sun 8 Mar, 03:30–04:30 (America/New_York)');
  });
  it('treats zone names that mean the same time as the same zone', () => {
    expect(describeWhen({ start: '2026-12-08T10:00:00', timeZone: 'Etc/UTC', duration: 'PT1H' }, 'UTC')).toBe('Tue 8 Dec, 10:00–11:00 (Etc/UTC)');
  });
});
