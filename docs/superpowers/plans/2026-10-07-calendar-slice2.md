# Calendar slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create, move, resize, rename, re-calendar and delete single calendar events from the calendar page.

**Architecture:** Pure helpers in `src/calendar/edit.ts` decide what is editable and turn FullCalendar drops and selections into JMAP patches. `CalendarStore` gets three write methods that are the only code sending `CalendarEvent/set`. `CalendarView` turns on FullCalendar's `editable`/`selectable`, applies drags optimistically (reverting on failure), and shows a small `EventForm` popover and a three-way notify dialog.

**Tech Stack:** SolidJS, Vite, vitest + `@solidjs/testing-library`, Playwright (real Stalwart 0.16 stack in `deploy/`), `@rozie-ui/fullcalendar-solid` 0.2.0, `@rozie-ui/popover-solid`, `@rozie-ui/dialog-solid`.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-slice2-design.md` (read it first; it holds the probed Stalwart behaviour).

## Global Constraints

- Single, non-recurring events only; recurring events, events the user was invited to (`isOrigin: false`), and events whose calendar lacks `myRights.mayWriteAll` are read-only.
- `CalendarEvent/set` goes through `CalendarStore` only; it is sent as `{ accountId, sendSchedulingMessages, create | update | destroy }` using `[CORE, CALENDARS]`.
- `update` and `destroy` use the event's **base event id** (`DisplayEvent.baseEventId`), not the occurrence id.
- Creating never notifies (`sendSchedulingMessages: false`). Notifying is asked only when the event has guests (a participant without the `owner` role).
- JSCalendar "bis": `calendarAddress`, singular `recurrenceRule`. Calendar moves are patches `calendarIds/<id>: null` and `calendarIds/<id>: true`.
- A moved event keeps its own `timeZone`; a floating event (no `timeZone`) stays floating. New timed events use the browser's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). All-day: `showWithoutTime: true`, `start: "YYYY-MM-DDT00:00:00"`, `duration: "P<n>D"`.
- Server rejections never throw out of the store; they return `{ ok: false, error }`. `UnauthorizedError` still propagates.
- Rozie: no `Select` package is installed, so the calendar picker is a native `<select>`; note it in `docs/rozie-feedback.md`. If a rozie component blocks the work, pause and tell the user.
- Commit messages end with the two attribution lines from the session (Co-Authored-By and Claude-Session).
- Out of scope: recurring edits, participants, location/description/time fields in the form, keyboard moving/resizing (the user will cover full keyboard editing later).

## Review Focus

- Dropping a **timed** event onto the all-day row, and an **all-day** event onto the time grid, must convert the event (`showWithoutTime`, `timeZone`), not just shift it (Task 2 tests; no e2e, since dragging into the all-day row is fragile in Playwright).
- A London-zoned event dragged by a browser in New York must stay in `Europe/London` and land at the right London wall time (Task 2).
- A multi-day all-day event keeps its length when moved (Task 2).
- `notFound` on update/delete (event removed elsewhere) shows a message and refetches, with no unhandled rejection (Task 3).
- Escape or an outside click while the create popover is open leaves no selection highlight and creates nothing (Task 6 e2e).
- A failed drag write puts the event back where it was (Task 7 e2e).

---

## File structure

- Modify `src/jmap/types.ts`: `CalendarRights`, `Calendar.myRights`, `CalendarEvent.isOrigin`, `CalendarEventSetArgs`, the `CalendarEvent/set` entry in `Methods`.
- Modify `src/calendar/instances.ts`: fetch and expose `isOrigin`, `recurring`, `timeZone`, participant `owner`.
- Create `src/calendar/edit.ts` (+ `edit.test.ts`): editability, guests, drop/selection patches.
- Modify `src/calendar/store.ts` (+ `store.test.ts`) and `src/sync/fake-jmap.ts`: write methods and the fake's `CalendarEvent/set`.
- Create `src/ui/NotifyDialog.tsx` (+ test): three-way dialog.
- Create `src/ui/EventForm.tsx`: create/edit form content.
- Modify `src/ui/CalendarView.tsx`, `src/ui/styles.css`: wire it all up.
- Modify `e2e/support/calendar.ts`; create `e2e/calendar-edit.spec.ts`.
- Modify `docs/rozie-feedback.md`.

Commands: unit tests `pnpm test`, types `pnpm typecheck`, e2e (stack up, `pnpm build` first) `pnpm e2e e2e/calendar-edit.spec.ts` (see `e2e/README.md`).

---

### Task 1: Carry the edit-relevant fields

**Files:**
- Modify: `src/jmap/types.ts` (Calendar ~283, CalendarEvent ~314, Methods ~364)
- Modify: `src/calendar/instances.ts`
- Test: `src/calendar/instances.test.ts`

**Interfaces:**
- Produces: `Calendar.myRights?: CalendarRights`; `CalendarEvent.isOrigin?: boolean`; `'CalendarEvent/set'` in `Methods`; `DisplayEvent` gains `isOrigin: boolean`, `recurring: boolean`, `timeZone: string | null`; `DisplayParticipant` gains `owner: boolean`.

- [ ] **Step 1: Write the failing tests** in `src/calendar/instances.test.ts` (inside the existing `describe` that uses `base`/`occ`; add a new `describe`):

```ts
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
    const { bases } = addRangeCalls(b, 'a1', { start: '2026-10-04T00:00:00Z', end: '2026-10-11T00:00:00Z' }, 'UTC');
    const call = b.build().find((c) => c[2] === bases.id)!;
    expect(call[1].properties).toEqual(expect.arrayContaining(['isOrigin', 'recurrenceRule']));
  });
});
```

(`b.build()` — use the same accessor the existing `addRangeCalls` test in this file uses to read calls; copy that line's form.)

- [ ] **Step 2: Run to verify failure:** `pnpm test src/calendar/instances.test.ts` → FAIL (properties missing / undefined).

- [ ] **Step 3: Implement.**

`src/jmap/types.ts`:

```ts
export interface CalendarRights {
  mayReadFreeBusy?: boolean;
  mayReadItems?: boolean;
  mayWriteAll?: boolean;
  mayWriteOwn?: boolean;
  mayUpdatePrivate?: boolean;
  mayRSVP?: boolean;
  mayShare?: boolean;
  mayDelete?: boolean;
}
```
Add `myRights?: CalendarRights;` to `Calendar`, `isOrigin?: boolean;` to `CalendarEvent`, and:

```ts
export interface CalendarEventSetArgs extends SetArgs<CalendarEvent> {
  /** Email guests the invitation, change or cancellation. Stalwart sends nothing when false. */
  sendSchedulingMessages?: boolean;
}
```
and in `Methods`: `'CalendarEvent/set': { args: CalendarEventSetArgs; result: SetResult<CalendarEvent> };`

`src/calendar/instances.ts`:
- `DisplayParticipant`: add `owner: boolean;`
- `DisplayEvent`: add `isOrigin: boolean; recurring: boolean; timeZone: string | null;`
- `BASE_PROPS`: append `'isOrigin', 'recurrenceRule'`.
- In `toDisplayEvent`, in `common`: `isOrigin: source.isOrigin === true, recurring: !!source.recurrenceRule, timeZone: e.timeZone ?? null,` and the participant map returns `{ name, address, status, owner: !!p.roles?.owner }`.

Fix any existing test fixtures that build a full `DisplayEvent` literal (e.g. around `instances.test.ts:133`): add `isOrigin: false, recurring: false, timeZone: null` and `owner: false` on participants. Run `pnpm typecheck` to find them.

- [ ] **Step 4: Run:** `pnpm test src/calendar && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** `git add -A src && git commit -m "Calendar: carry isOrigin, recurring, timeZone, owner and calendar rights"` (plus attribution lines).

