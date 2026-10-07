# oinbox calendar, slice 2: create, move, resize, edit and delete single events

This slice makes the calendar writable. A user drags on the grid to create an event, drags an event to move it, drags its edge to resize it, and edits its title and calendar or deletes it from its details card.
It is slice 2 of four calendar slices (slice 1 added the read-only views; see `2026-09-28-calendar-slice1-design.md`). It builds the `CalendarEvent/set` path that slice 3 (invitations in mail, RSVP) reuses.

## What the user sees

Alice drags from 14:00 to 15:00 on Wednesday. A small card opens beside the selection with a focused title field, "Wed 7 Oct, 14:00–15:00", a calendar picker and Save / Cancel. She types "Dentist" and presses Enter. The event appears.
She drags "Dentist" to Thursday: it moves at once. She drags its bottom edge to 16:00: it resizes. She opens it, presses Edit, renames it, saves, then deletes it.
She drags "Design review", an event she organises with Bob. A dialog asks "Notify guests?" with Notify guests, Don't notify and Cancel. Cancel puts the event back.
Events she was invited to, recurring events, and events on a calendar she can't write to show no drag handles and no Edit or Delete; their card says why in one line.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Scope | Create, move, resize, edit title and calendar, delete. Single events only. | Agreed 2026-10-07. Location, description, participants and recurrence editing are later slices. |
| Create flow | Dragging on the grid (or clicking a day in month view) opens a small popover: title, time range, calendar picker, Save, Cancel. Enter saves, Escape cancels. | Agreed. Quick, and keyboard friendly. Month view creates an all-day event. |
| Edit | The details card gets Edit, which swaps it for the same form (title and calendar) and Delete. | Agreed. One form for both. |
| Which events are editable | A non-recurring event on a calendar where `myRights.mayWriteAll` is true, and either the user organises it (`isOrigin`) or it has no other participants. | Agreed. `myRights` and `isOrigin` come from the server; nothing is guessed. |
| Guests | Moving, resizing, renaming or deleting an event that has guests asks Notify guests / Don't notify / Cancel first. Notify sends `sendSchedulingMessages: true`; Don't notify sends `false`. | Agreed (ask each time). Creating never has guests in this slice, so it sends `false`. |
| Drag writes | Optimistic: the grid moves the event at once. A failed write calls `revert()` and shows a toast. The push event refetches the range as in slice 1. | FullCalendar already moved the event; waiting would make a drag feel broken. |
| Form writes | Server-confirmed. The form stays open and disabled until the call returns; an error stays in the form. | The user is waiting on the form anyway. |
| New event calendar | The user's default calendar (`isDefault`), else the first writable one. The picker lists writable calendars only. | |
| Time zone | A new timed event uses the browser's zone. A moved or resized event keeps its own `timeZone`. All-day events stay all-day (`showWithoutTime`). | The client never converts an event into another zone behind the user's back. |
| Default length | The selection is used as it is. A click in week/day view selects one 30-minute slot. | A click and a deliberate one-slot drag cannot be told apart, so no special case. |

## Probed on Stalwart 0.16 (2026-10-07, local stack)

- `CalendarEvent/set` `create` takes `{ calendarIds, title, start, timeZone, duration }`; an all-day event takes `showWithoutTime: true`, `start: "…T00:00:00"`, `duration: "P1D"`. The server adds `uid`, `isDraft: false` and `isOrigin: true`.
- `update` takes plain patches: `start`, `duration`, `title`, and `calendarIds/<id>: true` or `null` to move between calendars. A patch that leaves the event with no calendar is not used.
- `Calendar/get` returns `myRights` (`mayWriteAll`, `mayWriteOwn`, `mayDelete`, `mayRSVP`, …). The Team calendar and the default calendar both grant everything to alice. Slice 1's `Calendar` type doesn't carry `myRights` yet.
- An event the user organises has `isOrigin: true`, `organizerCalendarAddress`, and an `owner` role on the user's participant. Other participants have no `owner` role.
- `sendSchedulingMessages: false` on create sends nothing. A later update with `true` emails each guest the message **"Invitation: …"** (not "Updated"), because no invitation had been sent. `destroy` with `true` emails **"Cancelled: …"**.
- An event organised by bob with alice as a guest appears in alice's default calendar with `isOrigin: false` and the same `organizerCalendarAddress`, but only when bob's create sent scheduling messages (`true`); with `false` nothing is delivered. Alice also gets an "Invitation: …" email.
- Not probed: rights on a calendar shared by someone else (needs sharing set up). The editable rule treats missing `myRights` or `isOrigin` as read-only, and that case is unit-tested only.

## Components

