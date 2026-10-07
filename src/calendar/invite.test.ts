import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../jmap/types';
import { describeWhen, findInvitePart, inviteState, myParticipant, rsvpPatch } from './invite';

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