---

### Task 2: Pure edit rules and patches

**Files:**
- Create: `src/calendar/edit.ts`, `src/calendar/edit.test.ts`

**Interfaces:**
- Consumes: `DisplayEvent`, `Calendar` (Task 1).
- Produces:
  - `type Editability = { editable: true } | { editable: false; reason: string }`
  - `editability(ev: DisplayEvent, calendars: Record<Id, Calendar>): Editability`
  - `hasGuests(ev: DisplayEvent): boolean`
  - `patchForDrop(ev: DisplayEvent, start: Date, end: Date | null, allDay: boolean, browserZone: string): Record<string, unknown>`
  - `newEventFromSelection(sel: { start: Date; end: Date; allDay: boolean }, calendarId: Id, title: string, browserZone: string): Partial<CalendarEvent>`
  - `writableCalendars(calendars: Record<Id, Calendar>): Calendar[]` and `defaultCalendarId(calendars: Record<Id, Calendar>): Id | undefined`
  - `formatDuration(ms: number): string`, `localDateTime(d: Date, zone: string): string`, `localDate(d: Date): string`

- [ ] **Step 1: Write the failing tests** `src/calendar/edit.test.ts`:

```ts
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
```

- [ ] **Step 2: Run:** `pnpm test src/calendar/edit.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/calendar/edit.ts`:

```ts
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
```

- [ ] **Step 4: Run:** `pnpm test src/calendar/edit.test.ts` → PASS. If the zone-dependent all-day tests fail because the machine's zone isn't the one assumed, check `vitest` config for `TZ`; the all-day cases use `new Date(y, m, d)` (local) on purpose and don't depend on the zone.

- [ ] **Step 5: Commit** `git add src/calendar/edit.ts src/calendar/edit.test.ts && git commit -m "Calendar: pure edit rules and drop/selection patches"` (plus attribution lines).

---

### Task 3: Store writes and the fake server

**Files:**
- Modify: `src/calendar/store.ts`, `src/sync/fake-jmap.ts`
- Test: `src/calendar/store.test.ts`

**Interfaces:**
- Consumes: `CalendarEventSetArgs`, `SetResult` (Task 1).
- Produces on `CalendarStore`:
  - `type WriteResult = { ok: true } | { ok: false; error: string }` (exported from `store.ts`)
  - `createEvent(event: Partial<CalendarEvent>): Promise<WriteResult>`
  - `updateEvent(baseEventId: Id, patch: Record<string, unknown>, notify: boolean): Promise<WriteResult>`
  - `deleteEvent(baseEventId: Id, notify: boolean): Promise<WriteResult>`
- Produces on `FakeJmap`: `calendarSets: Record<string, unknown>[]` (each received `CalendarEvent/set` args), `failCalendarSets: boolean`, and a working `CalendarEvent/set`.

- [ ] **Step 1: Write the failing tests** appended to `src/calendar/store.test.ts` (uses the existing `setup()`; `b1`/`o1` exist there):

```ts
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
```

- [ ] **Step 2: Run:** `pnpm test src/calendar/store.test.ts` → FAIL (methods undefined).

- [ ] **Step 3: Implement.**

`src/sync/fake-jmap.ts`: add fields next to `calendarEventState`:

```ts
  calendarSets: Record<string, unknown>[] = [];
  failCalendarSets = false;
  private nextCalendarEventId = 0;
```
and a case after `'CalendarEvent/get'` (inside the same `switch`):

