# oinbox calendar, slice 1: read-only views

This slice adds a read-only calendar that sits next to mail. It is built on Stalwart's JMAP Calendars support and `@rozie-ui/fullcalendar-solid`.
It is the first of four slices. The later slices are listed at the end and each gets its own spec.

## Goal

Alice opens **Calendar** from the sidebar and sees her events in a month, week or day view. The events come from every calendar she has. The calendar stays up to date through the same push channel that mail uses.
The same page also covers what she does in slice 1: open an event's details, and hide or show a calendar.
Nothing in this slice writes to the server.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Protocol | JMAP Calendars (`urn:ietf:params:jmap:calendars`) on the existing session. No CalDAV. | Stalwart 0.16.23 advertises it. Calendars share mail's session, token, client and push stream. |
| Data strategy | Fetch the visible date range from the server (approach A). No local mirror and no IndexedDB. | The server expands recurrences and computes UTC times, so the bundle needs no RRULE engine or time-zone database. A warm-start snapshot (approach C) can be added later without a redesign. |
| Recurrence expansion | `CalendarEvent/query` with `expandRecurrences: true` | Checked by a spike on 2026-09-28. It returns one id per occurrence with `baseEventId`, `recurrenceId`, `utcStart` and `utcEnd`, and it drops cancelled occurrences. Sorting on `start` works. The account limit is `maxExpandedQueryDuration: P52W1D`. |
| Occurrence data | Merge each occurrence with its base event on the client. Timing is the server's `utcStart` plus the merged `duration`. The server's `utcEnd` is ignored. | Spike result: a moved occurrence contains only the fields that were changed. When only `start` was changed, the occurrence came back **with no `title` and `duration: PT12H59M59S`**, and `utcEnd` was wrong to match. Moved occurrences can also come from other clients (for example Apple Calendar over CalDAV), so the client cannot rely on them being complete. |
| JSCalendar version | The newer JSCalendar draft ("JSCalendar bis"): a singular `recurrenceRule`; participants with `calendarAddress: "mailto:…"`; the organizer as `organizerCalendarAddress` | Probed on 2026-09-28. Stalwart rejects `recurrenceRules` (an array) with `invalidProperties`. It also accepts participants written with the old `email`/`sendTo` fields but **silently drops them**. |
| Query time zone | The browser's time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) | All-day and floating events have no time zone of their own. They have to be placed on the viewer's calendar days, not UTC ones. |
| OAuth scope | Add `urn:ietf:params:oauth:scope:calendars` to the requested scope | Stalwart 0.16.23 does not enforce scopes: a token with only the mail scope read calendars in a test. Asking for the scope protects against future enforcement and signs nobody out. |
| Component | `@rozie-ui/fullcalendar-solid` 0.1.x, with the `@fullcalendar/*` 6.1 peer packages (core, daygrid, timegrid, interaction; all MIT) | Dogfooding. Gaps go in `docs/rozie-feedback.md`. |
| Hidden calendars | A display preference for each browser, kept in `localStorage` | Slice 1 does not write to the server. `Calendar.isVisible` stays untouched until a later slice decides whether hiding a calendar should sync between devices. |

## Architecture

```
src/
  jmap/types.ts        + Calendar and CalendarEvent (the JSCalendar fields used below)
  jmap/client.ts       + CALENDARS capability constant (send() already takes `using`)
  jmap/sse.ts          push types += Calendar,CalendarEvent
  calendar/instances.ts  pure functions: range request builder and occurrence merge. No Solid imports.
  calendar/store.ts      CalendarStore: calendar list, visible-range events, cache, push handling
  ui/CalendarView.tsx    FullCalendar wrapper, event popover
  ui/Shell.tsx           sidebar entry and calendar list on /calendar
  index.tsx              scope, /calendar route, sends state changes to the store
```

`ui/` reads the store and never calls `jmap/` directly, as in the existing code.

### Range request (`buildRangeRequest(range, tz)`)

A range fetch is one JMAP request with three calls that use back-references:

