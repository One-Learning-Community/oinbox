# Calendar slice 1 (read-only views) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `/calendar` page to oinbox. It shows Alice's Stalwart events in month, week and day views, and it updates live through JMAP push.

**Architecture:** The data comes from the server one visible date range at a time, with no local mirror. Each range is one JMAP request with three calls:
1. `CalendarEvent/query` with `expandRecurrences`, which returns one id per occurrence.
2. `CalendarEvent/get` for those occurrences.
3. `CalendarEvent/get` for their base events.

Each occurrence is merged with its base event and its `recurrenceOverrides`, because Stalwart returns moved occurrences incomplete. The result is held in an in-memory `CalendarStore` and rendered with `@rozie-ui/fullcalendar-solid`.

**Tech Stack:** SolidJS 1.9, TypeScript (strict), Vite 8, vitest 5 (jsdom), Playwright, `@rozie-ui/fullcalendar-solid` 0.1.x + `@fullcalendar/{core,daygrid,timegrid,interaction}` 6.1, `@rozie-ui/popover-solid` (already a dependency), Stalwart 0.16.23.

**Spec:** `docs/superpowers/specs/2026-09-28-calendar-slice1-design.md`

## Global Constraints

- Nothing in this slice writes to the server's calendar data. The only exception is the dev seed script.
- The JSCalendar fields follow Stalwart's newer draft: the singular `recurrenceRule`, participants' `calendarAddress: "mailto:…"`, and `organizerCalendarAddress`. Never use `recurrenceRules`, `email` or `sendTo`, because Stalwart silently drops or rejects them.
- The display start of a timed occurrence is the server's `utcStart`. Its end is `utcStart` + the merged `duration`. Never use the server's `utcEnd`.
- Range queries pass the browser's time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). All-day events use the date part of their `start` and never go through `Date` time-zone conversion.
- Views never exceed 6 weeks (42 days). The server allows 52 weeks.
- `ui/` code reads stores and never calls `jmap/` directly.
- The OAuth scope adds `urn:ietf:params:oauth:scope:calendars`. Stalwart 0.16.23 does not enforce scopes, so nobody is signed out.
- Hidden calendars are a per-browser preference in `localStorage` (`oinbox.calendar.hidden`). The view is saved at `oinbox.calendar.view`.
- The default event colour is the `--cal-default` token (`#0b57d0` in both themes). It is not `--accent`.
- rozie component gaps go in `docs/rozie-feedback.md` and are never patched silently in `node_modules`.
- Commit trailer, on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz
  ```
- Commands: `pnpm test` (vitest), `pnpm typecheck`, `pnpm build`, `pnpm e2e` (needs the stack from `deploy/`; see `e2e/README.md`).

## Review Focus

1. **A timed event that crosses midnight or lasts several days** (for example 22:00 plus `P1DT2H`). It must end at the right instant on a later day, not on the start day. The test is in Task 2.
2. **An event with no `duration`** (JSCalendar's default is zero). It must render as a zero-length event at its start and must not throw. The test is in Task 2.
3. **An event in two calendars when one of them is hidden.** It must still show, in the visible calendar's colour. If both are hidden it disappears. The test is in Task 2.
4. **A push notification during an in-flight range fetch.** The older response must neither replace the newer events on screen nor be cached. The test is in Task 3.
5. **A server or session without JMAP Calendars.** The store must make no requests, the nav entry and `g k` must be hidden, and `/calendar` must redirect to the inbox. The store test is in Task 3; the UI is covered by `hasCalendars()` in Tasks 5 and 6.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `package.json`, `pnpm-lock.yaml` | modify | add the calendar dependencies |
| `src/jmap/types.ts` | modify | `CALENDARS` capability; `Calendar`, `CalendarEvent` and related types; method typings |
| `src/jmap/sse.ts` | modify | subscribe to `Calendar,CalendarEvent` push types |
| `src/index.tsx` | modify | OAuth scope, create the `CalendarStore`, send push and reconnect events to it, `/calendar` route |
| `src/calendar/instances.ts` | create | pure functions: range calls, duration parsing, occurrence merge, FullCalendar input |
| `src/calendar/instances.test.ts` | create | merge and edge-case tests |
| `src/calendar/store.ts` | create | `CalendarStore`: calendars, events for the visible range, cache, push, hidden calendars |
| `src/calendar/store.test.ts` | create | store behaviour against `FakeJmap` |
| `src/calendar/prefs.ts` (+ `.test.ts`) | create | `localStorage` preferences for the view and hidden calendars |
| `src/calendar/format.ts` (+ `.test.ts`) | create | the popover's human-readable "when" line |
| `src/sync/fake-jmap.ts` | modify | calendar methods, response holds, calendars capability in the session |
| `src/app/context.tsx` | modify | `calendar` and `hasCalendars` on `App` |
| `src/ui/CalendarView.tsx` | create | FullCalendar wrapper, event popover |
| `src/ui/Shell.tsx` | modify | Calendar nav entry and the calendar list with show/hide checkboxes |
| `src/ui/keyboard.ts`, `src/ui/Overlays.tsx`, `src/ui/icons.tsx` | modify | the `g k` shortcut, its help row, and a `calendar` icon |
| `src/ui/styles.css` | modify | `--cal-default`, the FullCalendar theme variables, calendar layout |
| `deploy/seed/seed_calendar.py` | create | idempotent calendar seed data |
| `deploy/seed.sh`, `deploy/README.md` | modify | run the calendar seed and document it |
| `e2e/support/mail.ts` | modify | `jmap()` takes an optional `using` list |
| `e2e/support/calendar.ts` | create | calendar JMAP helpers for specs |
| `e2e/calendar.spec.ts` | create | end-to-end calendar tests |
| `docs/rozie-feedback.md` | modify | FullCalendar and Popover findings |

---

### Task 1: JMAP calendar types, push subscription, OAuth scope and dependencies

**Files:**
- Modify: `package.json` (via pnpm)
- Modify: `src/jmap/types.ts` (capability constants at the top; types before `export interface Methods`; three entries inside `Methods`)
- Modify: `src/jmap/sse.ts:78` (the `eventSourceUrl(...)` argument)
- Modify: `src/index.tsx:24` (the default scope)
- Test: `src/jmap/sse.test.ts`

**Interfaces:**
- Produces: `CALENDARS` (string constant); the types `Calendar`, `CalendarEvent`, `CalendarParticipant`, `CalendarLocation`, `CalendarEventFilter` and `CalendarEventQueryArgs`; and the `Methods` entries `'Calendar/get'`, `'CalendarEvent/query'` and `'CalendarEvent/get'`. `PUSH_TYPES` is exported from `sse.ts`.

- [ ] **Step 1: Install the calendar dependencies**

Run:
```bash
pnpm add @rozie-ui/fullcalendar-solid@^0.1.10 @fullcalendar/core@^6.1 @fullcalendar/daygrid@^6.1 @fullcalendar/timegrid@^6.1 @fullcalendar/interaction@^6.1
```
Expected: `package.json` lists all five packages and the install exits 0.

- [ ] **Step 2: Write the failing push-subscription test**

Append this inside the existing `describe('openPushStream', ...)` in `src/jmap/sse.test.ts`:

```ts
  it('subscribes to mail and calendar state changes', async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, body: droppedStream() } as unknown as Response;
    };
    const client = new JmapClient({ sessionUrl: 'http://fake/session', getToken: async () => 't', fetch: fetchImpl as unknown as typeof fetch });
    client.useSession({ ...fakeSession(), eventSourceUrl: 'http://fake/events?types={types}&closeafter={closeafter}&ping={ping}' });
    const close = openPushStream(client, { onStateChange: () => {} });
    try {
      await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
      const types = new URL(urls[0]!).searchParams.get('types')!.split(',');
      expect(types).toEqual(expect.arrayContaining(['Email', 'Mailbox', 'Thread', 'EmailDelivery', 'Calendar', 'CalendarEvent']));
    } finally {
      close();
    }
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run src/jmap/sse.test.ts -t "calendar state changes"`
Expected: FAIL. `types` is missing `Calendar` and `CalendarEvent`.

- [ ] **Step 4: Add the push types**

In `src/jmap/sse.ts`, add this above `openPushStream`:

```ts
/** Data types oinbox wants StateChange pushes for. */
export const PUSH_TYPES = 'Email,Mailbox,Thread,EmailDelivery,Calendar,CalendarEvent';
```

and change the fetch line to:

```ts
        const res = await client.authFetch(client.eventSourceUrl(PUSH_TYPES), {
```

- [ ] **Step 5: Add the types**

In `src/jmap/types.ts`, change the header comment to `// JMAP Core (RFC 8620), Mail (RFC 8621) and Calendars types — only what oinbox uses.` and add this under `SUBMISSION`:

```ts
export const CALENDARS = 'urn:ietf:params:jmap:calendars';
```

Add these before `/** Method name → argument and result types. ... */`:

```ts
export interface Calendar {
  id: Id;
  name: string;
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
  isVisible: boolean;
}

export interface CalendarLocation {
  name?: string | null;
}

export interface CalendarParticipant {
  name?: string | null;
  /** "mailto:…" (Stalwart follows JSCalendar bis; the older `email`/`sendTo` are silently dropped). */
  calendarAddress?: string;
  participationStatus?: 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated';
  roles?: Record<string, boolean>;
}

/**
 * A JSCalendar Event as Stalwart 0.16 serves it (the "JSCalendar bis" draft: singular
 * `recurrenceRule`, `calendarAddress`). With `expandRecurrences`, each occurrence is its own
 * record with `baseEventId`, `recurrenceId` and server-computed `utcStart`.
 */
export interface CalendarEvent {
  id: Id;
  baseEventId?: Id | null;
  recurrenceId?: string | null;
  calendarIds?: Record<Id, boolean>;
  uid?: string;
  title?: string;
  description?: string;
  /** LocalDateTime, e.g. "2026-10-05T09:00:00". */
  start?: string;
  timeZone?: string | null;
  /** ISO 8601 duration, e.g. "PT30M", "P1D". Missing means zero. */
  duration?: string;
  showWithoutTime?: boolean;
  utcStart?: UTCDate;
  color?: string | null;
  locations?: Record<string, CalendarLocation> | null;
  participants?: Record<string, CalendarParticipant> | null;
  organizerCalendarAddress?: string | null;
  recurrenceRule?: Record<string, unknown> | null;
  /** recurrenceId → PatchObject. Keys are property names or JSON-pointer paths ("participants/p1/…"). */
  recurrenceOverrides?: Record<string, Record<string, unknown>> | null;
}

export interface CalendarEventFilter {
  after?: UTCDate;
  before?: UTCDate;
  inCalendar?: Id;
}
export interface CalendarEventQueryArgs extends QueryArgs<CalendarEventFilter> {
  expandRecurrences?: boolean;
  timeZone?: string;
}
```

Inside `export interface Methods { ... }`, add:

```ts
  'Calendar/get': { args: GetArgs; result: GetResult<Calendar> };
  'CalendarEvent/query': { args: CalendarEventQueryArgs; result: QueryResult };
  'CalendarEvent/get': { args: GetArgs; result: GetResult<CalendarEvent> };
```

- [ ] **Step 6: Request the calendars scope**

In `src/index.tsx`, change the default scope to:

```ts
  scope: import.meta.env.VITE_OAUTH_SCOPE ?? 'openid offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:calendars',
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `pnpm vitest run src/jmap && pnpm typecheck`
Expected: all tests PASS and the typecheck reports no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/jmap/types.ts src/jmap/sse.ts src/jmap/sse.test.ts src/index.tsx
git commit -m "Add JMAP Calendars types, calendar push types and the calendars OAuth scope" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz"
```

---

### Task 2: Occurrence merge and range request (`calendar/instances.ts`)

**Files:**
- Create: `src/calendar/instances.ts`
- Test: `src/calendar/instances.test.ts`

**Interfaces:**
- Consumes: `CalendarEvent`, `Calendar`, `Id` (Task 1); `RequestBuilder`, `CallHandle` from `src/jmap/request.ts`.
- Produces:
  - `interface Range { start: string; end: string }` (UTC ISO strings with no milliseconds)
  - `interface DisplayParticipant { name: string; address: string; status: string }`
  - `interface DisplayEvent { id; baseEventId; calendarIds: Id[]; title; start; end; allDay; color: string | null; location: string | null; description: string | null; participants: DisplayParticipant[] }`
  - `interface CalendarInput { id; title; start; end; allDay; color?: string }`
  - `toUtcDate(d: Date): string`
  - `rangeKey(r: Range): string`
  - `parseDuration(d?: string | null): { days: number; ms: number }`
  - `addRangeCalls(b: RequestBuilder, accountId: Id, range: Range, timeZone: string): { query; instances; bases }` (call handles)
  - `toDisplayEvents(instances: CalendarEvent[], bases: CalendarEvent[]): DisplayEvent[]`
  - `toCalendarInput(ev: DisplayEvent, calendars: Record<Id, Calendar>, hidden: ReadonlySet<Id>): CalendarInput | null`

- [ ] **Step 1: Write the failing tests**

Create `src/calendar/instances.test.ts`:

```ts
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

describe('toCalendarInput', () => {
  const calendars: Record<string, Calendar> = {
    c1: { id: 'c1', name: 'Personal', color: '#1a73e8', sortOrder: 0, isDefault: true, isVisible: true },
    c2: { id: 'c2', name: 'Team', color: null, sortOrder: 1, isDefault: false, isVisible: true },
  };
  const ev: DisplayEvent = {
    id: 'o1', baseEventId: 'b1', calendarIds: ['c1', 'c2'], title: 'T', start: '2026-10-07T08:00:00.000Z', end: '2026-10-07T09:00:00.000Z',
    allDay: false, color: null, location: null, description: null, participants: [],
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

  it('refuses ranges longer than six weeks', () => {
    expect(() => addRangeCalls(new RequestBuilder(), 'a1', { start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z' }, 'UTC')).toThrow(/42 days/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/calendar/instances.test.ts`
Expected: FAIL with `Failed to resolve import "./instances"`.

- [ ] **Step 3: Implement `src/calendar/instances.ts`**

```ts
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
  'color', 'locations', 'participants', 'recurrenceOverrides',
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
  if (Date.parse(range.end) - Date.parse(range.start) > MAX_RANGE_DAYS * DAY_MS) {
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
    participants: Object.values(e.participants ?? {}).map((p) => {
      const address = (p.calendarAddress ?? '').replace(/^mailto:/i, '');
      return { name: p.name?.trim() || address, address, status: p.participationStatus ?? 'needs-action' };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/calendar/instances.test.ts && pnpm typecheck`
Expected: all tests PASS and there are no type errors. If the typecheck complains that `WithRefs` doesn't allow `'#ids'` on `CalendarEvent/get`, check that Task 1 added the `Methods` entry, because `'#ids'` comes from `GetArgs.ids`.

- [ ] **Step 5: Commit**

```bash
git add src/calendar/instances.ts src/calendar/instances.test.ts
git commit -m "Merge expanded calendar occurrences with their base events" -m "Stalwart returns overridden occurrences sparse (no title, bogus duration), so
display fields come from the base event plus its recurrenceOverrides entry.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz"
```

---

### Task 3: `CalendarStore` with range cache and push handling

**Files:**
- Modify: `src/sync/fake-jmap.ts` (new fields, calendar cases in `handle`, response holds in `client()`, calendars account in the session)
- Create: `src/calendar/store.ts`
- Test: `src/calendar/store.test.ts`

**Interfaces:**
- Consumes: `addRangeCalls`, `toDisplayEvents`, `rangeKey`, `Range` and `DisplayEvent` (Task 2); `CALENDARS`, `Calendar` and `StateChange` (Task 1); `ToastFn` (`src/app/actions.ts`); `UnauthorizedError` and `JmapClient` (`src/jmap/client.ts`).
- Produces: `class CalendarStore` with:
  - `constructor(client: JmapClient, toast: ToastFn, timeZone?: string)`
  - `readonly state: { calendars: Record<Id, Calendar>; events: DisplayEvent[]; range: Range | null; loading: boolean }`
  - `accountId: Id | undefined` (getter)
  - `loadCalendars(): Promise<void>`
  - `show(range: Range): Promise<void>`
  - `refresh(): Promise<void>`
  - `onStateChange(change: StateChange): void`
  - `onConnected(): void`

  Task 5 adds `hidden()` and `toggleHidden()`.

- [ ] **Step 1: Extend `FakeJmap`**

In `src/sync/fake-jmap.ts`:

Change the header comment's first line to `// A tiny in-memory JMAP server for engine and calendar tests: enough of RFC 8620/8621 to`.

Change the type import to:

```ts
import type { Calendar, CalendarEvent, Email, Mailbox, Session } from '../jmap/types';
```

Add these fields after `calls: string[] = [];`:

```ts
  calendars = new Map<string, Calendar>();
  /** Expanded occurrences served by CalendarEvent/query (filtered by utcStart in [after, before)). */
  occurrences: CalendarEvent[] = [];
  /** Base events, served by CalendarEvent/get by id. */
  baseEvents = new Map<string, CalendarEvent>();
  calendarEventState = 0;
  failCalendarQueries = false;
  /** Each request's response waits for the next promise here, if any (for race tests). */
  holds: Promise<void>[] = [];
```

Add these cases in `handle()` before the `case 'Email/set': {` line:

```ts
      case 'Calendar/get':
        return [name, { accountId: 'a1', state: 'cal1', list: [...this.calendars.values()].map((c) => structuredClone(c)), notFound: [] }];
      case 'CalendarEvent/query': {
        if (this.failCalendarQueries) return ['error', { type: 'serverFail', description: 'calendar store unavailable' }];
        const f = (args.filter ?? {}) as { after?: string; before?: string };
        const inRange = (o: CalendarEvent) => (!f.after || o.utcStart! >= f.after) && (!f.before || o.utcStart! < f.before);
        return [name, { accountId: 'a1', queryState: `ce${this.calendarEventState}`, canCalculateChanges: false, position: 0, ids: this.occurrences.filter(inRange).map((o) => o.id) }];
      }
      case 'CalendarEvent/get': {
        const all = new Map<string, CalendarEvent>([...this.baseEvents, ...this.occurrences.map((o) => [o.id, o] as const)]);
        const list = [...new Set(ids ?? [])].map((id) => all.get(id)).filter((e): e is CalendarEvent => !!e).map((e) => structuredClone(e));
        return [name, { accountId: 'a1', state: `ce${this.calendarEventState}`, list, notFound: [] }];
      }
```

In `client()`, change `primaryAccounts` to:

```ts
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1', 'urn:ietf:params:jmap:calendars': 'a1' }, username: 'alice@example.test',
```

In `client()`, replace the `return new Response(...)` line inside `fetchImpl` with:

```ts
      // Answer from the state at request time, but deliver when the test says so.
      const hold = this.holds.shift();
      if (hold) await hold;
      return new Response(JSON.stringify({ methodResponses: responses, sessionState: 's' }), { status: 200 });
```

- [ ] **Step 2: Write the failing store tests**

Create `src/calendar/store.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run src/calendar/store.test.ts`
Expected: FAIL with `Failed to resolve import "./store"`.

- [ ] **Step 4: Implement `src/calendar/store.ts`**

```ts
import { createStore, reconcile, type SetStoreFunction } from 'solid-js/store';
import type { ToastFn } from '../app/actions';
import { UnauthorizedError, type JmapClient } from '../jmap/client';
import { CALENDARS, CORE, type Calendar, type Id, type StateChange } from '../jmap/types';
import { addRangeCalls, rangeKey, toDisplayEvents, type DisplayEvent, type Range } from './instances';

export interface CalendarState {
  calendars: Record<Id, Calendar>;
  /** Events of the visible range (all calendars; hiding is applied by the view). */
  events: DisplayEvent[];
  range: Range | null;
  loading: boolean;
}

/** Recently viewed ranges kept in memory, least recently used dropped first. */
const CACHE_SIZE = 8;

/**
 * Calendar data for the visible date range. No local mirror: the server expands recurrences,
 * and any CalendarEvent state change clears the cache and refetches what is on screen.
 */
export class CalendarStore {
  readonly state: CalendarState;
  private readonly set: SetStoreFunction<CalendarState>;
  private cache = new Map<string, DisplayEvent[]>();
  /** Bumped whenever the cache is cleared; responses from an older generation aren't cached. */
  private generation = 0;
  /** Bumped per show(); only the newest request may change what is on screen. */
  private seq = 0;
  private eventState: string | null = null;
  private calendarState: string | null = null;
  private failing = false;

  constructor(
    private readonly client: JmapClient,
    private readonly toast: ToastFn,
    private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {
    const [state, set] = createStore<CalendarState>({ calendars: {}, events: [], range: null, loading: false });
    this.state = state;
    this.set = set;
  }

  /** The primary calendars account, or undefined when the server has no JMAP Calendars. */
  get accountId(): Id | undefined {
    return this.client.hasSession ? this.client.session.primaryAccounts[CALENDARS] : undefined;
  }

  async loadCalendars(): Promise<void> {
    const accountId = this.accountId;
    if (!accountId) return;
    const b = this.client.batch();
    const get = b.call('Calendar/get', { accountId });
    const res = (await this.client.send(b, [CORE, CALENDARS])).get(get);
    this.calendarState = res.state;
    this.set('calendars', reconcile(Object.fromEntries(res.list.map((c) => [c.id, c]))));
  }

  show(range: Range): Promise<void> {
    if (!this.accountId) return Promise.resolve();
    this.set('range', range);
    const key = rangeKey(range);
    const hit = this.cache.get(key);
    if (hit) {
      this.remember(key, hit);
      this.seq++; // a slower fetch for another range must not replace this
      this.set({ events: hit, loading: false });
      return Promise.resolve();
    }
    return this.fetch(range);
  }

  /** Drop the cache and refetch the visible range. */
  refresh(): Promise<void> {
    this.cache.clear();
    this.generation++;
    const range = this.state.range;
    return range ? this.fetch(range) : Promise.resolve();
  }

  onStateChange(change: StateChange): void {
    const accountId = this.accountId;
    if (!accountId) return;
    const types = change.changed[accountId];
    if (!types) return;
    if (types.Calendar && types.Calendar !== this.calendarState) void this.loadCalendars().catch(() => undefined);
    if (types.CalendarEvent && types.CalendarEvent !== this.eventState) void this.refresh();
  }

  /** After a push (re)connect, changes may have been missed. */
  onConnected(): void {
    if (!this.accountId) return;
    void this.loadCalendars().catch(() => undefined);
    void this.refresh();
  }

  private async fetch(range: Range): Promise<void> {
    const accountId = this.accountId!;
    const my = ++this.seq;
    const generation = this.generation;
    this.set('loading', true);
    try {
      const b = this.client.batch();
      const calls = addRangeCalls(b, accountId, range, this.timeZone);
      const res = await this.client.send(b, [CORE, CALENDARS]);
      res.get(calls.query); // surfaces a failed query instead of a dangling back-reference
      const instances = res.get(calls.instances);
      const events = toDisplayEvents(instances.list, res.get(calls.bases).list);
      if (generation === this.generation) {
        this.remember(rangeKey(range), events);
        this.eventState = instances.state;
      }
      if (my === this.seq) {
        this.set('events', events);
        this.failing = false;
      }
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      if (!this.failing) {
        this.failing = true;
        this.toast(`Couldn't load the calendar: ${(e as Error).message}`, 'error');
      }
    } finally {
      if (my === this.seq) this.set('loading', false);
    }
  }

  private remember(key: string, events: DisplayEvent[]): void {
    this.cache.delete(key);
    this.cache.set(key, events);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass, along with the mail engine tests that share `FakeJmap`**

Run: `pnpm vitest run src/calendar src/sync && pnpm typecheck`
Expected: all tests PASS, including the existing `engine.test.ts`, and there are no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/sync/fake-jmap.ts src/calendar/store.ts src/calendar/store.test.ts
git commit -m "Add CalendarStore: range fetches with an in-memory cache, refreshed by push" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz"
```

---

### Task 4: Calendar seed data

**Files:**
- Create: `deploy/seed/seed_calendar.py`
- Modify: `deploy/seed.sh` (after the `seed_mail.py` run, before the final `echo`)
- Modify: `deploy/README.md` (the "`seed.sh` needs only Docker. It does four things" list)

**Interfaces:**
- Produces seed data that Task 8's e2e tests rely on. All of it is Alice's, and the week starts on the Sunday of the current week in US Eastern time (S = that Sunday):

| uid key | Title | Calendar | When |
|---|---|---|---|
| `design-review` | Design review | default | S+1 10:00–11:00 America/New_York. Location "Room 4", description "Walk through the new inbox layout.", organizer Alice, participants Alice Example (accepted) and Bob Example (needs-action). |
| `one-on-one` | 1:1 with Bob | Team | S+2 14:00, 30 minutes, NY |
| `sprint-planning` | Sprint planning | Team | S+3 13:00, 90 minutes, NY |
| `london-call` | Call with London office | default | S+3 15:00 Europe/London, 45 minutes |
| `release-freeze` | Release freeze | default | all day S+2 |
| `team-offsite` | Team offsite | Team | all day S+4 and S+5 |
| `weekly-sync` | Weekly sync | default | weekly on Mondays at 09:30 NY for 30 minutes, starting at S+1−14 days. This week's occurrence is moved to 11:00 by changing only `start`, and next week's is cancelled. |

  Every uid is `oinbox-seed-<key>@example.test`. The "Team" calendar is coloured `#0b8043`.

- [ ] **Step 1: Write `deploy/seed/seed_calendar.py`**

```python
#!/usr/bin/env python3
"""Seed alice's calendars for the dev stack (idempotent).

Events sit in the current week (starting Sunday, FullCalendar's default firstDay) and are moved
back into it on every run, matched by a fixed uid. Nothing is ever duplicated.

Stalwart 0.16 specifics (probed 2026-09-28):
* JSCalendar "bis" field names: singular `recurrenceRule`; participants use `calendarAddress`
  and the organizer `organizerCalendarAddress`. The older `email`/`sendTo` are silently dropped.
* The CalendarEvent/query `uid` filter matches nothing, so events are listed and matched here.
* `sendSchedulingMessages: false` keeps the seed from emailing invitations to bob.
"""
import base64
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

JMAP_BASE = os.environ.get("JMAP_BASE", "http://stalwart:8080")
PASSWORD = os.environ.get("SEED_PASSWORD", "oinbox-dev-pass")
ALICE = "alice@example.test"
BOB = "bob@example.test"
CALENDARS = "urn:ietf:params:jmap:calendars"
USING = ["urn:ietf:params:jmap:core", CALENDARS]
NY = "America/New_York"
TEAM_COLOR = "#0b8043"


def _auth():
    return "Basic " + base64.b64encode(f"{ALICE}:{PASSWORD}".encode()).decode()


def jmap(calls):
    req = urllib.request.Request(
        f"{JMAP_BASE}/jmap/",
        data=json.dumps({"using": USING, "methodCalls": calls}).encode(),
        headers={"Authorization": _auth(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        body = json.load(r)
    for name, args, tag in body["methodResponses"]:
        if name == "error":
            raise SystemExit(f"JMAP error in {tag}: {args}")
        for key in ("notCreated", "notUpdated", "notDestroyed"):
            if args.get(key):
                raise SystemExit(f"JMAP {name} {key}: {args[key]}")
    return {tag: args for _, args, tag in body["methodResponses"]}


def account():
    req = urllib.request.Request(f"{JMAP_BASE}/jmap/session", headers={"Authorization": _auth()})
    with urllib.request.urlopen(req) as r:
        return json.load(r)["primaryAccounts"][CALENDARS]


def week_start():
    # US Eastern "today" (fixed -5h; within an hour of midnight during DST it may pick the
    # neighbouring day, which only matters for a seed run at that exact time).
    today = (datetime.now(timezone.utc) - timedelta(hours=5)).date()
    return today - timedelta(days=(today.weekday() + 1) % 7)


def at(day, hhmm="00:00"):
    return f"{day.isoformat()}T{hhmm}:00"


def person(name, email, status, owner=False):
    roles = {"attendee": True, **({"owner": True} if owner else {})}
    return {"@type": "Participant", "name": name, "calendarAddress": f"mailto:{email}",
            "roles": roles, "participationStatus": status}


def events(sun, default_cal, team_cal):
    def d(n):
        return sun + timedelta(days=n)

    def timed(cal, title, day, hhmm, duration, tz=NY, **extra):
        return {"calendarIds": {cal: True}, "title": title, "start": at(day, hhmm),
                "timeZone": tz, "duration": duration, **extra}

    def all_day(cal, title, day, days):
        # Floating (no timeZone key): the event keeps its date wherever the viewer is.
        return {"calendarIds": {cal: True}, "title": title, "start": at(day),
                "showWithoutTime": True, "duration": f"P{days}D"}

    sync_first = d(1) - timedelta(days=14)
    return {
        "design-review": timed(
            default_cal, "Design review", d(1), "10:00", "PT1H",
            description="Walk through the new inbox layout.",
            locations={"l1": {"@type": "Location", "name": "Room 4"}},
            organizerCalendarAddress=f"mailto:{ALICE}",
            participants={"alice": person("Alice Example", ALICE, "accepted", owner=True),
                          "bob": person("Bob Example", BOB, "needs-action")}),
        "one-on-one": timed(team_cal, "1:1 with Bob", d(2), "14:00", "PT30M"),
        "sprint-planning": timed(team_cal, "Sprint planning", d(3), "13:00", "PT1H30M"),
        "london-call": timed(default_cal, "Call with London office", d(3), "15:00", "PT45M", tz="Europe/London"),
        "release-freeze": all_day(default_cal, "Release freeze", d(2), 1),
        "team-offsite": all_day(team_cal, "Team offsite", d(4), 2),
        # The moved occurrence overrides only `start`: Stalwart then returns it without a title
        # and with a bogus duration, which the client must repair from the base event.
        "weekly-sync": timed(
            default_cal, "Weekly sync", sync_first, "09:30", "PT30M",
            recurrenceRule={"@type": "RecurrenceRule", "frequency": "weekly"},
            recurrenceOverrides={at(d(1), "09:30"): {"start": at(d(1), "11:00")},
                                 at(d(8), "09:30"): {"excluded": True}}),
    }


def main():
    acct = account()
    cals = jmap([["Calendar/get", {"accountId": acct}, "c"]])["c"]["list"]
    default_cal = next((c["id"] for c in cals if c.get("isDefault")), cals[0]["id"])
    team_cal = next((c["id"] for c in cals if c["name"] == "Team"), None)
    if team_cal is None:
        r = jmap([["Calendar/set", {"accountId": acct, "create": {"t": {"name": "Team", "color": TEAM_COLOR}}}, "s"]])
        team_cal = r["s"]["created"]["t"]["id"]

    listed = jmap([
        ["CalendarEvent/query", {"accountId": acct}, "q"],
        ["CalendarEvent/get", {"accountId": acct, "#ids": {"resultOf": "q", "name": "CalendarEvent/query", "path": "/ids"},
                               "properties": ["uid"]}, "g"],
    ])["g"]["list"]
    by_uid = {e.get("uid"): e["id"] for e in listed}

    sun = week_start()
    create, update = {}, {}
    for i, (key, ev) in enumerate(events(sun, default_cal, team_cal).items()):
        uid = f"oinbox-seed-{key}@example.test"
        if uid in by_uid:
            update[by_uid[uid]] = ev
        else:
            create[f"e{i}"] = {**ev, "uid": uid}
    jmap([["CalendarEvent/set", {"accountId": acct, "sendSchedulingMessages": False,
                                 "create": create, "update": update}, "s"]])
    print(f"seed: calendar: {len(create)} events created, {len(update)} moved to the week of {sun.isoformat()}")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run it from `seed.sh`**

In `deploy/seed.sh`, insert these after the `seed_mail.py` line:

```sh
echo "seed: calendar"
docker run --rm --network "$NET" -v "$PWD/seed:/seed:ro" "$PY_IMAGE" python3 -u /seed/seed_calendar.py
```

- [ ] **Step 3: Run the seed twice and verify it is idempotent**

Run:
```bash
(cd deploy && ./seed.sh) && (cd deploy && ./seed.sh)
curl -s -u alice@example.test:oinbox-dev-pass http://localhost:8080/jmap/ -H 'content-type: application/json' \
  -d '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:calendars"],"methodCalls":[["CalendarEvent/query",{"accountId":"b"},"q"],["CalendarEvent/get",{"accountId":"b","#ids":{"resultOf":"q","name":"CalendarEvent/query","path":"/ids"},"properties":["uid","title","participants"]},"g"]]}' \
  | python3 -c "import json,sys; l=json.load(sys.stdin)['methodResponses'][1][1]['list']; s=[e for e in l if e.get('uid','').startswith('oinbox-seed-')]; print(len(s), sorted(e['title'] for e in s)); print('participants kept:', any(e.get('participants') for e in s))"
```
Expected:
- The first run prints `seed: calendar: 7 events created, 0 moved…` on a fresh stack, or `0 created, 7 moved` if the events already exist.
- The second run prints `0 events created, 7 moved`.
- The curl check prints `7 [...seven titles...]` and `participants kept: True`.

If Alice's account id isn't `b`, read it from `/jmap/session`, as the README describes.

- [ ] **Step 4: Update the README**

In `deploy/README.md`, change the sentence "`seed.sh` needs only Docker. It does four things:" to "`seed.sh` needs only Docker. It does five things:". Then add this after item 3 (the mail seed):

```markdown
4. Runs `seed/seed_calendar.py` in the same image. It creates a "Team" calendar next to Alice's default one and seven events in the current week (starting Sunday). The events include an all-day and a multi-day event, one in `Europe/London`, and a weekly series with one occurrence moved (only `start` overridden) and one cancelled. Every run moves the events back into the current week, matched by fixed `uid`s, so nothing is duplicated. It never sends invitations (`sendSchedulingMessages: false`).
```

Renumber the old item 4 ("Prints the URLs and credentials") to 5.

- [ ] **Step 5: Commit**

```bash
git add deploy/seed/seed_calendar.py deploy/seed.sh deploy/README.md
git commit -m "Seed alice's calendars with a week of events, including a sparse recurrence override" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz"
```

---

### Task 5: The `/calendar` page (view preferences, hidden calendars, wiring, CalendarView)

**Files:**
- Create: `src/calendar/prefs.ts`, `src/calendar/prefs.test.ts`
- Modify: `src/calendar/store.ts` (hidden calendars), `src/calendar/store.test.ts`
- Modify: `src/app/context.tsx` (`App` gets `calendar` and `hasCalendars`)
- Modify: `src/index.tsx` (create the store, push and reconnect wiring, the route)
- Create: `src/ui/CalendarView.tsx`
- Modify: `src/ui/styles.css`
- Modify: `docs/rozie-feedback.md`

**Interfaces:**
- Consumes: `CalendarStore` (Task 3); `toCalendarInput` and `toUtcDate` (Task 2).
- Produces:
  - `loadView(narrow: boolean): string`, `saveView(v: string): void`, `loadHidden(): Set<Id>`, `saveHidden(ids: ReadonlySet<Id>): void`
  - `CalendarStore.hidden(): ReadonlySet<Id>` and `CalendarStore.toggleHidden(id: Id): void`
  - `App.calendar: CalendarStore` and `App.hasCalendars: () => boolean`
  - `CalendarView` (a route component; the `.calendar-view` root; FullCalendar inside `.calendar-host`)

- [ ] **Step 1: Write the failing prefs and hidden-calendar tests**

Create `src/calendar/prefs.test.ts`:

```ts
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
```

Append to the `describe('CalendarStore', ...)` in `src/calendar/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/calendar`
Expected: FAIL. `./prefs` can't be resolved, and `store.hidden` is not a function.

- [ ] **Step 3: Implement `src/calendar/prefs.ts`**

```ts
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
```

- [ ] **Step 4: Add hidden calendars to `CalendarStore`**

In `src/calendar/store.ts`, add these imports:

```ts
import { createSignal, type Accessor } from 'solid-js';
import { loadHidden, saveHidden } from './prefs';
```

Add these fields after `private failing = false;`:

```ts
  private readonly hiddenSignal = createSignal<ReadonlySet<Id>>(loadHidden());
  /** Calendars this browser hides (a display preference, not Calendar.isVisible). */
  readonly hidden: Accessor<ReadonlySet<Id>> = this.hiddenSignal[0];
```

Add this method after `onConnected()`:

```ts
  toggleHidden(id: Id): void {
    const next = new Set(this.hidden());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.hiddenSignal[1](next);
    saveHidden(next);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/calendar`
Expected: PASS.

- [ ] **Step 6: Wire the store into the app**

In `src/app/context.tsx`, add `import type { CalendarStore } from '../calendar/store';` and add these to `App` after `engine: MailEngine;`:

```ts
  calendar: CalendarStore;
  /** Whether the server offers JMAP Calendars (false until the session is known). */
  hasCalendars: () => boolean;
```

In `src/index.tsx`:
1. Add imports:
   ```ts
   import { lazy } from 'solid-js';
   import { CalendarStore } from './calendar/store';
   import { CALENDARS } from './jmap/types';
   ```
   Then add below the imports:
   ```ts
   // FullCalendar is large: load it on first visit to /calendar.
   const CalendarView = lazy(() => import('./ui/CalendarView').then((m) => ({ default: m.CalendarView })));
   ```
2. After `const engine = new MailEngine(client);`, add:
   ```ts
   const calendar = new CalendarStore(client, (m, t, a) => toasts.toast(m, t, a));
   ```
   The toast is wrapped because `toasts` is declared on the next line.
3. In the `app` object, after `engine,`, add:
   ```ts
    calendar,
    hasCalendars: () => client.hasSession && !!client.session.primaryAccounts[CALENDARS],
   ```
4. In `start()`, replace the `openPushStream(...)` call with:
   ```ts
    void calendar.loadCalendars().catch((e) => onAuthError(e));
    openPushStream(client, {
      onStateChange: (c) => {
        engine.onStateChange(c);
        calendar.onStateChange(c);
      },
      onConnected: () => {
        engine.setOnline(true);
        void engine.catchUp().catch(() => undefined);
        calendar.onConnected();
      },
      onUnauthorized: () => signOut(),
    });
   ```
5. In the router, add this line before `<Route path="/search/:q" ...`:
   ```tsx
          <Route path="/calendar" component={() => (app.hasCalendars() ? <CalendarView /> : <Navigate href="/inbox" />)} />
   ```

- [ ] **Step 7: Write `src/ui/CalendarView.tsx`**

```tsx
import { FullCalendar } from '@rozie-ui/fullcalendar-solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { useApp } from '../app/context';
import { toCalendarInput, toUtcDate, type CalendarInput } from '../calendar/instances';
import { loadView, saveView } from '../calendar/prefs';

const TOOLBAR = { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' };

/** Route component for /calendar: read-only month/week/day views of every visible calendar. */
export function CalendarView() {
  const { calendar } = useApp();
  const [view, setView] = createSignal(loadView(window.innerWidth < 700));
  // The wrapper's `height` is pixels only (see docs/rozie-feedback.md), so track the host's size.
  const [height, setHeight] = createSignal(600);
  let host!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(Math.max(320, host.clientHeight)));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const events = createMemo(() =>
    calendar.state.events
      .map((e) => toCalendarInput(e, calendar.state.calendars, calendar.hidden()))
      .filter((e): e is CalendarInput => e !== null),
  );

  return (
    <section class="calendar-view" aria-label="Calendar">
      <div class="calendar-progress" classList={{ active: calendar.state.loading }} />
      <div class="calendar-host" ref={host}>
        <FullCalendar
          view={view()}
          onViewChange={(v) => {
            setView(v);
            saveView(v);
          }}
          events={events()}
          editable={false}
          selectable={false}
          nowIndicator
          height={height()}
          defaultColor="var(--cal-default)"
          headerToolbar={TOOLBAR}
          onDatesSet={(info) => {
            const { start, end } = info as { start: Date; end: Date };
            void calendar.show({ start: toUtcDate(start), end: toUtcDate(end) });
          }}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 8: Add the styles**

In `src/ui/styles.css`, add `--cal-default: #0b57d0;` inside the first `:root { ... }` block, after `--chip`. Do not redefine it in either dark block: white text must stay readable on it. Then append:

```css
/* ---- Calendar ---- */
.calendar-view {
  flex: 1; min-height: 0; display: flex; flex-direction: column; color: var(--text);
  --fc-border-color: var(--border);
  --fc-page-bg-color: var(--surface);
  --fc-neutral-bg-color: var(--surface-2);
  --fc-today-bg-color: var(--accent-soft);
  --fc-now-indicator-color: var(--danger);
  --fc-button-text-color: var(--text);
  --fc-button-bg-color: var(--surface);
  --fc-button-border-color: var(--border);
  --fc-button-hover-bg-color: var(--hover);
  --fc-button-hover-border-color: var(--border);
  --fc-button-active-bg-color: var(--accent-soft);
  --fc-button-active-border-color: var(--accent);
}
.calendar-host { flex: 1; min-height: 0; padding: 12px 16px 16px; }
.calendar-view .fc .fc-toolbar-title { font-size: 20px; font-weight: 500; }
.calendar-progress { height: 3px; flex: none; background: transparent; }
.calendar-progress.active { background: linear-gradient(90deg, transparent, var(--accent), transparent) 0 0 / 200% 100%; animation: cal-progress 1s linear infinite; }
@keyframes cal-progress { to { background-position: -200% 0; } }
```

- [ ] **Step 9: Log the FullCalendar wrapper gaps**

Append to `docs/rozie-feedback.md`:

```markdown
## FullCalendar 0.1.10 (Solid) — adopted for the calendar page; three gaps
Wanted: a read-only calendar that fills the main pane, fed from a JMAP store.
1. **`height` is typed `Number` (pixels) only.** FullCalendar itself takes `'auto'`, `'100%'` or any CSS
   height, and the curated `height` prop always wins over `options.height`, so there is no typed way
   to say "fill the parent". We measure the host with a `ResizeObserver` and pass pixels
   (`src/ui/CalendarView.tsx`). Suggest `Number | String`.
2. **`loading` only reflects FullCalendar-fetched event sources.** With `events` passed as an array
   (the documented usage) it never fires, so it can't drive a loading bar. Worth a note in the README.
3. **`noEventsContent` only renders in list views** (a FullCalendar fact). The slot is exposed on
   a wrapper whose baked-in plugins have no list view, so it can't show without `options.plugins`.
   Worth a note in the README.
```

- [ ] **Step 10: Typecheck, run the tests, build, and look at the page**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: no type errors, every test passes, and the build succeeds. The build output should contain a separate `CalendarView-*.js` chunk.

Then check it by hand:
1. Serve the build with the local-dist stack (`(cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d)`), or use `pnpm dev`.
2. Sign in as Alice and go to `http://localhost:8080/calendar`.
3. The page should show the current week in week view with the seeded events: Design review Monday 10:00, Weekly sync Monday 11:00 as a 30-minute block, Release freeze and Team offsite in the all-day row, and so on.
4. Switch to month view, reload, and confirm month view is remembered. Switch the theme to dark and confirm the calendar follows.

- [ ] **Step 11: Commit**

```bash
git add src/calendar/prefs.ts src/calendar/prefs.test.ts src/calendar/store.ts src/calendar/store.test.ts src/app/context.tsx src/index.tsx src/ui/CalendarView.tsx src/ui/styles.css docs/rozie-feedback.md
git commit -m "Add the /calendar page: FullCalendar week/month/day views over CalendarStore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz"
```

---

### Task 6: Sidebar entry, calendar list and the `g k` shortcut

**Files:**
- Modify: `src/ui/icons.tsx` (a `calendar` path)
- Modify: `src/ui/Shell.tsx` (the end of `Sidebar`'s returned fragment, and a new `CalendarList` component)
- Modify: `src/ui/keyboard.ts` (the `g` chord, `SHORTCUTS`)
- Modify: `src/ui/Overlays.tsx` (hide the calendar help row when calendars are unavailable)
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: `App.calendar` (including `hidden()`, `toggleHidden()` and `state.calendars`) and `App.hasCalendars` (Task 5).
- Produces: a `.nav-item` link to `/calendar`, labelled "Calendar"; `label.cal-toggle` rows, each containing a checkbox and the calendar name (Task 8 selects these by accessible name); and the `g k` shortcut.

- [ ] **Step 1: Add the icon**

In `src/ui/icons.tsx`, add this after `keyboard: '...',`:

```ts
  calendar: 'M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z',
```

- [ ] **Step 2: Add the sidebar entry and the calendar list**

In `src/ui/Shell.tsx`, change the `Sidebar` function's first line to `const { engine, hasCalendars } = useApp();`. Then add this just before the closing `</>` of its return:

```tsx
      <Show when={hasCalendars()}>
        <A href="/calendar" class="nav-item" classList={{ active: props.current === '/calendar' }}>
          <Icon name="calendar" />
          <span class="name">Calendar</span>
        </A>
        <Show when={props.current === '/calendar'}>
          <CalendarList />
        </Show>
      </Show>
```

Add this component after `Sidebar`:

```tsx
/** The calendars, each with a show/hide checkbox (a per-browser preference). */
function CalendarList() {
  const { calendar } = useApp();
  const calendars = createMemo(() =>
    Object.values(calendar.state.calendars).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  );
  return (
    <For each={calendars()}>
      {(c) => (
        <label class="nav-item cal-toggle">
          <input type="checkbox" checked={!calendar.hidden().has(c.id)} onChange={() => calendar.toggleHidden(c.id)} />
          <span class="cal-dot" style={{ background: c.color ?? 'var(--cal-default)' }} />
          <span class="name">{c.name}</span>
        </label>
      )}
    </For>
  );
}
```

Append to `src/ui/styles.css`:

```css
.cal-toggle { cursor: pointer; padding-left: 44px; }
.cal-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.cal-dot { width: 12px; height: 12px; border-radius: 3px; flex: none; border: 2px solid transparent; }
.cal-toggle input:not(:checked) + .cal-dot { background: transparent !important; border-color: var(--text-3); }
.cal-toggle input:focus-visible + .cal-dot { outline: 2px solid var(--accent); outline-offset: 2px; }
```

If `.nav-item` isn't `position: relative`, add `position: relative;` to the `.cal-toggle` rule so the hidden input stays inside the row.

- [ ] **Step 3: Add `g k`**

In `src/ui/keyboard.ts`, add this row to `SHORTCUTS` after the `g then i / s / t / d / a` row:

```ts
  ['g then k', 'Go to Calendar'],
```

Replace `const dest = GO[e.key];` (in the `pendingG` branch) with:

```ts
      const dest = e.key === 'k' ? (app.hasCalendars() ? '/calendar' : undefined) : GO[e.key];
```

- [ ] **Step 4: Hide the help row without calendars**

In `src/ui/Overlays.tsx`, in the component that renders `<For each={SHORTCUTS}>`, take `hasCalendars` from `useApp()` (add it to the existing destructuring, or add `const { hasCalendars } = useApp();`). Then change the loop source to:

```tsx
        <For each={SHORTCUTS.filter(([keys]) => keys !== 'g then k' || hasCalendars())}>
```

- [ ] **Step 5: Typecheck, run the tests, build, and check by hand**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: no errors and every test passes.

Then check by hand:
1. The sidebar shows **Calendar** below the labels. Clicking it opens the calendar and lists "Stalwart Calendar (alice@example.test)" and "Team" with coloured dots.
2. Unchecking **Team** removes 1:1 with Bob, Sprint planning and Team offsite. Reloading keeps them hidden.
3. From the inbox, pressing `g` then `k` opens the calendar, and `?` lists the shortcut.

- [ ] **Step 6: Commit**

```bash
git add src/ui/icons.tsx src/ui/Shell.tsx src/ui/keyboard.ts src/ui/Overlays.tsx src/ui/styles.css
git commit -m "Add the Calendar sidebar entry, per-calendar show/hide and the g k shortcut" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz"
```

---

### Task 7: Event details popover

**Files:**
- Create: `src/calendar/format.ts`, `src/calendar/format.test.ts`
- Modify: `src/ui/CalendarView.tsx`
- Modify: `src/ui/styles.css`
- Modify: `docs/rozie-feedback.md`

**Interfaces:**
- Consumes: `DisplayEvent` (Task 2); `CalendarStore.state` (Task 3); `Popover` from `@rozie-ui/popover-solid`. Its props are `open`, `onOpenChange`, `trigger`, `placement`, `anchorSlot` and `children`, and its typings accept **no `class` or `style`**. It renders `.rozie-popover`, which contains `.rozie-popover-anchor`, the element it measures.
- Produces:
  - `formatWhen(ev: Pick<DisplayEvent, 'start' | 'end' | 'allDay'>, opts?: { locale?: string; timeZone?: string }): string`
  - `STATUS_LABELS: Record<string, string>`
  - A details card: `role="dialog"`, accessible name = the event title, class `.event-card`

- [ ] **Step 1: Write the failing format tests**

Create `src/calendar/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatWhen, STATUS_LABELS } from './format';

// ICU puts narrow/thin spaces in ranges; compare with plain spaces.
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('formatWhen', () => {
  const opts = { locale: 'en-US', timeZone: 'America/New_York' };

  it('formats a same-day timed event as one date and a time range', () => {
    expect(plain(formatWhen({ allDay: false, start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T13:30:00.000Z' }, opts))).toBe('Mon, Oct 5, 9:00 – 9:30 AM');
  });

  it('formats a timed event across days with both dates', () => {
    expect(plain(formatWhen({ allDay: false, start: '2026-10-05T13:00:00.000Z', end: '2026-10-06T15:00:00.000Z' }, opts))).toBe('Mon, Oct 5, 9:00 AM – Tue, Oct 6, 11:00 AM');
  });

  it('formats all-day events by date, treating the end as exclusive', () => {
    expect(plain(formatWhen({ allDay: true, start: '2026-10-06', end: '2026-10-07' }, opts))).toBe('Tue, Oct 6');
    expect(plain(formatWhen({ allDay: true, start: '2026-10-08', end: '2026-10-10' }, opts))).toBe('Thu, Oct 8 – Fri, Oct 9');
  });

  it('labels RSVP states', () => {
    expect(STATUS_LABELS['needs-action']).toBe('Awaiting reply');
    expect(STATUS_LABELS.accepted).toBe('Accepted');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/calendar/format.test.ts`
Expected: FAIL with `Failed to resolve import "./format"`.

- [ ] **Step 3: Implement `src/calendar/format.ts`**

```ts
import type { DisplayEvent } from './instances';

export const STATUS_LABELS: Record<string, string> = {
  'needs-action': 'Awaiting reply',
  accepted: 'Accepted',
  declined: 'Declined',
  tentative: 'Maybe',
  delegated: 'Delegated',
};

/** "Mon, Oct 5, 9:00 – 9:30 AM" / "Thu, Oct 8 – Fri, Oct 9" (all-day ends are exclusive). */
export function formatWhen(ev: Pick<DisplayEvent, 'start' | 'end' | 'allDay'>, opts: { locale?: string; timeZone?: string } = {}): string {
  if (ev.allDay) {
    // Dates, not instants: format in UTC so no time zone can shift the day.
    const f = new Intl.DateTimeFormat(opts.locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const first = new Date(`${ev.start}T00:00:00Z`);
    const last = new Date(`${ev.end}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    return last <= first ? f.format(first) : f.formatRange(first, last);
  }
  const f = new Intl.DateTimeFormat(opts.locale, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: opts.timeZone,
  });
  return f.formatRange(new Date(ev.start), new Date(ev.end));
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run src/calendar/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the popover to `CalendarView`**

In `src/ui/CalendarView.tsx`:

1. Update the imports:
   ```tsx
   import { FullCalendar } from '@rozie-ui/fullcalendar-solid';
   import { Popover } from '@rozie-ui/popover-solid';
   import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
   import { useApp } from '../app/context';
   import { formatWhen, STATUS_LABELS } from '../calendar/format';
   import { toCalendarInput, toUtcDate, type CalendarInput, type DisplayEvent } from '../calendar/instances';
   import { loadView, saveView } from '../calendar/prefs';
   ```
   `@rozie-ui/popover-solid` ships no theme stylesheet (verified); the card is styled in Step 6.
2. Inside `CalendarView`, before the `return`, add:
   ```tsx
   const [selected, setSelected] = createSignal<{ event: DisplayEvent; rect: DOMRect } | null>(null);
   ```
3. Add this prop to `<FullCalendar ...>`:
   ```tsx
            onEventClick={(info) => {
              const { event, jsEvent } = info as { event: { id: string }; jsEvent: MouseEvent };
              const el = (jsEvent.target as Element | null)?.closest('.fc-event');
              const ev = calendar.state.events.find((e) => e.id === event.id);
              if (el && ev) setSelected({ event: ev, rect: el.getBoundingClientRect() });
            }}
   ```
4. After the `.calendar-host` div, still inside the `<section>`, add:
   ```tsx
      <Show when={selected()} keyed>
        {(s) => <EventPopover event={s.event} rect={s.rect} onClose={() => setSelected(null)} />}
      </Show>
   ```
5. Add this component to the file:
   ```tsx
   /**
    * Read-only event details. Popover can only anchor to an element it renders itself, so it sits
    * in a fixed-position box laid over the clicked event, and its (empty) anchor fills that box.
    * (Popover's props don't accept class/style, hence the wrapper div.)
    */
   function EventPopover(props: { event: DisplayEvent; rect: DOMRect; onClose: () => void }) {
     const { calendar } = useApp();
     const calendarName = () =>
       props.event.calendarIds.map((id) => calendar.state.calendars[id]?.name).find((n) => n) ?? '';
     return (
       <div class="event-anchor" style={{ left: `${props.rect.left}px`, top: `${props.rect.top}px`, width: `${props.rect.width}px`, height: `${props.rect.height}px` }}>
       <Popover open onOpenChange={(open) => !open && props.onClose()} trigger="manual" placement="right-start" anchorSlot={() => <span />}>
         <div class="event-card" role="dialog" aria-label={props.event.title}>
           <h3>{props.event.title}</h3>
           <p class="when">{formatWhen(props.event)}</p>
           <Show when={props.event.location}>{(l) => <p class="where">{l()}</p>}</Show>
           <Show when={props.event.description}>{(d) => <p class="description">{d()}</p>}</Show>
           <Show when={props.event.participants.length}>
             <ul class="participants">
               <For each={props.event.participants}>
                 {(p) => (
                   <li>
                     <span class="who" title={p.address}>{p.name}</span>
                     <span class="rsvp">{STATUS_LABELS[p.status] ?? p.status}</span>
                   </li>
                 )}
               </For>
             </ul>
           </Show>
           <p class="calendar-name">{calendarName()}</p>
         </div>
       </Popover>
       </div>
     );
   }
   ```

- [ ] **Step 6: Add the popover styles**

Append to `src/ui/styles.css`:

```css
.event-anchor { position: fixed; pointer-events: none; z-index: 20; }
.event-anchor > .rozie-popover, .event-anchor .rozie-popover-anchor { width: 100%; height: 100%; }
.event-card { pointer-events: auto; width: min(360px, calc(100vw - 32px)); padding: 16px 20px; background: var(--surface); color: var(--text); border-radius: 12px; box-shadow: var(--shadow); }
.event-card h3 { margin: 0 0 4px; font-size: 18px; font-weight: 500; }
.event-card p { margin: 4px 0; }
.event-card .when, .event-card .calendar-name { color: var(--text-2); font-size: 14px; }
.event-card .description { white-space: pre-wrap; }
.event-card .participants { list-style: none; margin: 8px 0; padding: 0; }
.event-card .participants li { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
.event-card .rsvp { color: var(--text-3); font-size: 13px; }
```

- [ ] **Step 7: Log the Popover gap**

Append to `docs/rozie-feedback.md`:

```markdown
## Popover 0.2.4 — no external or virtual anchor
Wanted: open event details next to a FullCalendar event element that the popover doesn't render.
Popover measures only its own `.rozie-popover-anchor` wrapper (filled by `anchorSlot`); there's no
`anchor` prop taking an element or a floating-ui virtual element (`getBoundingClientRect`).
Workaround (`src/ui/CalendarView.tsx` `EventPopover`): a `position: fixed` wrapper div (Popover's props
don't accept `class`/`style`) sized to the clicked event's rect, with the anchor stretched to fill it
and an empty anchor slot, mounted fresh per click. Suggest an `anchor`
prop accepting `Element | { getBoundingClientRect(): DOMRect }`. Related: FullCalendar's
`eventClick` payload drops `info.el`, so the element is recovered via `jsEvent.target.closest('.fc-event')`.
```

- [ ] **Step 8: Typecheck, run the tests, build, and check by hand**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: no errors and every test passes.

Then check by hand on `/calendar`:
1. Click **Design review**. A card opens beside the event showing the time range, "Room 4", the description, "Alice Example — Accepted" and "Bob Example — Awaiting reply", and the calendar name.
2. Esc or an outside click closes it. Clicking another event moves the card to that event.
3. It works in both themes.
4. If the card opens in the wrong place, inspect `.event-anchor > .rozie-popover > .rozie-popover-anchor` in the DOM. All three must have the clicked event's size. The anchor div is what the popover measures.

- [ ] **Step 9: Commit**

```bash
git add src/calendar/format.ts src/calendar/format.test.ts src/ui/CalendarView.tsx src/ui/styles.css docs/rozie-feedback.md
git commit -m "Show read-only event details in a popover" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz"
```

---

### Task 8: End-to-end calendar tests

**Files:**
- Modify: `e2e/support/mail.ts` (`jmap()` takes `using`)
- Create: `e2e/support/calendar.ts`
- Create: `e2e/calendar.spec.ts`

**Interfaces:**
- Consumes: the seed data (Task 4); `.calendar-view`, the `Calendar` nav link and the `label.cal-toggle` checkboxes (Tasks 5 and 6); the `role="dialog"` event card (Task 7); `waitLive` and `rows` from `e2e/support/app.ts`.

- [ ] **Step 1: Let `jmap()` use other capabilities**

In `e2e/support/mail.ts`, change the signature and the body line:

```ts
export async function jmap(calls: Invocation[], user = ALICE, using: string[] = USING): Promise<Record<string, any>> {
```

```ts
    body: JSON.stringify({ using, methodCalls: calls }),
```

- [ ] **Step 2: Write `e2e/support/calendar.ts`**

```ts
// Calendar helpers for specs: JMAP Calendars over Basic auth against the dev stack.
import { ALICE, BASE, PASSWORD, jmap } from './mail';

export const CAL_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];

async function calendarAccount(user = ALICE): Promise<string> {
  const res = await fetch(`${BASE}/jmap/session`, { headers: { authorization: 'Basic ' + Buffer.from(`${user}:${PASSWORD}`).toString('base64') } });
  const s = (await res.json()) as { primaryAccounts: Record<string, string> };
  return s.primaryAccounts['urn:ietf:params:jmap:calendars']!;
}

async function defaultCalendar(accountId: string): Promise<string> {
  const r = await jmap([['Calendar/get', { accountId }, 'c']], ALICE, CAL_USING);
  const list = r.c.list as { id: string; isDefault: boolean }[];
  return (list.find((c) => c.isDefault) ?? list[0]!).id;
}

/** Local "YYYY-MM-DD" of today in a time zone. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Create a timed event in alice's default calendar; returns its id. */
export async function createEvent(title: string, start: string, timeZone: string, duration = 'PT1H'): Promise<string> {
  const accountId = await calendarAccount();
  const calendarId = await defaultCalendar(accountId);
  const r = await jmap(
    [['CalendarEvent/set', { accountId, sendSchedulingMessages: false, create: { x: { calendarIds: { [calendarId]: true }, title, start, timeZone, duration } } }, 's']],
    ALICE,
    CAL_USING,
  );
  return r.s.created.x.id as string;
}

export async function destroyEvent(id: string): Promise<void> {
  const accountId = await calendarAccount();
  await jmap([['CalendarEvent/set', { accountId, destroy: [id] }, 'd']], ALICE, CAL_USING);
}
```

- [ ] **Step 3: Write `e2e/calendar.spec.ts`**

```ts
import { expect, test, type Page } from '@playwright/test';
import { rows, waitLive } from './support/app';
import { createEvent, destroyEvent, todayIn } from './support/calendar';

// Seeded events are in US Eastern time, in the week starting on this Sunday (deploy/seed/seed_calendar.py).
const TZ = 'America/New_York';
test.use({ timezoneId: TZ });

const event = (page: Page, title: string) => page.locator('.calendar-view .fc-event', { hasText: title });

async function openWeek(page: Page) {
  await page.goto('/calendar');
  await expect(page.locator('.calendar-view .fc')).toBeVisible();
  await page.getByRole('button', { name: 'week', exact: true }).click();
  await expect(event(page, 'Design review')).toBeVisible();
}

test('shows the seeded week, all-day and multi-day events included', async ({ page }) => {
  await openWeek(page);
  for (const title of ['Design review', '1:1 with Bob', 'Sprint planning', 'Call with London office', 'Release freeze', 'Team offsite']) {
    await expect(event(page, title).first()).toBeVisible();
  }
});

test('repairs the sparse override: the moved Weekly sync is titled and 30 minutes long', async ({ page }) => {
  await openWeek(page);
  const sync = event(page, 'Weekly sync');
  await expect(sync).toHaveCount(1);
  await expect(sync).toContainText(/11:00\s*[-–]\s*11:30/);
});

test('an event created elsewhere appears through push, without a reload', async ({ page }) => {
  await openWeek(page);
  await waitLive(page);
  const title = `Pushed ${Date.now()}`;
  const id = await createEvent(title, `${todayIn(TZ)}T16:00:00`, TZ);
  try {
    await expect(event(page, title)).toBeVisible({ timeout: 15_000 });
  } finally {
    await destroyEvent(id);
  }
  await expect(event(page, title)).toHaveCount(0, { timeout: 15_000 });
});

test('clicking an event shows its details', async ({ page }) => {
  await openWeek(page);
  await event(page, 'Design review').click();
  const card = page.getByRole('dialog', { name: 'Design review' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Room 4');
  await expect(card).toContainText('Walk through the new inbox layout.');
  await expect(card).toContainText('Bob Example');
  await expect(card).toContainText('Awaiting reply');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
});

test('g then k opens the calendar from the inbox', async ({ page }) => {
  await page.goto('/inbox');
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('k');
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator('.calendar-view')).toBeVisible();
});

test('hiding a calendar hides its events', async ({ page }) => {
  await openWeek(page);
  const team = page.getByRole('checkbox', { name: 'Team' });
  await expect(event(page, 'Sprint planning')).toBeVisible();
  await team.uncheck();
  await expect(event(page, 'Sprint planning')).toHaveCount(0);
  await expect(event(page, '1:1 with Bob')).toHaveCount(0);
  await expect(event(page, 'Design review')).toBeVisible();
  await team.check();
  await expect(event(page, 'Sprint planning')).toBeVisible();
});
```

- [ ] **Step 4: Run the calendar spec**

Run: `pnpm build && pnpm e2e e2e/calendar.spec.ts`
Expected: 6 passed. Known ways it can fail, and what to change:
- The **week button's accessible name** differs (FullCalendar 6 labels it "week"). Change the `getByRole` name to whatever the button reads.
- The **event time format** in week view isn't `11:00 - 11:30`. Look at the trace's DOM for the real text in `.fc-event-time`, and change only the regex's format, never the 11:00–11:30 values.
- **Push is slow.** The mail specs use `waitLive` for the same reason. Keep the 15 s timeout.

- [ ] **Step 5: Run the full e2e suite to check nothing else broke**

Run: `pnpm e2e`
Expected: every spec passes, including `login.spec.ts`, whose seeded-inbox counts must not change because the calendar seed sends no mail.

- [ ] **Step 6: Commit**

```bash
git add e2e/support/mail.ts e2e/support/calendar.ts e2e/calendar.spec.ts
git commit -m "Add end-to-end calendar tests: seeded week, sparse override, push, details, g k, hiding" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0127nmxwnCES7pUpK18rapZz"
```

---

## Self-review against the spec

- **Protocol, data strategy and expansion:** Tasks 1–3.
- **Merge rules** (sparse override, JSON-path keys, all-day, time zones, "(No title)", colour fallback to `--cal-default`): Task 2, with the colour token in Task 5.
- **Browser time zone for queries:** Task 3 (the constructor default), passed through `addRangeCalls` in Task 2.
- **OAuth scope:** Task 1.
- **Push types and reconnect:** Tasks 1 and 5 (wiring), with store behaviour in Task 3.
- **Hidden calendars in `localStorage`:** Tasks 5 and 6.
- **Route, sidebar, `g k`, help row, redirect without capability:** Tasks 5 and 6.
- **View persistence and narrow default:** Task 5.
- **Popover contents** (time, location, description, participants with status, calendar name): Task 7.
- **Loading bar from the store:** Task 5.
- **Theming** through the FullCalendar CSS variables: Task 5.
- **Seed** (Team calendar, 7 events, uid matching without the `uid` filter, no scheduling mail): Task 4.
- **Errors:** toast once and keep events (Task 3); 401 re-thrown to the global handler (Task 3, since `show()`'s rejection is unhandled, which `index.tsx` already turns into sign-out); no capability (Tasks 3, 5 and 6); range assert (Task 2).
- **Tests:** every unit test listed in the spec is in Tasks 2, 3, 5 and 7. Every e2e case is in Task 8.
- **rozie feedback:** Tasks 5 and 7.