```ts
      case 'CalendarEvent/set': {
        this.calendarSets.push(structuredClone(args));
        if (this.failCalendarSets) return ['error', { type: 'serverFail', description: 'calendar store unavailable' }];
        const a = args as { create?: Record<string, CalendarEvent>; update?: Record<string, Record<string, unknown>>; destroy?: string[] };
        const created: Record<string, { id: string }> = {};
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string }> = {};
        const destroyed: string[] = [];
        const notDestroyed: Record<string, { type: string }> = {};
        for (const [key, ev] of Object.entries(a.create ?? {})) {
          const id = `n${++this.nextCalendarEventId}`;
          this.baseEvents.set(id, { ...structuredClone(ev), id });
          this.occurrences.push({ id, baseEventId: id, calendarIds: ev.calendarIds, start: ev.start, utcStart: `${ev.start}Z` });
          created[key] = { id };
        }
        for (const [id, patch] of Object.entries(a.update ?? {})) {
          const base = this.baseEvents.get(id);
          if (!base) { notUpdated[id] = { type: 'notFound' }; continue; }
          const next: Record<string, unknown> = { ...base, calendarIds: { ...base.calendarIds } };
          for (const [k, v] of Object.entries(patch)) {
            if (k.startsWith('calendarIds/')) {
              const cal = k.slice('calendarIds/'.length);
              if (v) (next.calendarIds as Record<string, boolean>)[cal] = true;
              else delete (next.calendarIds as Record<string, boolean>)[cal];
            } else next[k] = v;
          }
          this.baseEvents.set(id, next as unknown as CalendarEvent);
          for (const o of this.occurrences) {
            if (o.baseEventId !== id) continue;
            o.calendarIds = (next as unknown as CalendarEvent).calendarIds;
            if (typeof patch.start === 'string') { o.start = patch.start; o.utcStart = `${patch.start}Z`; }
          }
          updated[id] = null;
        }
        for (const id of a.destroy ?? []) {
          if (!this.baseEvents.delete(id)) { notDestroyed[id] = { type: 'notFound' }; continue; }
          this.occurrences = this.occurrences.filter((o) => o.baseEventId !== id);
          destroyed.push(id);
        }
        this.calendarEventState++;
        return [name, {
          accountId: 'a1', oldState: null, newState: `ce${this.calendarEventState}`,
          created: Object.keys(created).length ? created : null, updated: Object.keys(updated).length ? updated : null,
          destroyed: destroyed.length ? destroyed : null, notCreated: null,
          notUpdated: Object.keys(notUpdated).length ? notUpdated : null, notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
        }];
      }
```
(The create test's key is the client-chosen creation id; the store uses `'new'`.)

`src/calendar/store.ts`: imports gain `CalendarEvent, CalendarEventSetArgs` from `../jmap/types`; add near the top:

```ts
export type WriteResult = { ok: true } | { ok: false; error: string };
```
and methods (before `toggleHidden`):

```ts
  /** Create one event. Never emails anyone: slice 2 has no way to add guests. */
  createEvent(event: Partial<CalendarEvent>): Promise<WriteResult> {
    return this.write({ create: { new: event } }, false, 'new');
  }

  /** `baseEventId` is the series/event id, not an occurrence id. */
  updateEvent(baseEventId: Id, patch: Record<string, unknown>, notify: boolean): Promise<WriteResult> {
    return this.write({ update: { [baseEventId]: patch } }, notify, baseEventId);
  }

  deleteEvent(baseEventId: Id, notify: boolean): Promise<WriteResult> {
    return this.write({ destroy: [baseEventId] }, notify, baseEventId);
  }

  /** One CalendarEvent/set. The refetch is started here; the push event that follows is then a no-op. */
  private async write(args: Pick<CalendarEventSetArgs, 'create' | 'update' | 'destroy'>, notify: boolean, key: string): Promise<WriteResult> {
    const accountId = this.accountId;
    if (!accountId) return { ok: false, error: 'Calendars are not available.' };
    try {
      const b = this.client.batch();
      const call = b.call('CalendarEvent/set', { accountId, sendSchedulingMessages: notify, ...args });
      const res = (await this.client.send(b, [CORE, CALENDARS])).get(call);
      const err = res.notCreated?.[key] ?? res.notUpdated?.[key] ?? res.notDestroyed?.[key];
      if (err) {
        void this.refresh();
        const gone = err.type === 'notFound';
        return { ok: false, error: gone ? 'That event no longer exists.' : (err.description ?? `The server refused the change (${err.type}).`) };
      }
      void this.refresh();
      return { ok: true };
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      return { ok: false, error: (e as Error).message };
    }
  }
```

- [ ] **Step 4: Run:** `pnpm test src/calendar src/sync && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** `git add -A src && git commit -m "CalendarStore: create, update and delete events; the fake serves CalendarEvent/set"` (plus attribution lines).

---

### Task 4: The notify dialog

**Files:**
- Create: `src/ui/NotifyDialog.tsx`, `src/ui/NotifyDialog.test.tsx`

**Interfaces:**
- Produces: `type NotifyAnswer = 'notify' | 'silent' | 'cancel'`; `interface NotifyAsk { title: string; message: string; guests: boolean; confirmLabel: string; danger?: boolean }`; `createNotifyDialog(): { ask: (a: NotifyAsk) => Promise<NotifyAnswer>; Host: () => JSX.Element }`. With `guests: false` the dialog shows Cancel and the confirm button only, and the confirm button answers `'silent'`.

- [ ] **Step 1: Write the failing test** `src/ui/NotifyDialog.test.tsx`:

```tsx
import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createNotifyDialog } from './NotifyDialog';

const ask = { title: 'Move event?', message: 'Guests are on this event.', confirmLabel: 'Move', guests: true };

