# Calendar Slice 3 (Invitations in Mail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an invite card (details, Accept / Maybe / Decline) above messages that carry a calendar invitation, driven by the user's own calendar copy of the event.

**Architecture:** A pure `src/calendar/invite.ts` (part detection, state, participant matching, RSVP patch, time text). `CalendarStore` gains `parseInvite` (`CalendarEvent/parse`), `findByUid` (window query, then capped scan, cached per store generation) and `rsvp` (`updateEvent` with scheduling messages on). A props-driven `InviteCardView` plus a wiring `InviteCard` mount in `Conversation.tsx`. Cancelled events become read-only and muted on the grid.

**Tech Stack:** Solid + Vite, vitest + @solidjs/testing-library, Playwright e2e against a real Stalwart 0.16, FullCalendar.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-slice3-design.md`

## Global Constraints

- Source of truth is the user's calendar copy found by `uid`; the email only supplies `uid` and `method`.
- Methods handled: `request` and `cancel` only; any other method gets no card.
- RSVP is always sent: `sendSchedulingMessages: true`. An answer applies to the whole series.
- A card must never get in the way of the mail: parse or lookup failure means no card; a failed RSVP keeps the buttons and toasts.
- Cancelled events: muted, struck through, not draggable, reason text "This event was cancelled."
- Toast on success: "Reply sent to <organizer>".
- Parse capability: `urn:ietf:params:jmap:calendars:parse`.
- Code style: match surrounding code (terse comments, no Solid imports in pure files, TS strict).
- Stalwart facts probed 2026-10-07 are in the spec; the `uid` filter of `CalendarEvent/query` matches nothing, so copies are found by listing and reading `uid`.

## Review Focus

- Two invitations for one `uid` in a thread (request then update): both cards show the live copy; the old one says "Updated since this message" (Task 1 `inviteState`, Task 4 view).
- User is a guest under another address (alias or BCC): "You aren't listed as a guest", no buttons (Task 1 `myParticipant`, Task 4).
- All-day invitation: time text has no zone part (Task 1 `describeWhen`).
- Floating-time event (no `timeZone`): no "your time" part, no crash (Task 1).
- Calendar part with `method: reply`/`publish`, or parse returns zero events: no card (Task 3 `parseInvite` + Task 4).
- Rapid double click on a button: only one `CalendarEvent/set` (Task 4 view test).
- Calendar `mayRSVP` false: buttons disabled (Task 4).
- Copy deleted while card open: card turns to "missing" after the refetch (Task 4 wiring uses store `version`).

---

## File Structure

- Create `src/calendar/invite.ts` + `invite.test.ts`: pure helpers.
- Modify `src/jmap/types.ts`: `CALENDARS_PARSE`, `uid/sequence/status` already partly present, `Methods['CalendarEvent/parse']`.
- Modify `src/calendar/instances.ts` (+ test): `DisplayEvent.sequence/status`, base props, `cancelled` class.
- Modify `src/calendar/edit.ts` (+ test): cancelled is not editable.
- Modify `src/calendar/store.ts` (+ test): `version`, `parseInvite`, `findByUid`, `rsvp`.
- Modify `src/sync/fake-jmap.ts`: parse capability, `CalendarEvent/parse`, non-expanded query, `uid` on stored events.
- Create `src/ui/InviteCard.tsx` + `InviteCard.test.tsx`; modify `src/ui/Conversation.tsx`, `src/ui/styles.css`, `src/ui/CalendarView.tsx` (class wiring only if needed).
- Create `e2e/calendar-invite.spec.ts`; extend `e2e/support/calendar.ts`.
- Modify `docs/rozie-feedback.md` only if something is found.

---

### Task 0: Probe the two open questions

**Files:** none changed (findings go in the commit message of Task 1 and the plan notes below).

- [ ] **Step 1: Start the stack and probe.** Use the e2e support helpers (see `e2e/README.md` for how the local Stalwart is started). From a scratch script in the scratchpad dir, as alice after `createInvitedEvent`: (a) `Email/get` the invitation with `properties: ['attachments','textBody','htmlBody']` and check whether a `text/calendar` part is in `attachments`; (b) `CalendarEvent/query` with `filter: { after, before }` and NO `expandRecurrences`, check it returns base ids; (c) `CalendarEvent/query` with no filter, `limit: 2000`, check it works.
- [ ] **Step 2: Record results here.** If (a) is false (part is not in `attachments`), Task 1's `findInvitePart` must walk `bodyStructure` instead and `FULL_PROPS` in `src/sync/engine.ts:23` must add `bodyStructure`; adjust Task 1 and the fake accordingly. If (b) is false, `findByUid` drops the window step and always scans. Do not continue until both are known.

---

### Task 1: Pure invite helpers

**Files:**
- Create: `src/calendar/invite.ts`
- Test: `src/calendar/invite.test.ts`

**Interfaces:**
- Consumes: `Email`, `EmailBodyPart`, `CalendarEvent`, `CalendarParticipant` from `../jmap/types`.
- Produces:
  - `findInvitePart(email: Pick<Email,'attachments'>): { blobId: string } | null`
  - `type InviteState = { kind: 'active'; answer: ParticipationStatus; updated: boolean } | { kind: 'cancelled' } | { kind: 'missing' }`
  - `inviteState(parsed: { method?: string | null; sequence?: number }, copy: CalendarEvent | null, mine: { id: string; status: ParticipationStatus } | null): InviteState`
  - `myParticipant(copy: CalendarEvent, myAddresses: ReadonlySet<string>): { id: string; status: ParticipationStatus } | null`
  - `rsvpPatch(participantId: string, status: 'accepted' | 'tentative' | 'declined'): Record<string, string>`
  - `describeWhen(event: Pick<CalendarEvent,'start'|'timeZone'|'duration'|'showWithoutTime'>, viewerZone: string): string`
  - `type ParticipationStatus = NonNullable<CalendarParticipant['participationStatus']>`

(`now` from the spec's `inviteState` signature is dropped: nothing in the design needs it.)

- [ ] **Step 1: Write the failing tests** in `src/calendar/invite.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to confirm failure.** `npx vitest run src/calendar/invite.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/calendar/invite.ts`:

