// Pure calendar logic: the range request and the occurrence merge. No Solid imports.
import type { RequestBuilder } from '../jmap/request';
import type { Calendar, CalendarEvent, Id } from '../jmap/types';

/** A visible date range, as JMAP UTCDate strings (no milliseconds). */
export interface Range {
  start: string;
  end: string;
}

export interface DisplayParticipant {
  name: string;
  address: string;
  status: string;
  /** Has the iCalendar `owner` role: the organizer, not a guest. */
  owner: boolean;
}

/** One occurrence, merged with its base event, ready for display. */
export interface DisplayEvent {
  id: Id;
  baseEventId: Id;
  calendarIds: Id[];
  title: string;
  /** Timed: UTC ISO instant. All-day: "YYYY-MM-DD". */
  start: string;
  /** Timed: UTC ISO instant. All-day: exclusive "YYYY-MM-DD". */
  end: string;
  allDay: boolean;
  color: string | null;
  location: string | null;
  description: string | null;
  participants: DisplayParticipant[];
  /** This copy is the organizer's, or the event has no other participants. */
  isOrigin: boolean;
  recurring: boolean;
  /** The event's own zone; null for all-day and floating events. */
  timeZone: string | null;
}

/** The event shape handed to FullCalendar. */
export interface CalendarInput {
  id: Id;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  color?: string;
}

const DAY_MS = 86_400_000;
/** FullCalendar's month view spans 6 weeks; the server allows 52. */
const MAX_RANGE_DAYS = 42;

const OCCURRENCE_PROPS = ['id', 'baseEventId', 'recurrenceId', 'calendarIds', 'start', 'utcStart'];
const BASE_PROPS = [
  'id', 'calendarIds', 'title', 'description', 'start', 'timeZone', 'duration', 'showWithoutTime',
  'color', 'locations', 'participants', 'recurrenceOverrides', 'isOrigin', 'recurrenceRule',
];

export function toUtcDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function rangeKey(r: Range): string {
  return `${r.start}/${r.end}`;
}

const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** JSCalendar Duration → whole days plus a time part. Missing or malformed means zero. */
export function parseDuration(d?: string | null): { days: number; ms: number } {
  const m = d ? DURATION.exec(d) : null;
  if (!m) return { days: 0, ms: 0 };
  const [, w, dd, h, mi, s] = m;
  return {
    days: Number(w ?? 0) * 7 + Number(dd ?? 0),
    ms: ((Number(h ?? 0) * 60 + Number(mi ?? 0)) * 60 + Number(s ?? 0)) * 1000,
  };
}

/** Add the three chained calls for one range: query → occurrences → their base events. */
export function addRangeCalls(b: RequestBuilder, accountId: Id, range: Range, timeZone: string) {
  // A day of slack: a 42-local-day grid spans 42 days + 1h in UTC across the autumn DST change.
  if (Date.parse(range.end) - Date.parse(range.start) > (MAX_RANGE_DAYS + 1) * DAY_MS) {
    throw new Error(`calendar range ${rangeKey(range)} is longer than ${MAX_RANGE_DAYS} days`);
  }
  const query = b.call('CalendarEvent/query', {
    accountId,
    filter: { after: range.start, before: range.end },
    expandRecurrences: true,
    timeZone,
    sort: [{ property: 'start', isAscending: true }],
  });
  const instances = b.call('CalendarEvent/get', { accountId, '#ids': query.ref('/ids'), properties: OCCURRENCE_PROPS });
  const bases = b.call('CalendarEvent/get', { accountId, '#ids': instances.ref('/list/*/baseEventId'), properties: BASE_PROPS });
  return { query, instances, bases };
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Top-level keys of a PatchObject; JSON-pointer paths ("a/b") are not needed for display. */
function topLevel(patch: Record<string, unknown> | undefined): Partial<CalendarEvent> {
  if (!patch) return {};
  return Object.fromEntries(Object.entries(patch).filter(([k]) => !k.includes('/'))) as Partial<CalendarEvent>;
}

function toDisplayEvent(occurrence: CalendarEvent, base: CalendarEvent | undefined): DisplayEvent | null {
  // Stalwart returns an overridden occurrence sparse: only the overridden properties, and a
  // bogus duration when duration wasn't overridden. So everything but start/utcStart comes
  // from the base event plus its override for this recurrenceId.
  const source = base ?? occurrence;
  const patch = occurrence.recurrenceId ? source.recurrenceOverrides?.[occurrence.recurrenceId] : undefined;
  if (patch?.excluded === true) return null;
  const e: CalendarEvent = { ...source, ...topLevel(patch) };
  const start = occurrence.start ?? e.start;
  const cals = occurrence.calendarIds ?? e.calendarIds ?? {};
  const { days, ms } = parseDuration(e.duration);
  const common = {
    id: occurrence.id,
    baseEventId: occurrence.baseEventId ?? occurrence.id,
    calendarIds: Object.keys(cals).filter((k) => cals[k]),
    title: e.title?.trim() || '(No title)',
    color: e.color ?? null,
    location: Object.values(e.locations ?? {}).find((l) => l?.name)?.name ?? null,
    description: e.description?.trim() || null,
    isOrigin: source.isOrigin === true,
    recurring: !!source.recurrenceRule,
    timeZone: e.timeZone ?? null,
    participants: Object.values(e.participants ?? {}).map((p) => {
      const address = (p.calendarAddress ?? '').replace(/^mailto:/i, '');
      return { name: p.name?.trim() || address, address, status: p.participationStatus ?? 'needs-action', owner: !!p.roles?.owner };
    }),
  };
  if (e.showWithoutTime) {
    if (!start) return null;
    const day = start.slice(0, 10);
    return { ...common, allDay: true, start: day, end: addDays(day, Math.max(1, days)) };
  }
  if (!occurrence.utcStart) return null;
  const t = Date.parse(occurrence.utcStart);
  return { ...common, allDay: false, start: new Date(t).toISOString(), end: new Date(t + days * DAY_MS + ms).toISOString() };
}

export function toDisplayEvents(instances: CalendarEvent[], bases: CalendarEvent[]): DisplayEvent[] {
  const byId = new Map(bases.map((b) => [b.id, b]));
  const out: DisplayEvent[] = [];
  for (const occurrence of instances) {
    const d = toDisplayEvent(occurrence, occurrence.baseEventId ? byId.get(occurrence.baseEventId) : undefined);
    if (d) out.push(d);
  }
  return out;
}

/** FullCalendar input for an event, or null when every calendar it belongs to is hidden. */
export function toCalendarInput(ev: DisplayEvent, calendars: Record<Id, Calendar>, hidden: ReadonlySet<Id>): CalendarInput | null {
  const calendarId = ev.calendarIds.find((id) => !hidden.has(id));
  if (!calendarId) return null;
  const color = ev.color ?? calendars[calendarId]?.color ?? undefined;
  return { id: ev.id, title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, ...(color ? { color } : {}) };
}