describe('NotifyDialog', () => {
  it('answers notify, silent and cancel for an event with guests', async () => {
    const { ask: open, Host } = createNotifyDialog();
    render(() => <Host />);
    const user = userEvent.setup();
    for (const [button, answer] of [['Notify guests', 'notify'], ["Don't notify", 'silent'], ['Cancel', 'cancel']] as const) {
      const result = open(ask);
      await user.click(await screen.findByRole('button', { name: button }));
      expect(await result).toBe(answer);
    }
  });

  it('offers only Cancel and the action without guests, and the action answers silent', async () => {
    const { ask: open, Host } = createNotifyDialog();
    render(() => <Host />);
    const result = open({ ...ask, guests: false, message: 'Delete it?', confirmLabel: 'Delete', danger: true });
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Notify guests' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete' }));
    expect(await result).toBe('silent');
  });
});
```
(Check `@testing-library/user-event` is installed; if not, use `fireEvent.click` from `@solidjs/testing-library` instead and drop the `userEvent` lines.)

- [ ] **Step 2: Run:** `pnpm test src/ui/NotifyDialog.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/ui/NotifyDialog.tsx`:

```tsx
import { Dialog } from '@rozie-ui/dialog-solid';
import { createSignal, Show, type JSX } from 'solid-js';

export type NotifyAnswer = 'notify' | 'silent' | 'cancel';

export interface NotifyAsk {
  title: string;
  message: string;
  /** With guests: Notify guests / Don't notify / Cancel. Without: Cancel and the action (answers 'silent'). */
  guests: boolean;
  confirmLabel: string;
  danger?: boolean;
}

interface Pending {
  ask: NotifyAsk;
  resolve: (a: NotifyAnswer) => void;
}

/** A blocking dialog that asks whether to email an event's guests about a change. */
export function createNotifyDialog(): { ask: (a: NotifyAsk) => Promise<NotifyAnswer>; Host: () => JSX.Element } {
  const [pending, setPending] = createSignal<Pending | null>(null);
  const ask = (a: NotifyAsk) => new Promise<NotifyAnswer>((resolve) => setPending({ ask: a, resolve }));
  const answer = (a: NotifyAnswer) => {
    pending()?.resolve(a);
    setPending(null);
  };

  const Host = () => (
    <Show when={pending()}>
      {(p) => (
        <Dialog open onOpenChange={(open) => !open && answer('cancel')} ariaLabelledby="notify-title">
          <h2 id="notify-title">{p().ask.title}</h2>
          <p>{p().ask.message}</p>
          <div class="dialog-actions">
            <button onClick={() => answer('cancel')}>Cancel</button>
            <Show
              when={p().ask.guests}
              fallback={
                <button class={p().ask.danger ? 'danger' : 'primary'} onClick={() => answer('silent')} autofocus>
                  {p().ask.confirmLabel}
                </button>
              }
            >
              <button onClick={() => answer('silent')}>Don't notify</button>
              <button class="primary" onClick={() => answer('notify')} autofocus>Notify guests</button>
            </Show>
          </div>
        </Dialog>
      )}
    </Show>
  );

  return { ask, Host };
}
```

- [ ] **Step 4: Run:** `pnpm test src/ui/NotifyDialog.test.tsx` → PASS.

- [ ] **Step 5: Commit** `git add src/ui/NotifyDialog.* && git commit -m "Add the notify-guests dialog"` (plus attribution lines).

---

### Task 5: Drag, resize and delete on the grid

**Files:**
- Modify: `src/ui/CalendarView.tsx`, `src/ui/styles.css`

**Interfaces:**
- Consumes: `editability`, `hasGuests`, `patchForDrop` (Task 2); `calendar.updateEvent`, `calendar.deleteEvent` (Task 3); `createNotifyDialog` (Task 4); `toast` from `useApp()`.
- Produces: the card shows "why read-only" text and, for editable events, a Delete button; drags and resizes write through the store. (The form arrives in Task 6.)

- [ ] **Step 1: Implement.** In `CalendarView.tsx`:

1. Imports: add `type FullCalendarHandle` to the `@rozie-ui/fullcalendar-solid` import; `import { editability, hasGuests, patchForDrop } from '../calendar/edit';` and `import { createNotifyDialog } from './NotifyDialog';`.
2. Inside `CalendarView()`, after `const { calendar } = useApp();` change to `const { calendar, toast } = useApp();` and add:

```tsx
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const notify = createNotifyDialog();
  const [handle, setHandle] = createSignal<FullCalendarHandle>();

  const find = (id: string) => calendar.state.events.find((e) => e.id === id);

  /** A drop or resize: write it, asking about guests first; put the event back if it isn't written. */
  async function commitTimes(id: string, start: Date | null, end: Date | null, revert: () => void) {
    const ev = find(id);
    const api = handle()?.getApi()?.getEventById(id);
    if (!ev || !api || !start) return revert();
    let sendMessages = false;
    if (hasGuests(ev)) {
      const answer = await notify.ask({
        title: 'Change this event?',
        message: `"${ev.title}" has guests. Email them the new time?`,
        guests: true,
        confirmLabel: 'Change',
      });
      if (answer === 'cancel') return revert();
      sendMessages = answer === 'notify';
    }
    const r = await calendar.updateEvent(ev.baseEventId, patchForDrop(ev, start, end, api.allDay, zone), sendMessages);
    if (!r.ok) {
      revert();
      toast(`Couldn't change the event: ${r.error}`, 'error');
    }
  }
```
3. `events` memo: make each input carry `editable`:

```tsx
  const events = createMemo(() =>
    calendar.state.events.flatMap((e) => {
      const input = toCalendarInput(e, calendar.state.calendars, calendar.hidden());
      return input ? [{ ...input, editable: editability(e, calendar.state.calendars).editable }] : [];
    }),
  );