1. `CalendarEvent/query` with `{ filter: { after, before }, expandRecurrences: true, timeZone: tz, sort: [{ property: 'start' }] }`
2. `CalendarEvent/get` with `#ids` from call 1. Properties: `id, baseEventId, recurrenceId, calendarIds, title, start, timeZone, duration, showWithoutTime, utcStart, color`.
3. `CalendarEvent/get` with `#ids` = the `baseEventId` values from call 2's list. Properties: the same display fields plus `recurrenceOverrides, description, locations, participants`.

Call 3 fetches each base event once per range. A probe confirmed this: three occurrences of one series returned one base record. The client still stores base events by id, so a duplicate would be harmless.

`calendarIds` is a set. An event is shown under the first of its calendars that the viewer has not hidden.

### Occurrence merge (`toDisplayEvents(instances, bases, tz)`)

Each occurrence becomes a display object for FullCalendar:
`{ id, baseEventId, calendarId, title, start, end, allDay, color, location }`.

- **The effective event** is the base event with `base.recurrenceOverrides[instance.recurrenceId]` applied on top. Only top-level keys are applied. Keys written as JSON paths (such as `participants/abc/participationStatus`) are skipped for display purposes, and they must not throw. Non-recurring events need no special case: the spike showed that the expanded query also returns them as an occurrence id with a `baseEventId`, and call 3 fetches their base.
- **Timed events:** `start = instance.utcStart` and `end = utcStart + effective.duration` (ISO 8601 duration; a missing duration counts as zero).
- **All-day events** (`showWithoutTime: true`): `allDay = true`, `start` = the date part of the effective `start`, and `end` = start plus the effective duration in days. FullCalendar treats that end date as exclusive.
- `title` falls back to "(No title)". `color` is the effective event's `color`, then the calendar's `color`, then a `--cal-default` token (`#0b57d0` in both themes). It is not the accent token, because the dark theme's accent is a light blue and white event text on it would be unreadable.
- `location` is the `name` of the first entry in `locations`.

### CalendarStore

- `calendars`: a Solid store filled by `Calendar/get`, and refreshed when the `Calendar` state changes.
- `show(range)`: shows the range straight from the cache if it is there. Otherwise it fetches the range and marks the store as loading.
  Every fetch gets a sequence number, and only the newest response is applied. Quick prev/next paging can therefore never display an older range.
- **Cache:** an in-memory map from range key to display events, holding at most 8 ranges with the least recently used dropped first. The whole cache is cleared whenever the `CalendarEvent` state differs from the last state the store saw.
- `onStateChange(change)`: if the `Calendar` or `CalendarEvent` state changed, clear the cache and fetch the visible range again.
- `onConnected()`: after a push reconnect, fetch the visible range again, the same way mail's `catchUp` runs after a reconnect.
- The store is created only when the session has the calendars capability.

## UI

- **Route** `/calendar`. It does not clash with mail routes, because mailbox slugs are role names (`/inbox`) or `/label/<id>`. `Shell` stays in place, so the top bar, theme toggle and live-updates indicator are shared.
- **Sidebar:** a **Calendar** entry below the mailbox list. On `/calendar` the sidebar also lists the calendars, each with its colour dot and a checkbox to show or hide it.
- **Shortcut:** `g k` goes to the calendar. It is added to the existing `g`-prefix handling in `ui/keyboard.ts` and to the help dialog.
- **`CalendarView`**
  - `<FullCalendar>` with `editable={false}` and `selectable={false}`.
  - `r-model:view` is saved in `localStorage` (`oinbox.calendar.view`). The default is `timeGridWeek`, or `timeGridDay` when the window is narrower than 700px.
  - The component's own toolbar handles today, prev/next and the month/week/day switch.
  - `datesSet` calls `store.show({ start, end })`, and `events` reads from the store with hidden calendars filtered out.
- **Event popover:** `@rozie-ui/popover-solid`, opened from `eventClick`. It is read-only and shows:
  - the title;
  - the time range, formatted in the browser's time zone (all-day events show a date range);
  - the location;
  - the description as plain text;
  - the participants with their `participationStatus` (the address is `calendarAddress` without the `mailto:` prefix);
  - the calendar name.