- **`CalendarEvent/set` in `CalendarStore`** (`src/calendar/store.ts`): `createEvent`, `updateEvent`, `deleteEvent`. Each sends one call with the right `sendSchedulingMessages`, then lets the push event refetch. They are the only code that sends `CalendarEvent/set`. Each returns a result the caller can act on (`ok` or an error message); none throws for a server rejection.
- **`src/calendar/edit.ts`** (pure, unit-tested):
  - `editability(event, calendars)` → `{ editable: true } | { editable: false, reason }`. Reasons: recurring, invited, calendar read-only.
  - `hasGuests(event)` → true when any participant other than the organizer exists.
  - `patchForDrop(event, newStart, newEnd, allDay)` → the `start` / `duration` / `showWithoutTime` patch, keeping the event's time zone; an all-day drop onto the time grid and the reverse both convert correctly.
  - `newEventFromSelection(range, allDay, calendarId, title)` → the create object.
- **`DisplayEvent`** gains `isOrigin`; **`Calendar`** gains `myRights`; both are fetched by the existing calls.
- **`CalendarView`**: `selectable` and `editable` turn on; `editable: false` per event for non-editable ones, through the event input. `onSelect` opens the form at the selection, `onEventDrop` and `onEventResize` call the store, `onUnselect` closes an unsaved form.
- **`EventForm`** (`src/ui/EventForm.tsx`): the popover for create and edit. A rozie Popover anchored to the selection or event, like the details card. Title input, a read-only time line, a calendar `Select`.
- **`NotifyDialog`**: a three-button dialog on the existing Dialog. Returns `'notify' | 'silent' | 'cancel'`.

## Data flow

1. **Create:** `onSelect({ start, end, allDay })` → `EventForm` (create) → Save → `createEvent` → push refetch shows it. Cancel or a failed save clears the selection.
2. **Move or resize:** `onEventDrop` / `onEventResize` → if `hasGuests`, `NotifyDialog` (cancel → `revert()`) → `updateEvent(patch, notify)` → on error `revert()` and a toast.
3. **Edit:** card → Edit → `EventForm` (edit) → Save → `updateEvent`. Changing the title of an event with guests asks the same question first.
4. **Delete:** card → Delete → `ConfirmDialog` ("Delete 'Dentist'?"); events with guests use `NotifyDialog` instead, worded for deletion. Then `deleteEvent`.

## Errors

| Case | Behaviour |
|---|---|
| A drag or resize write fails | `revert()`, one toast "Couldn't move the event". |
| A form save fails | The form stays open with the message under the fields; the user can retry or cancel. |
| `notFound` on update or delete (deleted elsewhere) | Toast "That event no longer exists"; the range refetches. |
| The server is offline | As any write: the store reports the failure; no queue. |
| An event turns read-only after a push refetch | Its handles disappear on the next render. An open form for it closes with a toast. |
| An edit and a push arrive together | The write wins on the server; the refetch shows the result. No client-side merge. |

## Touch and keyboard

- Touch: FullCalendar's long-press selects and drags. No extra gestures.
- Keyboard: the form is fully keyboard operable. Moving or resizing by keyboard is **not** in this slice; the card's Edit form is the keyboard path to change a title, and there is no keyboard path for changing times yet (see "Out of scope").

## Testing

- **Unit:** `edit.ts` (editability for every reason; guests; drop patches for timed, all-day, zone-keeping, all-day↔timed); `CalendarStore` writes with a fake client (flags sent, error mapping, no throw).
- **e2e (Playwright, real Stalwart):** drag to create and Enter to save; move; resize; edit title and calendar; delete; a recurring event and an invited event show no handles; a guest event asks to notify (Notify, Don't notify and Cancel each checked; Notify checked by reading bob's inbox through `e2e/support/mail.ts`); Cancel reverts; a rejected write reverts (by forcing a failure with a route intercept).
- The seed script gets an event alice organises with bob (it exists: "Design review") and an event in the "Team" calendar; a read-only calendar and an invited event need an invited event is created in the test through bob (with scheduling messages on, which emails alice; the test removes the event and the email). A read-only calendar stays unit-tested only.

## Rozie

- `@rozie-ui/fullcalendar-solid` 0.2.0 already exposes `onSelect`, `onEventDrop`, `onEventResize` (with `revert()`) and `onUnselect`. Nothing is blocked.
- To confirm while writing the plan, by reading the sources: whether `selectable` has a `selectMirror`-like preview, whether `editable` can be set per event, and how `Select` fits inside a Popover. Findings go to `docs/rozie-feedback.md`; anything that blocks pauses the work.

## Out of scope

- Editing recurring events, and "this event / all events" (slice 4).
- Adding or removing participants, invitations in mail and RSVP (slice 3).
- Location, description, colour, alerts and time-zone choice in the form.
- Editing an event's start and end times in the form; time changes happen by dragging only.
- Keyboard moving and resizing of events.
- Free/busy and calendar management.
- A warm-start snapshot of the last viewed range.