```
(Remove the now-unused `CalendarInput` import if lint/typecheck complains.)
4. On `<FullCalendar>`: replace `editable={false}` with `editable`, keep `selectable={false}` for now, add `ref={setHandle}`, and:

```tsx
          onEventDrop={({ event, revert }) => void commitTimes(event.id, event.start, event.end, revert)}
          onEventResize={({ event, revert }) => void commitTimes(event.id, event.start, event.end, revert)}
```
5. Render `<notify.Host />` after `<EventPopover … />`. Give `EventPopover` and `EventCard` access to the dialog: change `<EventPopover selected={selected()} onClose={…} />` to also pass `notify={notify.ask}`, and add `notify: (a: NotifyAsk) => Promise<NotifyAnswer>` to its props (import the types), forwarding to `EventCard`.
6. In `EventCard` (takes `notify` and `onClose`), add after the calendar name:

```tsx
      {(() => {
        const state = () => editability(props.event, calendar.state.calendars);
        return (
          <Show when={state()} keyed>
            {(s) =>
              s.editable ? (
                <div class="card-actions">
                  <button class="danger-link" onClick={() => void remove()}>Delete</button>
                </div>
              ) : (
                <p class="why-readonly">{s.reason}</p>
              )
            }
          </Show>
        );
      })()}
