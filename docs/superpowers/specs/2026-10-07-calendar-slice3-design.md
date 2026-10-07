# oinbox calendar, slice 3: invitations in mail

This slice shows an invite card on messages that carry a calendar invitation, and lets the user answer it (Accept, Maybe, Decline) from the message.
It is slice 3 of four calendar slices (slice 1: read-only views; slice 2: create, move, resize, edit, delete single events). It reuses slice 2's `CalendarEvent/set` path.

## What the user sees

Bob invites Alice to "Design review". Alice opens the email. Above the message body is a card: the title, "Tue 8 Dec, 10:00–11:00 (Europe/London) · 5:00–6:00 AM your time", the place, "Organizer: Bob Example", the guests with their answers, and three buttons: Accept, Maybe, Decline. She presses Accept. The button is highlighted, a toast says "Reply sent to Bob Example", and Bob's calendar and inbox show her answer.
Later Bob moves the meeting. Alice's old invitation email now says "Updated since this message" and shows the new time. The new "Updated invitation" email shows the same card. When Bob cancels, both emails show "Cancelled" with no buttons, and the event appears struck through on Alice's calendar.
If an invitation's event isn't in Alice's calendar (a message from outside, or one she deleted), the card shows what the email says, "This event isn't in your calendar", and no buttons.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Scope | Card with Accept / Maybe / Decline for events that are in the user's calendar; updated and cancelled states; cancelled events muted and read-only on the grid. | Agreed 2026-10-07 (option 1). |
| Source of truth | The user's calendar copy of the event, found by `uid`. The email only supplies the `uid` and the `method` (`request` or `cancel`). | Probed: Stalwart files an invitation in the invitee's calendar by itself, updates it in place, and marks a cancellation with `status: "cancelled"`. Every email about the event can therefore show the live state. |
| Reply to the organizer | RSVP is always sent (`sendSchedulingMessages: true`). | The point of answering. Probed: the organizer's calendar then shows the new status and the organizer gets a "Tentative: …" email. |
| Recurring invitations | An answer applies to the whole series. | Per-occurrence answers belong to slice 4. The card says "Repeats weekly" so the scope is visible. |
| Methods handled | `request` and `cancel`. A message whose calendar part has another method (`reply`, `publish`, `counter`, …) gets no card. | The user cannot act on the others in this slice. |
| Failure | If parsing or lookup fails, no card is shown and the message reads as before. An RSVP that fails keeps the buttons and shows a toast. | A card must never get in the way of the mail. |
| Cancelled events on the grid | Muted and struck through, not draggable, with the reason "This event was cancelled." on the card. | They stay in the calendar in Stalwart; showing them like live events is wrong. |

## Probed on Stalwart 0.16 (2026-10-07, local stack)

- The session lists `urn:ietf:params:jmap:calendars:parse`. `CalendarEvent/parse` with `{ accountId, blobIds: [calendarPartBlobId] }` returns `parsed[blobId]`: a list of JSCalendar events with `uid`, `sequence`, `title`, `start`, `timeZone`, `duration`, `participants`, `organizerCalendarAddress` and `method: "request"`.
- The invitation email has the structure `multipart/mixed › multipart/related › multipart/alternative › [text/plain, text/html, text/calendar]`. The `text/calendar` part has a `blobId`.
- Bob's `CalendarEvent/set` with `sendSchedulingMessages: true` files the event in Alice's default calendar at once: same `uid`, `isOrigin: false`, her participant at `needs-action`. With `false`, nothing is delivered.
- Alice patching `participants/<id>/participationStatus` on her copy with `sendSchedulingMessages: false` changes only her copy. With `true`, Bob's copy shows her status and Bob gets an email.
- Bob updating the title and time (send on): Alice's copy changes in place (`sequence` 0 → 1) and she gets "Updated invitation: …".
- Bob destroying the event (send on): Alice's copy stays, with `status: "cancelled"`, and she gets "Cancelled: …".
- The `uid` filter of `CalendarEvent/query` matches nothing (slice 1 finding), so the copy is found by listing events and reading their `uid`.
- Probed while building (2026-10-07): the `text/calendar` part is in `email.attachments` (next to an `application/ics` `event.ics` part). `CalendarEvent/query` with an `after`/`before` window and no `expandRecurrences` works and returns base event ids; an unfiltered query with `limit` works. Stalwart delivers no invitation for an event that is already in the past, so e2e fixtures must start in the future.

## Components