- **Loading and empty states:** a thin progress bar while the store is fetching (`state.loading`). FullCalendar's own `loading` event only fires for event sources that FullCalendar fetches itself, and its `noEventsContent` slot only renders in list views, so neither applies here. An empty week shows an empty grid.
- **Theming:** FullCalendar's CSS variables are mapped to the existing tokens in `styles.css`, so light and dark mode follow mail automatically.

## Seed data (`deploy/seed/seed_calendar.py`)

`seed.sh` runs this script after `seed_mail.py`, using the same Python image. It creates events for Alice:

- A second calendar called "Team" with its own colour, next to her default calendar.
- A few timed meetings this week, on both calendars.
- One all-day event and one event that spans several days.
- One event with `timeZone: Europe/London`, to test time-zone conversion.
- A weekly standup with a `recurrenceRule`. One of its occurrences is **moved by changing only `start`**, which reproduces the spike quirk on every run. Another occurrence is cancelled (`excluded: true`).

Dates are relative to the current week, which starts on Sunday to match FullCalendar's default `firstDay`. Each event has a fixed `uid`. Stalwart 0.16 returns nothing for the `uid` filter of `CalendarEvent/query`, so the script lists every event with its `uid` and matches them itself. On a re-run it finds each event by `uid` and moves it into the current week with `CalendarEvent/set` `update`, so it never creates duplicates. The "Team" calendar is looked up by name and created only if it is missing. Updating events does not sign anyone out; only a password change does that.

## Errors

| Case | Behaviour |
|---|---|
| A range fetch fails (network error or method error) | Events already on screen stay. One error toast is shown per failure streak, not one per retry. The fetch is retried on the next navigation, push event or reconnect. |
| 401 | Handled by the existing `onUnauthorized` path: renew the token, then sign out. |
| The session lacks `urn:ietf:params:jmap:calendars` | The Calendar sidebar entry and `g k` are hidden, and `/calendar` redirects to `/inbox`. |
| A range longer than the server limit | Cannot happen, because views are at most 6 weeks against a 52-week limit. `buildRangeRequest` asserts this; there is no clamping logic. |

## Testing

**Unit tests (vitest)**

- `calendar/instances.test.ts`:
  - A moved occurrence where only `start` changed: the title and duration come from the base event, and `end` is `utcStart` plus the base duration.
  - An override that sets `duration` and `title`.
  - A cancelled occurrence is not in the output.
  - A floating all-day event, run with a browser time zone that is not UTC (for example `Pacific/Auckland`), lands on the right date.
  - An event whose `timeZone` differs from the browser's.
  - Override keys written as JSON paths do not throw and are ignored.
  - A missing title gives "(No title)".
  - The colour falls back from event to calendar to token.
- `calendar/store.test.ts`, using a small calendar extension to `FakeJmap` (`Calendar/get`, and `CalendarEvent/query` and `/get` serving canned occurrences):
  - The newest request wins when requests overlap.
  - A cached range is served without a fetch.
  - A state change clears the cache and fetches again.
  - A reconnect fetches again.
  - A failed fetch keeps the old events and shows one toast.

**E2E (`e2e/calendar.spec.ts`, real stack)**

- The seeded events show in week view.
- The moved standup shows the correct title as a 30-minute block.
- An event created through JMAP (Basic auth) while the page is open appears without a reload, through push. The test deletes it afterwards.
- Clicking an event opens the popover with its location and participants.
- `g k` from the inbox opens `/calendar`.
- Hiding the "Team" calendar in the sidebar removes its events from the view.

## Later slices (out of scope here)

2. Create, move and resize single events (`select`, `eventDrop`, `eventResize` → `CalendarEvent/set`).
3. Invitations in mail: parse `.ics` attachments with `CalendarEvent/parse`, show an invite card in the conversation, and send RSVPs.
4. Editing recurring events ("this event" or "all events", written as `recurrenceOverrides`), free/busy (`principals:availability`) and calendar management.

Possible follow-up: a warm-start snapshot of the last viewed range (approach C) if the blank calendar on a cold start is noticeable in daily use.