```
with, inside `EventCard`:

```tsx
  const { calendar, toast } = useApp();
  async function remove() {
    const ev = props.event;
    const guests = hasGuests(ev);
    const answer = await props.notify({
      title: 'Delete this event?',
      message: guests ? `"${ev.title}" has guests. Email them that it is cancelled?` : `"${ev.title}" will be deleted.`,
      guests,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (answer === 'cancel') return;
    const r = await calendar.deleteEvent(ev.baseEventId, answer === 'notify');
    if (r.ok) props.onClose();
    else toast(`Couldn't delete the event: ${r.error}`, 'error');
  }
```
(Replace the existing `const { calendar } = useApp();` in `EventCard`.)

`styles.css` (after the `.event-card .rsvp` rule):

```css
.event-card .card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.event-card .card-actions button { border: 0; background: none; color: var(--accent); font: inherit; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
.event-card .card-actions button:hover { background: var(--hover); }
.event-card .card-actions .danger-link { color: var(--danger); }
.event-card .why-readonly { color: var(--text-3); font-size: 13px; margin-top: 12px; }
```

- [ ] **Step 2: Typecheck and unit tests:** `pnpm typecheck && pnpm test` → PASS.

- [ ] **Step 3: Check in the browser** (this part is visual; the e2e in Task 7 asserts it later): `pnpm dev`, sign in as alice@example.test / `oinbox-dev-pass`, open /calendar. "Design review" drags and shows the notify dialog; "Weekly sync" does not drag and its card says recurring events can't be edited. If `getEventById` is undefined for the handle, log `handle()?.getApi()` and fix the access before continuing.

- [ ] **Step 4: Commit** `git add -A src && git commit -m "Calendar: drag and resize events, delete from the card, ask before emailing guests"` (plus attribution lines).

---

### Task 6: Create and edit with the small form

**Files:**
- Create: `src/ui/EventForm.tsx`
- Modify: `src/ui/CalendarView.tsx`, `src/ui/styles.css`, `docs/rozie-feedback.md`

**Interfaces:**
- Consumes: `newEventFromSelection`, `writableCalendars`, `defaultCalendarId`, `hasGuests` (Task 2); store writes (Task 3); `notify` (Task 4); `formatWhen` (existing).
- Produces: `EventForm` component:

```ts
interface EventFormProps {
  when: string;                       // formatted time line, e.g. from formatWhen
  calendars: Calendar[];              // writable calendars (the picker's options)
  title: string;                      // initial title
  calendarId: Id;                     // initial calendar
  saveLabel: string;                  // "Create" | "Save"
  /** Resolve with an error message to show, or null when saved. */
  onSave: (title: string, calendarId: Id) => Promise<string | null>;
  onCancel: () => void;
}
```

- [ ] **Step 1: Implement `src/ui/EventForm.tsx`:**

```tsx
import { createSignal, For, onMount, Show } from 'solid-js';
import type { Calendar, Id } from '../jmap/types';

export interface EventFormProps {
  when: string;
  calendars: Calendar[];
  title: string;
  calendarId: Id;
  saveLabel: string;
  onSave: (title: string, calendarId: Id) => Promise<string | null>;
  onCancel: () => void;
}

/** Title and calendar of one event, in a card. Enter saves; the card stays open until the server answers. */
export function EventForm(props: EventFormProps) {
  const [title, setTitle] = createSignal(props.title);
  const [calendarId, setCalendarId] = createSignal(props.calendarId);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;
  onMount(() => queueMicrotask(() => input?.select()));

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      const message = await props.onSave(title().trim(), calendarId());
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="event-card event-form" aria-label="Event" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && !busy() && props.onCancel()}>
      <input ref={input} type="text" aria-label="Title" placeholder="Add a title" autocomplete="off" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
      <p class="when">{props.when}</p>
      <Show when={props.calendars.length > 1}>
        <select aria-label="Calendar" value={calendarId()} onChange={(e) => setCalendarId(e.currentTarget.value)}>
          <For each={props.calendars}>{(c) => <option value={c.id}>{c.name}</option>}</For>
        </select>
      </Show>
      <p class="form-error" role="alert">{error()}</p>
      <div class="dialog-actions">
        <button type="button" disabled={busy()} onClick={props.onCancel}>Cancel</button>
        <button type="submit" class="primary" disabled={busy()}>{busy() ? 'Saving…' : props.saveLabel}</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Create flow in `CalendarView.tsx`.** Add imports (`EventForm`, `formatWhen` is already imported, `newEventFromSelection`, `writableCalendars`, `defaultCalendarId`), turn on `selectable`, and add:

```tsx
  interface Draft { start: Date; end: Date; allDay: boolean; anchor: HTMLElement }
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const closeDraft = () => {
    setDraft(null);
    handle()?.clearSelection();
  };
```
On `<FullCalendar>`: `selectable`, and

```tsx
          onSelect={({ start, end, allDay }) => {
            if (!defaultCalendarId(calendar.state.calendars)) return toast('No calendar here accepts new events.', 'error');
            // The highlight element exists once FullCalendar has drawn the selection.
            queueMicrotask(() => {
              const anchor = document.querySelector<HTMLElement>('.calendar-host .fc-highlight') ?? document.querySelector<HTMLElement>('.calendar-host')!;
              setDraft({ start, end, allDay, anchor });
            });
          }}
          onUnselect={() => {
            // A click inside the form unselects too; the form decides when it is done.
          }}
```
Below `<EventPopover …/>` add the create popover:

```tsx
      <Popover open={!!draft()} bare onOpenChange={(open) => !open && closeDraft()} trigger="manual" strategy="fixed" placement="right-start" reference={draft()?.anchor ?? null}>
        <Show when={draft()} keyed>
          {(d) => (
            <EventForm
              when={formatWhen({ start: d.allDay ? localDate(d.start) : d.start.toISOString(), end: d.allDay ? localDate(d.end) : d.end.toISOString(), allDay: d.allDay })}
              calendars={writableCalendars(calendar.state.calendars)}
              title=""
              calendarId={defaultCalendarId(calendar.state.calendars)!}
              saveLabel="Create"
              onCancel={closeDraft}
              onSave={async (title, calendarId) => {
                const r = await calendar.createEvent(newEventFromSelection(d, calendarId, title, zone));
                if (r.ok) closeDraft();
                return r.ok ? null : r.error;
              }}
            />
          )}
        </Show>
      </Popover>
```
(Import `localDate` from `../calendar/edit` too.)

- [ ] **Step 3: Edit flow.** In `EventPopover`/`EventCard`, add an `editing` signal in `EventCard`: for an editable event the card shows an Edit button beside Delete; while editing, `EventCard` renders `EventForm` instead of the details:

```tsx
      onSave={async (title, calendarId) => {
        const ev = props.event;
        const patch: Record<string, unknown> = {};
        if (title !== ev.title && !(ev.title === '(No title)' && title === '')) patch.title = title;
        const from = ev.calendarIds[0]!;
        if (calendarId !== from) Object.assign(patch, { [`calendarIds/${from}`]: null, [`calendarIds/${calendarId}`]: true });
        if (!Object.keys(patch).length) return (setEditing(false), null);
        let sendMessages = false;
        if (patch.title !== undefined && hasGuests(ev)) {
          const answer = await props.notify({ title: 'Rename this event?', message: `"${ev.title}" has guests. Email them the change?`, guests: true, confirmLabel: 'Rename' });
          if (answer === 'cancel') return null;
          sendMessages = answer === 'notify';
        }
        const r = await calendar.updateEvent(ev.baseEventId, patch, sendMessages);
        if (r.ok) { setEditing(false); props.onClose(); return null; }
        return r.error;
      }}
```
with `when={formatWhen(props.event)}`, `calendars={writableCalendars(calendar.state.calendars)}`, `title={props.event.title === '(No title)' ? '' : props.event.title}`, `calendarId={props.event.calendarIds[0]!}`, `saveLabel="Save"`, `onCancel={() => setEditing(false)}`. The card's Edit button: `<button onClick={() => setEditing(true)}>Edit</button>` before Delete in `.card-actions`. Reset `editing` is automatic because `EventPopover` re-keys `EventCard` per selected event.

- [ ] **Step 4: Styles** (`styles.css`, after the Task 5 rules):

```css
.event-form input[type='text'], .event-form select { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); font: inherit; }
.event-form input[type='text']:focus, .event-form select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.event-form select { margin: 4px 0; }
.event-form .form-error { color: var(--danger); font-size: 13px; min-height: 1em; margin: 4px 0; }
```

- [ ] **Step 5: Log the rozie note** in `docs/rozie-feedback.md` (append under the current heading style used in that file): `No Select package: the event form's calendar picker is a native <select>.` plus: `FullCalendar's eventDrop/eventResize payload has no allDay; the view reads it through getApi().getEventById(id).allDay.` Read the file first and match its entry format.

- [ ] **Step 6: Typecheck, tests, browser check:** `pnpm typecheck && pnpm test`. In `pnpm dev`: drag on Wednesday 14:00–15:00, the form opens beside the highlight with the title selected; Enter creates; Escape closes and the highlight disappears. If the form opens at the wrong place, fix the anchor selector before moving on.

- [ ] **Step 7: Commit** `git add -A src docs && git commit -m "Calendar: create events by dragging on the grid; edit title and calendar from the card"` (plus attribution lines).

---

### Task 7: End-to-end tests

**Files:**
- Modify: `e2e/support/calendar.ts`
- Create: `e2e/calendar-edit.spec.ts`

**Interfaces:**
- Consumes: the UI from Tasks 5–6; `createEvent`, `destroyEvent`, `todayIn` (existing), `jmap`, `accountId`, `ALICE`, `PASSWORD` from `e2e/support/mail.ts`.
- Produces in `support/calendar.ts`: `eventsByTitle(title): Promise<{ id: string; title: string; start: string; duration: string; timeZone: string | null; showWithoutTime?: boolean; calendarIds: Record<string, boolean> }[]>` (alice's events with that title, any calendar), `destroyEventsByTitle(prefix: string): Promise<void>`, `createInvitedEvent(title: string, start: string, timeZone: string): Promise<() => Promise<void>>` (bob organises and invites alice; the returned function removes both copies and alice's invitation email).

- [ ] **Step 1: Add the support helpers** to `e2e/support/calendar.ts`:

```ts
const BOB = 'bob@example.test';
const E2E_PREFIX = 'E2E ';

export interface StoredEvent { id: string; title: string; start: string; duration: string; timeZone: string | null; showWithoutTime?: boolean; calendarIds: Record<string, boolean> }

export async function eventsByTitle(title: string, user = ALICE): Promise<StoredEvent[]> {
  const accountId = await calendarAccount(user);
  const r = await jmap(
    [
      ['CalendarEvent/query', { accountId }, 'q'],
      ['CalendarEvent/get', { accountId, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['id', 'title', 'start', 'duration', 'timeZone', 'showWithoutTime', 'calendarIds'] }, 'g'],
    ],
    user,
    CAL_USING,
  );
  return (r.g.list as StoredEvent[]).filter((e) => e.title === title);
}

/** Delete every event of alice's whose title starts with the e2e prefix (no guests are emailed). */
export async function destroyE2eEvents(): Promise<void> {
  const accountId = await calendarAccount();
  const r = await jmap(
    [
      ['CalendarEvent/query', { accountId }, 'q'],
      ['CalendarEvent/get', { accountId, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['id', 'title'] }, 'g'],
    ],
    ALICE,
    CAL_USING,
  );
  const ids = (r.g.list as { id: string; title: string }[]).filter((e) => e.title?.startsWith(E2E_PREFIX)).map((e) => e.id);
  if (ids.length) await jmap([['CalendarEvent/set', { accountId, sendSchedulingMessages: false, destroy: ids }, 'd']], ALICE, CAL_USING);
}

/** bob organises an event and invites alice (the invitation email is sent: that is how it reaches alice). Returns the cleanup. */
export async function createInvitedEvent(title: string, start: string, timeZone: string): Promise<() => Promise<void>> {
  const bobAccount = await calendarAccount(BOB);
  const calendarId = await defaultCalendar(bobAccount, BOB);
  const r = await jmap(
    [['CalendarEvent/set', { accountId: bobAccount, sendSchedulingMessages: true, create: { x: {
      calendarIds: { [calendarId]: true }, title, start, timeZone, duration: 'PT1H', organizerCalendarAddress: `mailto:${BOB}`,
      participants: {
        b: { calendarAddress: `mailto:${BOB}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
        a: { calendarAddress: `mailto:${ALICE}`, roles: { attendee: true }, participationStatus: 'needs-action' },
      },
    } } }, 's']],
    BOB,
    CAL_USING,
  );
  const bobEventId = r.s.created.x.id as string;
  return async () => {
    await jmap([['CalendarEvent/set', { accountId: bobAccount, sendSchedulingMessages: false, destroy: [bobEventId] }, 'd']], BOB, CAL_USING);
    await destroyE2eEvents();
    const mail = await accountId();
    const found = await jmap([['Email/query', { accountId: mail, filter: { subject: title } }, 'q']], ALICE);
    const ids = found.q.ids as string[];
    if (ids.length) await jmap([['Email/set', { accountId: mail, destroy: ids }, 'd']], ALICE);
  };
}
```
Adjust the existing helpers so the new code type-checks: `defaultCalendar(accountId, user = ALICE)` passes `user` to `jmap`, and import `accountId` from `./mail` (`import { ALICE, BASE, PASSWORD, accountId, jmap } from './mail'`). Do not rename the existing `createEvent` parameter order.

- [ ] **Step 2: Write the spec** `e2e/calendar-edit.spec.ts`. Seeded week events are in US Eastern; alice's default calendar accepts writes.

```ts
import { expect, test, type Page } from '@playwright/test';
import { waitLive } from './support/app';
import { createEvent, createInvitedEvent, destroyE2eEvents, eventsByTitle, todayIn } from './support/calendar';
import { ALICE, jmap, accountId } from './support/mail';