```ts
// Pure invitation logic: finding the calendar part, the card's state, and its time text. No Solid imports.
import type { CalendarEvent, CalendarParticipant, EmailBodyPart } from '../jmap/types';
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
```

- [ ] **Step 4: Run tests.** `npx vitest run src/calendar/invite.test.ts` → PASS. If a describeWhen expectation fails only on whitespace or dash characters, fix the implementation, not the test (the `flat` helper already normalises ICU spaces).
- [ ] **Step 5: Commit.**

```bash
git add src/calendar/invite.ts src/calendar/invite.test.ts
git commit -m "Calendar slice 3: pure invite helpers"
```

---

### Task 2: Cancelled events on the grid; DisplayEvent gains sequence and status

**Files:**
- Modify: `src/calendar/instances.ts` (`BASE_PROPS`, `DisplayEvent`, `toDisplayEvent`, `CalendarInput`, `toCalendarInput`)
- Modify: `src/calendar/edit.ts` (`editability`)
- Modify: `src/jmap/types.ts` (`CalendarEvent.sequence`, `.status`)
- Modify: `src/ui/styles.css`, `src/ui/CalendarView.tsx` (pass `classNames`)
- Test: `src/calendar/instances.test.ts`, `src/calendar/edit.test.ts`

**Interfaces:**
- Produces: `DisplayEvent.sequence: number`, `DisplayEvent.status: string | null`; `CalendarInput.classNames?: string[]` containing `'cancelled'` for cancelled events; `editability` returns `{ editable: false, reason: 'This event was cancelled.' }` for them (checked first).