- **`src/calendar/invite.ts`** (pure, unit-tested):
  - `findInvitePart(email)` → the `text/calendar` part (`blobId`), or null.
  - `inviteState(parsed, copy, now)` → one of `{ kind: 'pending' | 'answered', … }`, `{ kind: 'updated' }`, `{ kind: 'cancelled' }`, `{ kind: 'missing' }`, using the email's `method` and `sequence` against the copy's `status` and `sequence`.
  - `myParticipant(copy, myAddresses)` → `{ id, status } | null`, matching `calendarAddress` (without `mailto:`) against the user's identities and the session username, case-insensitively.
  - `rsvpPatch(participantId, status)` → `{ ['participants/<id>/participationStatus']: status }`.
  - `describeWhen(event, viewerZone)` → "Tue 8 Dec, 10:00–11:00 (Europe/London) · 5:00–6:00 AM your time" (the second part only when the zones differ).
- **`CalendarStore`**:
  - `parseInvite(blobId)` → `{ ok: true, event } | { ok: false }`; sends `CalendarEvent/parse` with `using` including the parse capability.
  - `findByUid(uid, near?)` → the copy as a `DisplayEvent`-like record with `sequence` and `status`, or null. It looks at events within ±7 days of `near`, then falls back to a capped scan (at most 2000 ids) of all events; the result for a `uid` is cached until a `CalendarEvent` state change.
  - `rsvp(eventId, participantId, status)` → `WriteResult`; it is `updateEvent(eventId, rsvpPatch(...), true)`.
- **`DisplayEvent`** gains `sequence` and `status` (from the base properties) and `editability` refuses a `cancelled` event ("This event was cancelled.").
- **`src/ui/InviteCard.tsx`**: the card; used by `Conversation.tsx` above each message body that has an invite part.
- **Grid:** `toCalendarInput` adds a `cancelled` class; styles mute and strike through.
- **`FakeJmap`** gains `CalendarEvent/parse`, serving parsed events keyed by blob id.

## Data flow

1. A message renders. `findInvitePart(email)` finds a calendar part, or the card is not mounted.
2. `parseInvite(blobId)` → the parsed event. If its `method` is neither `request` nor `cancel`, no card.
3. `findByUid(parsed.uid, parsed.start)` → the copy, or null (state `missing`).
4. The card shows `inviteState(...)`. Buttons are enabled when the copy exists, isn't cancelled, `myParticipant` finds the user, and the calendar's `myRights.mayRSVP` is true.
5. A button calls `rsvp(...)`. On success the store refetches (as in slice 2), the card re-reads the copy, and a toast says "Reply sent to <organizer>". On failure a toast explains and the previous answer stays.

## Errors

| Case | Behaviour |
|---|---|
| The parse capability is missing, or `parse` fails | No card; the message reads as before. |
| The copy isn't found | State `missing`: details from the email, a note, no buttons. |
| The user isn't a participant (a forward, a BCC) | Details and a note "You aren't listed as a guest", no buttons. |
| An RSVP is refused or the network fails | Toast with the reason; the highlighted answer doesn't change. |
| The copy is deleted while the card is open | The card turns to `missing` after the refetch. |
| Two quick clicks | The buttons are disabled while a reply is in flight. |

## Testing

- **Unit:** `invite.ts` (part detection in a nested structure, each state, `mayRSVP`, participant matching with `mailto:` and case, `describeWhen` across zones and for all-day events); the store (`parseInvite` ok and failing, `findByUid` window and fallback and cache clearing, `rsvp` sends notify on and uses the copy's id); `editability` for cancelled.
- **Component:** `InviteCard` states and button behaviour against a fake store.
- **e2e (real Stalwart):** Bob invites Alice (existing `createInvitedEvent` helper); Alice opens the email, sees the card, presses Accept; Bob's side shows `accepted` and the "Accepted: …" email. Then Bob updates the time and the old email says "Updated since this message"; then Bob cancels and the card says "Cancelled", the buttons are gone, and the calendar grid shows the event struck through. Cleanup removes both calendars' events and the emails.

## Rozie

- Buttons are plain; no new rozie component is expected. Anything found goes to `docs/rozie-feedback.md`; a blocker pauses the work.

## Out of scope

- "Add to calendar" for invitations Stalwart didn't file.
- Counter-proposals, delegation, and answering with a comment.
- Per-occurrence answers (slice 4).
- Composing or sending invitations, and adding guests to events.
- An invitation marker in the thread list, and desktop notifications.
