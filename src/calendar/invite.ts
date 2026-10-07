// Pure invitation logic: finding the calendar part, the card's state, and its time text. No Solid imports.
import type { Calendar, CalendarEvent, CalendarParticipant, EmailBodyPart, Id } from '../jmap/types';
import { parseDuration } from './instances';

export type ParticipationStatus = NonNullable<CalendarParticipant['participationStatus']>;

export type InviteState =
  | { kind: 'active'; answer: ParticipationStatus; updated: boolean }
  | { kind: 'cancelled' }
  | { kind: 'missing' };

/** The `text/calendar` part of a message, if it has a blob to parse. */
export function findInvitePart(email: { attachments?: EmailBodyPart[] | null }): { blobId: string } | null {
  const p = (email.attachments ?? []).find((a) => a.blobId && a.type.split(';')[0]!.trim().toLowerCase() === 'text/calendar');
  return p ? { blobId: p.blobId! } : null;
}

export function myParticipant(copy: CalendarEvent, myAddresses: ReadonlySet<string>): { id: string; status: ParticipationStatus } | null {
  for (const [id, p] of Object.entries(copy.participants ?? {})) {
    const address = (p.calendarAddress ?? '').replace(/^mailto:/i, '').toLowerCase();
    if (address && myAddresses.has(address)) return { id, status: p.participationStatus ?? 'needs-action' };
  }
  return null;
}

export function inviteState(
  parsed: { method?: string | null; sequence?: number },
  copy: CalendarEvent | null,
  mine: { id: string; status: ParticipationStatus } | null,
): InviteState {
  if (!copy) return { kind: 'missing' };
  if (parsed.method === 'cancel' || copy.status === 'cancelled') return { kind: 'cancelled' };
  return { kind: 'active', answer: mine?.status ?? 'needs-action', updated: (copy.sequence ?? 0) > (parsed.sequence ?? 0) };
}

/** Whether the user may answer: a guest (not the organiser, whose answer would email everyone) on a calendar that allows it. */
export function canRsvp(copy: CalendarEvent | null, mine: { id: string } | null, calendars: Record<Id, Calendar>): boolean {
  if (!copy || !mine || copy.isOrigin === true) return false;
  return Object.keys(copy.calendarIds ?? {}).some((id) => calendars[id]?.myRights?.mayRSVP === true);
}

export function rsvpPatch(participantId: string, status: 'accepted' | 'tentative' | 'declined'): Record<string, string> {
  return { [`participants/${participantId}/participationStatus`]: status };
}

const DAY_MS = 86_400_000;

/** The UTC instant at which a wall-clock time ("YYYY-MM-DDTHH:mm:ss") occurs in an IANA zone. */
function zonedInstant(local: string, zone: string): number {
  const asUtc = Date.parse(`${local}Z`);
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(t)).map((x) => [x.type, x.value]),
    );
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - t;
  };
  // Two passes settle across a DST boundary.
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

const dayText = (d: Date, zone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`;
};

const clock24 = (d: Date, zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

function clock12(a: Date, b: Date, zone: string): string {
  const part = (d: Date) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d).map((x) => [x.type, x.value]));
    return { time: `${p.hour}:${p.minute}`, period: String(p.dayPeriod).toUpperCase() };
  };
  const s = part(a);
  const e = part(b);
  return s.period === e.period ? `${s.time}–${e.time} ${e.period}` : `${s.time} ${s.period}–${e.time} ${e.period}`;
}

/** "Tue 8 Dec, 10:00–11:00 (Europe/London) · 5:00–6:00 AM your time"; the second part only when the zones differ. */
export function describeWhen(event: Pick<CalendarEvent, 'start' | 'timeZone' | 'duration' | 'showWithoutTime'>, viewerZone: string): string {
  try {
    return describe(event, viewerZone);
  } catch {
    // A zone Intl doesn't know (a custom id such as "/Customized Time Zone"): show the wall time as floating.
    try {
      return describe({ ...event, timeZone: null }, viewerZone);
    } catch {
      return '';
    }
  }
}

function describe(event: Pick<CalendarEvent, 'start' | 'timeZone' | 'duration' | 'showWithoutTime'>, viewerZone: string): string {
  if (!event.start) return '';
  const { days, ms } = parseDuration(event.duration);
  if (event.showWithoutTime) {
    const first = new Date(`${event.start.slice(0, 10)}T00:00:00Z`);
    const last = new Date(first.getTime() + (Math.max(1, days) - 1) * DAY_MS);
    return last > first ? `${dayText(first, 'UTC')} – ${dayText(last, 'UTC')}` : dayText(first, 'UTC');
  }
  const zone = event.timeZone || viewerZone;
  const start = new Date(zonedInstant(event.start, zone));
  const end = new Date(start.getTime() + days * DAY_MS + ms);
  const own = `${dayText(start, zone)}, ${clock24(start, zone)}–${clock24(end, zone)}`;
  if (!event.timeZone) return own;
  const base = `${own} (${event.timeZone})`;
  return event.timeZone === viewerZone ? base : `${base} · ${clock12(start, end, viewerZone)} your time`;
}
