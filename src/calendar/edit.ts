// Pure edit rules and JMAP patches for calendar events. No Solid imports.
import type { Calendar, CalendarEvent, Id } from '../jmap/types';
import type { DisplayEvent } from './instances';

export type Editability = { editable: true } | { editable: false; reason: string };

/** Whether the user may drag, rename or delete this event, and why not when they may not. */
export function editability(ev: DisplayEvent, calendars: Record<Id, Calendar>): Editability {
  if (ev.recurring) return { editable: false, reason: "Recurring events can't be edited yet." };
  if (!ev.isOrigin) return { editable: false, reason: 'You were invited to this event, so only its organizer can change it.' };
  if (!ev.calendarIds.some((id) => calendars[id]?.myRights?.mayWriteAll === true)) {
    return { editable: false, reason: 'This calendar is read-only.' };
  }
  return { editable: true };
}

/** Whether anyone besides the organizer is on the event (they would be emailed about a change). */
export function hasGuests(ev: DisplayEvent): boolean {
  return ev.participants.some((p) => !p.owner);
}

export function writableCalendars(calendars: Record<Id, Calendar>): Calendar[] {
  return Object.values(calendars)
    .filter((c) => c.myRights?.mayWriteAll === true)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function defaultCalendarId(calendars: Record<Id, Calendar>): Id | undefined {
  const list = writableCalendars(calendars);
  return (list.find((c) => c.isDefault) ?? list[0])?.id;
}

const DAY_MS = 86_400_000;

/** JSCalendar duration for a whole number of milliseconds (seconds precision). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const time = `${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s ? `${s}S` : ''}`;
  if (!days && !time) return 'PT0S';
  return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

/** An instant as "YYYY-MM-DDTHH:mm:ss" wall time in an IANA zone. */
export function localDateTime(d: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** The browser-local calendar date of a Date, "YYYY-MM-DD" (FullCalendar's all-day dates are local midnights). */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days between two local dates (exclusive end), at least 1; a missing end is one day. */
function allDayLength(start: Date, end: Date | null): number {
  if (!end) return 1;
  const a = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const b = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(1, Math.round((b - a) / DAY_MS));
}

/** The default length of a timed event dropped from the all-day row. */
const DEFAULT_TIMED_MS = 3_600_000;

/**
 * The `CalendarEvent/set` patch for a drag or resize. A timed event keeps its own zone (the new
 * wall time is written in it); a floating one uses the browser's zone and stays floating.
 */
export function patchForDrop(ev: DisplayEvent, start: Date, end: Date | null, allDay: boolean, browserZone: string): Record<string, unknown> {
  if (allDay) {
    const patch: Record<string, unknown> = { start: `${localDate(start)}T00:00:00`, duration: `P${allDayLength(start, end)}D` };
    if (!ev.allDay) Object.assign(patch, { showWithoutTime: true, timeZone: null });
    return patch;
  }
  const zone = ev.timeZone ?? browserZone;
  const ms = end ? end.getTime() - start.getTime() : DEFAULT_TIMED_MS;
  const patch: Record<string, unknown> = { start: localDateTime(start, zone), duration: formatDuration(ms) };
  if (ev.allDay) Object.assign(patch, { showWithoutTime: false, timeZone: browserZone });
  return patch;
}

/** The `create` object for a new event from a grid selection (an all-day selection's end is exclusive). */
export function newEventFromSelection(sel: { start: Date; end: Date; allDay: boolean }, calendarId: Id, title: string, browserZone: string): Partial<CalendarEvent> {
  const base = { calendarIds: { [calendarId]: true }, title };
  if (sel.allDay) {
    return { ...base, start: `${localDate(sel.start)}T00:00:00`, showWithoutTime: true, duration: `P${allDayLength(sel.start, sel.end)}D` };
  }
  return { ...base, start: localDateTime(sel.start, browserZone), timeZone: browserZone, duration: formatDuration(sel.end.getTime() - sel.start.getTime()) };
}