const TZ = 'America/New_York';
test.use({ timezoneId: TZ });
test.afterEach(destroyE2eEvents);

const event = (page: Page, title: string) => page.locator('.calendar-view .fc-event', { hasText: title });
const tag = () => `E2E ${Date.now()}`;

async function openWeek(page: Page) {
  await page.goto('/calendar');
  await expect(page.locator('.calendar-view .fc')).toBeVisible();
  await page.getByRole('button', { name: 'week', exact: true }).click();
  await expect(event(page, 'Design review')).toBeVisible();
  await waitLive(page);
}

/** Drag a vertical span in the time grid on today's column, `fromHour` to `toHour` (local). */
async function dragSlot(page: Page, fromHour: number, toHour: number) {
  const col = page.locator('.calendar-view .fc-timegrid-col.fc-day-today');
  const lane = (h: number) => page.locator(`.calendar-view .fc-timegrid-slot-lane[data-time="${String(h).padStart(2, '0')}:00:00"]`);
  const x = (await col.boundingBox())!;
  const a = (await lane(fromHour).boundingBox())!;
  const b = (await lane(toHour).boundingBox())!;
  await page.mouse.move(x.x + x.width / 2, a.y + 2);
  await page.mouse.down();
  await page.mouse.move(x.x + x.width / 2, b.y + 2, { steps: 8 });
  await page.mouse.up();
}