- [ ] **Step 1: Failing tests.** In `edit.test.ts` add (reusing the file's existing event builder; read it first and follow its helper):

```ts
it('refuses a cancelled event first, whatever else is true', () => {
  expect(editability({ ...origin(), status: 'cancelled' }, writable)).toEqual({ editable: false, reason: 'This event was cancelled.' });
});
```

In `instances.test.ts` add:

```ts
it('carries sequence and status, and marks cancelled events for the grid', () => {
  const [ev] = toDisplayEvents(
    [{ id: 'o', baseEventId: 'b', start: '2026-10-05T09:00:00', utcStart: '2026-10-05T09:00:00Z' }],
    [{ id: 'b', title: 'X', start: '2026-10-05T09:00:00', timeZone: 'UTC', duration: 'PT1H', sequence: 3, status: 'cancelled' }],
  );
  expect(ev).toMatchObject({ sequence: 3, status: 'cancelled' });
  expect(toCalendarInput(ev!, {}, new Set())?.classNames).toEqual(['cancelled']);
});
it('has no class names for a live event', () => {
  const [ev] = toDisplayEvents([{ id: 'o', baseEventId: 'b', start: '2026-10-05T09:00:00', utcStart: '2026-10-05T09:00:00Z' }], [{ id: 'b', title: 'X', start: '2026-10-05T09:00:00', timeZone: 'UTC', duration: 'PT1H' }]);
  expect(toCalendarInput(ev!, {}, new Set())).not.toHaveProperty('classNames');
});
```

(Match the test file's existing import names; add `toCalendarInput` to its import if absent. If `origin()`/`writable` helpers have other names in `edit.test.ts`, use those.)

- [ ] **Step 2: Run** `npx vitest run src/calendar` → the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `types.ts` `CalendarEvent`: add `sequence?: number; status?: string | null;`.
  - `instances.ts`: add `'uid', 'sequence', 'status'` to `BASE_PROPS`; `DisplayEvent` gets `sequence: number; status: string | null;`; `common` gets `sequence: source.sequence ?? 0, status: source.status ?? null`; `CalendarInput` gets `classNames?: string[]`; `toCalendarInput` returns `...(ev.status === 'cancelled' ? { classNames: ['cancelled'] } : {})`.
  - `edit.ts` `editability`: first line `if (ev.status === 'cancelled') return { editable: false, reason: 'This event was cancelled.' };`
  - `CalendarView.tsx`: find where `CalendarInput` objects are passed to FullCalendar's `events` and confirm `classNames` passes through (FullCalendar's EventInput accepts `classNames`). If events are mapped field by field, add it. Read the file before editing.
  - `styles.css`: `.fc-event.cancelled { opacity: 0.5; text-decoration: line-through; cursor: default; }`
  - Fix every other place that constructs a `DisplayEvent` (typecheck will list them: tests, `EventForm`), adding `sequence: 0, status: null`.
- [ ] **Step 4: Verify.** `npx vitest run src/calendar && npx tsc -b` → PASS, no type errors.
- [ ] **Step 5: Commit.** `git commit -am "Calendar slice 3: cancelled events are muted and read-only; DisplayEvent carries sequence and status"`

---

### Task 3: Store: parseInvite, findByUid, rsvp (and the fake)

**Files:**
- Modify: `src/jmap/types.ts`, `src/sync/fake-jmap.ts`, `src/calendar/store.ts`
- Test: `src/calendar/store.test.ts`

**Interfaces:**
- Consumes: `rsvpPatch` from Task 1 (the UI passes the patch status; the store takes the status itself).
- Produces:
  - `CALENDARS_PARSE = 'urn:ietf:params:jmap:calendars:parse'` exported from `types.ts`.
  - `Methods['CalendarEvent/parse']: { args: { accountId: Id; blobIds: Id[] }; result: { accountId: Id; parsed: Record<Id, CalendarEvent[]> | null; notParsable: Id[] | null; notFound: Id[] | null } }`.
  - `CalendarStore.version: Accessor<number>` (bumped on every `refresh()`).
  - `CalendarStore.parseInvite(blobId: Id): Promise<{ ok: true; event: CalendarEvent } | { ok: false }>`
  - `CalendarStore.findByUid(uid: string, near?: string): Promise<CalendarEvent | null>`
  - `CalendarStore.rsvp(eventId: Id, participantId: string, status: 'accepted' | 'tentative' | 'declined'): Promise<WriteResult>`
- Fake additions: `parsedBlobs: Map<string, CalendarEvent[]>`; session capability `[CALENDARS_PARSE]: {}`; handler for `CalendarEvent/parse`; `CalendarEvent/query` with `expandRecurrences !== true` returns ids of `baseEvents` filtered by the window on `${start}Z` (all when no filter); `calendarQueries` already counted via `server.calls`.

- [ ] **Step 1: Failing tests** appended to `store.test.ts`:

```ts
describe('invitations', () => {
  const invite = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: 'x', uid: 'u1', method: 'request', sequence: 0, title: 'Review', ...over } as CalendarEvent);

  it('parses an invitation blob', async () => {
    const { server, store } = setup();
    server.parsedBlobs.set('blob1', [invite()]);
    expect(await store.parseInvite('blob1')).toEqual({ ok: true, event: expect.objectContaining({ uid: 'u1' }) });
  });
  it('fails softly when the blob is unparsable, empty, or the server lacks the capability', async () => {
    const { server, store } = setup();
    expect(await store.parseInvite('nope')).toEqual({ ok: false });
    server.parsedBlobs.set('empty', []);
    expect(await store.parseInvite('empty')).toEqual({ ok: false });
  });
  it('sends the parse capability in using', async () => {
    const { server, store } = setup();
    server.parsedBlobs.set('b', [invite()]);
    await store.parseInvite('b');
    expect(server.usings.at(-1)).toContain('urn:ietf:params:jmap:calendars:parse');
  });

  it('finds the copy by uid within the window, otherwise by scanning', async () => {
    const { server, store } = setup();
    server.baseEvents.set('b1', { ...server.baseEvents.get('b1')!, uid: 'u-near' });
    server.baseEvents.set('far', { id: 'far', uid: 'u-far', calendarIds: { c1: true }, title: 'Far', start: '2027-06-01T09:00:00', timeZone: 'UTC' });
    expect((await store.findByUid('u-near', '2026-10-05T09:00:00'))?.id).toBe('b1');
    expect((await store.findByUid('u-far', '2026-10-05T09:00:00'))?.id).toBe('far');
    expect(await store.findByUid('missing', '2026-10-05T09:00:00')).toBeNull();
  });
  it('caches a lookup until the store is refreshed', async () => {
    const { server, store } = setup();
    server.baseEvents.set('b1', { ...server.baseEvents.get('b1')!, uid: 'u1' });
    await store.findByUid('u1');
    const gets = () => server.calls.filter((c) => c === 'CalendarEvent/get').length;
    const before = gets();
    await store.findByUid('u1');
    expect(gets()).toBe(before);
    await store.refresh();
    const v = store.version();
    await store.findByUid('u1');
    expect(gets()).toBeGreaterThan(before);
    expect(v).toBeGreaterThan(0);
  });

  it('answers with scheduling messages on, patching only the participant status, and refetches', async () => {
    const { server, store } = setup();
    server.baseEvents.set('b1', { ...server.baseEvents.get('b1')!, participants: { a: { calendarAddress: 'mailto:alice@example.test', participationStatus: 'needs-action' } } });
    expect(await store.rsvp('b1', 'a', 'accepted')).toEqual({ ok: true });
    expect(server.calendarSets.at(-1)).toMatchObject({ sendSchedulingMessages: true, update: { b1: { 'participants/a/participationStatus': 'accepted' } } });
  });
  it('reports a refused answer', async () => {
    const { server, store } = setup();
    expect(await store.rsvp('gone', 'a', 'declined')).toEqual({ ok: false, error: 'That event no longer exists.' });
    server.failCalendarSets = true;
    expect((await store.rsvp('b1', 'a', 'declined')).ok).toBe(false);
  });
});
```

Note: the fake's `update` handler stores patch keys flat (`next[k] = v`), so the RSVP test asserts on `calendarSets`, not stored state. If Task 0 showed Stalwart behaves otherwise, mirror that in the fake.

- [ ] **Step 2: Run** `npx vitest run src/calendar/store.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - `types.ts`: export `CALENDARS_PARSE`; add `method?: string | null` to `CalendarEvent`; add the `'CalendarEvent/parse'` entry to `Methods`.
  - Fake: import `CALENDARS_PARSE`; add `parsedBlobs = new Map<string, CalendarEvent[]>()`; session `capabilities: { [CALENDARS_PARSE]: {} }`; in `handle`:

```ts
case 'CalendarEvent/parse': {
  const blobIds = (args.blobIds as string[]) ?? [];
  const parsed: Record<string, CalendarEvent[]> = {};
  const notFound: string[] = [];
  for (const id of blobIds) {
    const evs = this.parsedBlobs.get(id);
    if (evs) parsed[id] = structuredClone(evs);
    else notFound.push(id);
  }
  return [name, { accountId: 'a1', parsed, notParsable: null, notFound: notFound.length ? notFound : null }];
}
```

  and in `CalendarEvent/query`, before the existing return: when `args.expandRecurrences !== true`, `ids = [...this.baseEvents.values()].filter((e) => inWindow(`${e.start}Z`)).map((e) => e.id)` (same `f.after`/`f.before` comparison, string compare), respecting `args.limit` if set.
  - Store:

```ts
private readonly versionSignal = createSignal(0);
/** Bumps on every refresh: lets UI that holds a looked-up event re-read it. */
readonly version: Accessor<number> = this.versionSignal[0];
private byUid = new Map<string, Promise<CalendarEvent | null>>();
```

  `refresh()` additionally does `this.byUid.clear(); this.versionSignal[1]((v) => v + 1);` before fetching.

```ts
async parseInvite(blobId: Id): Promise<{ ok: true; event: CalendarEvent } | { ok: false }> {
  const accountId = this.accountId;
  if (!accountId || !this.client.session.capabilities[CALENDARS_PARSE]) return { ok: false };
  try {
    const b = this.client.batch();
    const call = b.call('CalendarEvent/parse', { accountId, blobIds: [blobId] });
    const res = (await this.client.send(b, [CORE, CALENDARS, CALENDARS_PARSE])).get(call);
    const event = res.parsed?.[blobId]?.[0];
    return event ? { ok: true, event } : { ok: false };
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    return { ok: false };
  }
}

/** The user's copy of an event, by uid (the server's uid filter matches nothing). Cached until the next refresh. */
findByUid(uid: string, near?: string): Promise<CalendarEvent | null> {
  let hit = this.byUid.get(uid);
  if (!hit) {
    hit = this.lookup(uid, near).catch((e) => {
      this.byUid.delete(uid);
      if (e instanceof UnauthorizedError) throw e;
      return null;
    });
    this.byUid.set(uid, hit);
  }
  return hit;
}

private async lookup(uid: string, near?: string): Promise<CalendarEvent | null> {
  const accountId = this.accountId;
  if (!accountId) return null;
  const find = async (filter?: { after: string; before: string }) => {
    const b = this.client.batch();
    const q = b.call('CalendarEvent/query', { accountId, ...(filter ? { filter } : { limit: SCAN_LIMIT }) });
    const g = b.call('CalendarEvent/get', { accountId, '#ids': q.ref('/ids'), properties: LOOKUP_PROPS });
    const res = await this.client.send(b, [CORE, CALENDARS]);
    res.get(q);
    return res.get(g).list.find((e) => e.uid === uid) ?? null;
  };
  if (near) {
    const t = Date.parse(`${near}Z`);
    if (!Number.isNaN(t)) {
      const found = await find({ after: toUtcDate(new Date(t - 7 * DAY_MS)), before: toUtcDate(new Date(t + 7 * DAY_MS)) });
      if (found) return found;
    }
  }
  return find();
}

rsvp(eventId: Id, participantId: string, status: 'accepted' | 'tentative' | 'declined'): Promise<WriteResult> {
  return this.updateEvent(eventId, rsvpPatch(participantId, status), true);
}
```

  with `const SCAN_LIMIT = 2000; const DAY_MS = 86_400_000; const LOOKUP_PROPS = ['id','uid','sequence','status','calendarIds','title','description','start','timeZone','duration','showWithoutTime','locations','participants','organizerCalendarAddress','recurrenceRule','isOrigin'];` Imports: `CALENDARS_PARSE`, `toUtcDate`, `rsvpPatch`. If Task 0 found that (b) fails, remove the windowed step.
- [ ] **Step 4: Verify.** `npx vitest run && npx tsc -b` → all PASS (existing calendar tests still pass with the changed fake query).
- [ ] **Step 5: Commit.** `git commit -am "Calendar slice 3: store parses invitations, finds the user's copy by uid, answers with scheduling messages"`

---

### Task 4: The card and its mount in the conversation

**Files:**
- Create: `src/ui/InviteCard.tsx`, `src/ui/InviteCard.test.tsx`
- Modify: `src/ui/Conversation.tsx` (mount in `Message`, above `<MessageBody>`), `src/ui/styles.css`

**Interfaces:**
- Consumes: `describeWhen`, `inviteState`, `myParticipant`, `findInvitePart`, `InviteState` (Task 1); store methods and `version` (Task 3); `STATUS_LABELS` from `src/calendar/format.ts`.
- Produces:
  - `InviteCardView(props: { title: string; when: string; where: string | null; repeats: boolean; organizer: string | null; guests: { name: string; status: string }[]; state: InviteState; note: string | null; canAnswer: boolean; busy: boolean; onAnswer: (s: 'accepted' | 'tentative' | 'declined') => void })`
  - `InviteCard(props: { email: EmailRec })`: returns nothing when there is no invite part, parse fails, or the method is not request/cancel.

View rules: the heading line says "Cancelled" for `cancelled`, "Updated since this message" when `state.updated`, and the note text (e.g. "This event isn't in your calendar", "You aren't listed as a guest") when given. Buttons (Accept, Maybe, Decline) render only for `active` and `canAnswer`; the one matching `state.answer` has `aria-pressed="true"` and the class `on`; all are `disabled` while `busy`.

- [ ] **Step 1: Failing component tests** in `InviteCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { InviteCardView } from './InviteCard';

const base = {
  title: 'Design review', when: 'Tue 8 Dec, 10:00–11:00 (Europe/London)', where: 'Room 4', repeats: false, organizer: 'Bob Example',
  guests: [{ name: 'Bob Example', status: 'accepted' }, { name: 'Alice', status: 'needs-action' }],
  state: { kind: 'active', answer: 'needs-action', updated: false } as const, note: null, canAnswer: true, busy: false, onAnswer: () => undefined,
};

describe('InviteCardView', () => {
  it('shows the details and three answer buttons', () => {
    render(() => <InviteCardView {...base} />);
    expect(screen.getByText('Design review')).toBeInTheDocument();
    expect(screen.getByText('Organizer: Bob Example')).toBeInTheDocument();
    for (const n of ['Accept', 'Maybe', 'Decline']) expect(screen.getByRole('button', { name: n })).toBeEnabled();
  });
  it('highlights the current answer and reports a click', () => {
    const onAnswer = vi.fn();
    render(() => <InviteCardView {...base} state={{ kind: 'active', answer: 'tentative', updated: false }} onAnswer={onAnswer} />);
    expect(screen.getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onAnswer).toHaveBeenCalledWith('accepted');
  });
  it('disables the buttons while a reply is in flight', () => {
    render(() => <InviteCardView {...base} busy />);
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
  });
  it('says the invitation was updated', () => {
    render(() => <InviteCardView {...base} state={{ kind: 'active', answer: 'accepted', updated: true }} />);
    expect(screen.getByText('Updated since this message')).toBeInTheDocument();
  });
  it('shows Cancelled with no buttons', () => {
    render(() => <InviteCardView {...base} state={{ kind: 'cancelled' }} />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
  it('shows the note and no buttons when the event is missing or the user is not a guest', () => {
    render(() => <InviteCardView {...base} state={{ kind: 'missing' }} note="This event isn't in your calendar" />);
    expect(screen.getByText("This event isn't in your calendar")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Maybe' })).toBeNull();
  });
  it('hides the buttons when the calendar does not allow answering', () => {
    render(() => <InviteCardView {...base} canAnswer={false} />);
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
  it('mentions repetition', () => {
    render(() => <InviteCardView {...base} repeats />);
    expect(screen.getByText('Repeats')).toBeInTheDocument();
  });
});
```

(Use the repo's jest-dom setup as in `ConfirmDialog.test.tsx`. The recurring note reads "Repeats" in a `<span>`; spec's "Repeats weekly" wording comes from the rule's frequency: derive `repeats` text in the wiring as "Repeats weekly"/"Repeats" and pass the string; adjust the prop to `repeats: string | null` and these tests to `repeats="Repeats weekly"` if you prefer. Keep view and test consistent.)

- [ ] **Step 2: Run** `npx vitest run src/ui/InviteCard.test.tsx` → FAIL.
- [ ] **Step 3: Implement `InviteCardView`** (plain markup: `<section class="invite-card" aria-label="Calendar invitation">`, heading row with state text, `<h3>` title, when/where/repeats/organizer lines, guest list `<li>`s as `name · STATUS_LABELS[status]`, note `<p>`, and a `<div class="invite-actions">` with `<button type="button" class="btn" classList={{ on }} aria-pressed disabled={busy}>`). Then the wiring:

```tsx
export function InviteCard(props: { email: EmailRec }) {
  const { calendar, engine, toast } = useApp();
  const part = () => findInvitePart(props.email);
  const [busy, setBusy] = createSignal(false);
  const [data] = createResource(
    () => { const p = part(); return p ? { blobId: p.blobId, v: calendar.version() } : null; },
    async ({ blobId }) => {
      const parsed = await calendar.parseInvite(blobId);
      if (!parsed.ok || !parsed.event.uid || !['request', 'cancel'].includes(parsed.event.method ?? '')) return null;
      const copy = await calendar.findByUid(parsed.event.uid, parsed.event.start);
      return { parsed: parsed.event, copy };
    },
  );
  // build view props from data(): event = copy ?? parsed; mine = copy && myParticipant(copy, engine.myAddresses());
  // note: missing → "This event isn't in your calendar"; copy && !mine && state.kind==='active' → "You aren't listed as a guest"
  // canAnswer: !!copy && !!mine && calendar rights of any of copy.calendarIds has myRights.mayRSVP === true
  // onAnswer: setBusy(true); const r = await calendar.rsvp(copy.id, mine.id, s); setBusy(false);
  //   r.ok ? toast(`Reply sent to ${organizerName}`) : toast(r.error, 'error')
  return <Show when={data()}>{(d) => <InviteCardView ... />}</Show>;
}
```

  Guard `onAnswer` with `if (busy()) return;` (double click). The organizer name is the participant with `roles.owner` (fall back to `organizerCalendarAddress` without `mailto:`). A `createResource` that throws (network) must not break the message: wrap the fetcher body in try/catch returning null.
  - `Conversation.tsx`: import `InviteCard`; inside `<div class="msg-body">` put `<InviteCard email={props.email} />` before `<MessageBody>`.
  - `styles.css`: card styles using existing tokens (`--border`, existing `.btn`); `.invite-card .on` filled variant. Keep it quiet, no new colors.
- [ ] **Step 4: Verify.** `npx vitest run && npx tsc -b && npm run build` → PASS. Then run the app against the fake or local stack and look at a message with an invite (use `/run` skill) to confirm the card renders and the mail still reads without it.
- [ ] **Step 5: Commit.** `git add -A src/ui && git commit -m "Calendar slice 3: invite card on messages with a calendar invitation"`

---

### Task 5: e2e against real Stalwart, docs, finish

**Files:**
- Create: `e2e/calendar-invite.spec.ts`
- Modify: `e2e/support/calendar.ts` (helpers `bobUpdateEvent(bobEventId, patch)`, `bobCancelEvent(bobEventId)`; make `createInvitedEvent` also return the bob event id, e.g. return `{ cleanup, bobEventId }` and update its existing caller in `calendar-edit.spec.ts`)
- Modify: `docs/superpowers/specs/2026-10-07-calendar-slice3-design.md` ("Not probed" bullet: record Task 0 results)

**Interfaces:** consumes the Playwright helpers `waitLive`, `createInvitedEvent`, `destroyE2eEvents`, `bobMailAbout`, `destroyBobMailAbout`.

- [ ] **Step 1: Write the spec** following `calendar-edit.spec.ts` style. Title via `E2E ${Date.now()}` prefix so cleanup finds it. Flow, as one test:
  1. `createInvitedEvent(title, '<today>T17:00:00', 'Europe/London')`.
  2. Open the inbox, open the thread whose subject contains the title; expect `.invite-card` with the title, "Organizer", and buttons.
  3. Click Accept; expect the toast "Reply sent to" and `aria-pressed="true"` on Accept; poll `bobMailAbout('Accepted')` filtered by the title contains `Accepted: <title>` (follow the helper's fuzzy-match note) and Bob's calendar copy shows alice `accepted` (add a small helper reading bob's event participants).
  4. `bobUpdateEvent` changes `start` +1h; expect the old email's card to show "Updated since this message" (reopen the thread or wait for push) and the new time text.
  5. `bobCancelEvent`; expect "Cancelled", no Accept button, and on `/calendar` the event has class `cancelled` (`.fc-event.cancelled`).
  6. `afterEach`: the cleanup returned by the helper, `destroyBobMailAbout(title)`, `destroyE2eEvents`.
- [ ] **Step 2: Run** `npx playwright test e2e/calendar-invite.spec.ts` (stack per `e2e/README.md`) → PASS; run the whole `npm run e2e` to confirm `calendar-edit.spec.ts` still passes after the helper signature change.
- [ ] **Step 3: Final checks.** `npx vitest run && npx tsc -b && npm run build`. Record anything rozie-related in `docs/rozie-feedback.md` (expected: nothing).
- [ ] **Step 4: Update memory pointer** (`oinbox-pilot-slices.md`): slice 3 done, slice 4 next. Update the spec's "Not probed" bullet with Task 0 results.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Calendar slice 3: e2e for answering, updating and cancelling an invitation"`

---

## Self-review notes

- Spec coverage: parts detection and helpers (T1), cancelled grid (T2), store + fake (T3), card, errors table rows (parse failure, missing, not a guest, refused RSVP, deleted-while-open via `version`, double click) (T4), e2e flow incl. Bob's "Accepted:" email and struck-through grid (T5), rozie note (T5). Two open questions probed first (T0).
- Deviations from the spec text: `inviteState` takes the participant and drops `now`; it returns `{kind:'active', answer, updated}` instead of separate pending/answered/updated kinds, so an updated invitation still shows the user's answer.