test('dragging on the grid creates an event with Enter', async ({ page }) => {
  const title = tag();
  await openWeek(page);
  await dragSlot(page, 14, 15);
  const form = page.getByRole('form', { name: 'Event' });
  await expect(form).toBeVisible();
  await form.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.keyboard.press('Enter');
  await expect(event(page, title)).toBeVisible();
  const [stored] = await eventsByTitle(title);
  expect(stored).toMatchObject({ start: `${todayIn(TZ)}T14:00:00`, timeZone: TZ, duration: 'PT1H' });
});

test('Escape closes the create form, clears the highlight and creates nothing', async ({ page }) => {
  await openWeek(page);
  await dragSlot(page, 10, 11);
  await expect(page.getByRole('form', { name: 'Event' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('form', { name: 'Event' })).toHaveCount(0);
  await expect(page.locator('.calendar-view .fc-highlight')).toHaveCount(0);
});

test('an event can be moved by dragging, and is saved', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T11:00:00`, TZ);
  await openWeek(page);
  const box = (await event(page, title).boundingBox())!;
  const target = (await page.locator(`.calendar-view .fc-timegrid-slot-lane[data-time="13:00:00"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, target.y + 4, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await eventsByTitle(title))[0]?.start).toBe(`${todayIn(TZ)}T13:00:00`);
});

test('an event can be renamed and moved to another calendar from its card', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T09:00:00`, TZ);
  await openWeek(page);
  await event(page, title).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  const form = page.getByRole('form', { name: 'Event' });
  await form.getByRole('textbox', { name: 'Title' }).fill(`${title} renamed`);
  await form.getByRole('combobox', { name: 'Calendar' }).selectOption({ label: 'Team' });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(event(page, `${title} renamed`)).toBeVisible();
  const [stored] = await eventsByTitle(`${title} renamed`);
  expect(Object.keys(stored!.calendarIds)).toHaveLength(1);
});

test('an event can be deleted from its card', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T08:00:00`, TZ);
  await openWeek(page);
  await event(page, title).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete this event?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(event(page, title)).toHaveCount(0);
  expect(await eventsByTitle(title)).toHaveLength(0);
});

test('a recurring event and an invited event are read-only, with a reason', async ({ page }) => {
  const title = tag();
  const cleanup = await createInvitedEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
  try {
    await openWeek(page);
    await event(page, 'Weekly sync').click();
    await expect(page.getByText("Recurring events can't be edited yet.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(event(page, title)).toBeVisible({ timeout: 15_000 });
    await event(page, title).click();
    await expect(page.getByText(/invited to this event/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('moving an event with guests asks first; Cancel puts it back and sends nothing', async ({ page }) => {
  await openWeek(page);
  const before = (await event(page, 'Design review').boundingBox())!;
  const target = (await page.locator(`.calendar-view .fc-timegrid-slot-lane[data-time="15:00:00"]`).boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + 6);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2, target.y + 4, { steps: 10 });
  await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: 'Change this event?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  const after = (await event(page, 'Design review').boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect((await eventsByTitle('Design review'))[0]!.start).toMatch(/T10:00:00$/);
});

test('a failed write puts the dragged event back and says so', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T11:00:00`, TZ);
  await openWeek(page);
  await page.route('**/jmap/', async (route) => {
    if (route.request().postData()?.includes('"CalendarEvent/set"')) return route.fulfill({ status: 500, body: 'boom' });
    return route.continue();
  });
  const box = (await event(page, title).boundingBox())!;
  const target = (await page.locator(`.calendar-view .fc-timegrid-slot-lane[data-time="13:00:00"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, target.y + 4, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.toast', { hasText: "Couldn't change the event" })).toBeVisible();
  const after = (await event(page, title).boundingBox())!;
  expect(Math.abs(after.y - box.y)).toBeLessThan(2);
});
```
(Remove the unused `ALICE, jmap, accountId` import if lint flags it. The notify-guests path that actually emails is covered by the store unit test plus the Cancel case; checking bob's inbox for Notify is deliberately skipped to keep the suite fast — if time allows, add it using `deliverToAlice`-style helpers in `support/mail.ts`.)

- [ ] **Step 3: Run:** `pnpm build && pnpm e2e e2e/calendar-edit.spec.ts` → PASS. Selector fixes (the lane `data-time` attributes, `.fc-timegrid-col.fc-day-today`, the form's accessible name) belong here: debug with `--headed` and fix the spec, not the app, unless the app is wrong.

- [ ] **Step 4: Run the whole e2e and unit suites:** `pnpm test && pnpm e2e` → all PASS (the calendar spec from slice 1 included: its read-only assertions still hold because the seeded events keep their times).

- [ ] **Step 5: Commit** `git add e2e && git commit -m "Add e2e tests for creating, moving, editing and deleting calendar events"` (plus attribution lines).

---

## Self-review notes

- Spec coverage: create popover (T6), drag/resize (T5), edit title/calendar (T6), delete (T5), editable rule with `myRights`/`isOrigin`/recurring (T1–T2), notify prompt (T4–T6), optimistic revert (T5), form server-confirmed (T6), time-zone rules (T2), error table (T3, T5, T6), touch (no code; FullCalendar default), read-only reason text (T5), rozie notes (T6). The "event turns read-only while its form is open" row of the spec is not implemented: the card re-renders from `selected`, which holds a snapshot, so the form can save against an event that has just become read-only and the server's refusal shows in the form. Accepted for this slice; mention it in the final review.
- Types used across tasks: `WriteResult`, `NotifyAnswer`, `NotifyAsk`, `EventFormProps`, `Editability` are defined where produced and used with those names.
