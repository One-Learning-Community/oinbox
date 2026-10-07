// Calendar helpers for specs: JMAP Calendars over Basic auth against the dev stack.
import { ALICE, BASE, BOB, PASSWORD, accountId, jmap } from './mail';

export const CAL_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];

async function calendarAccount(user = ALICE): Promise<string> {
  const res = await fetch(`${BASE}/jmap/session`, { headers: { authorization: 'Basic ' + Buffer.from(`${user}:${PASSWORD}`).toString('base64') } });
  const s = (await res.json()) as { primaryAccounts: Record<string, string> };
  return s.primaryAccounts['urn:ietf:params:jmap:calendars']!;
}

async function defaultCalendar(accountId: string, user = ALICE): Promise<string> {
  const r = await jmap([['Calendar/get', { accountId }, 'c']], user, CAL_USING);
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

const E2E_PREFIX = 'E2E ';

export interface StoredEvent {
  id: string;
  title: string;
  start: string;
  duration: string;
  timeZone: string | null;
  showWithoutTime?: boolean;
  calendarIds: Record<string, boolean>;
}

/** Alice's events with exactly this title, in any calendar. */
export async function eventsByTitle(title: string): Promise<StoredEvent[]> {
  const account = await calendarAccount();
  const r = await jmap(
    [
      ['CalendarEvent/query', { accountId: account }, 'q'],
      ['CalendarEvent/get', { accountId: account, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['id', 'title', 'start', 'duration', 'timeZone', 'showWithoutTime', 'calendarIds'] }, 'g'],
    ],
    ALICE,
    CAL_USING,
  );
  return (r.g.list as StoredEvent[]).filter((e) => e.title === title);
}

/** Delete every event of alice's whose title starts with "E2E " (no guests are emailed). */
export async function destroyE2eEvents(): Promise<void> {
  const account = await calendarAccount();
  const r = await jmap(
    [
      ['CalendarEvent/query', { accountId: account }, 'q'],
      ['CalendarEvent/get', { accountId: account, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['id', 'title'] }, 'g'],
    ],
    ALICE,
    CAL_USING,
  );
  const ids = (r.g.list as { id: string; title?: string }[]).filter((e) => e.title?.startsWith(E2E_PREFIX)).map((e) => e.id);
  if (ids.length) await jmap([['CalendarEvent/set', { accountId: account, sendSchedulingMessages: false, destroy: ids }, 'd']], ALICE, CAL_USING);
}

/** bob organises an event and invites alice. The invitation email is sent: that is how it reaches alice's calendar. Returns bob's event id and the cleanup. */
export async function createInvitedEvent(title: string, start: string, timeZone: string): Promise<{ cleanup: () => Promise<void>; bobEventId: string }> {
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
  const cleanup = async () => {
    // A test may have cancelled the event already.
    await jmap([['CalendarEvent/set', { accountId: bobAccount, sendSchedulingMessages: false, destroy: [bobEventId] }, 'd']], BOB, CAL_USING).catch(() => undefined);
    await destroyE2eEvents();
    const mail = await accountId();
    const found = await jmap([['Email/query', { accountId: mail, filter: { subject: title } }, 'q']], ALICE);
    const ids = found.q.ids as string[];
    if (ids.length) await jmap([['Email/set', { accountId: mail, destroy: ids }, 'd']], ALICE);
  };
  return { cleanup, bobEventId };
}

/** An event alice organises with bob as a guest. Nothing is emailed or delivered (scheduling messages off). */
export async function createGuestEvent(title: string, start: string, timeZone: string): Promise<string> {
  const account = await calendarAccount();
  const calendarId = await defaultCalendar(account);
  const r = await jmap(
    [['CalendarEvent/set', { accountId: account, sendSchedulingMessages: false, create: { x: {
      calendarIds: { [calendarId]: true }, title, start, timeZone, duration: 'PT1H', organizerCalendarAddress: `mailto:${ALICE}`,
      participants: {
        a: { calendarAddress: `mailto:${ALICE}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
        b: { calendarAddress: `mailto:${BOB}`, roles: { attendee: true }, participationStatus: 'needs-action' },
      },
    } } }, 's']],
    ALICE,
    CAL_USING,
  );
  return r.s.created.x.id as string;
}

/** Subjects of bob's messages that mention this text. */
export async function bobMailAbout(text: string): Promise<string[]> {
  const mail = await accountId(BOB);
  const r = await jmap(
    [
      ['Email/query', { accountId: mail, filter: { text } }, 'q'],
      ['Email/get', { accountId: mail, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g'],
    ],
    BOB,
  );
  // Full-text search is fuzzy ("E2E 1" matches "E2E 2"), so keep only exact mentions.
  return (r.g.list as { subject: string }[]).map((e) => e.subject).filter((subject) => subject.includes(text));
}

export async function destroyBobMailAbout(text: string): Promise<void> {
  const mail = await accountId(BOB);
  const r = await jmap([['Email/query', { accountId: mail, filter: { text } }, 'q']], BOB);
  const ids = r.q.ids as string[];
  if (ids.length) await jmap([['Email/set', { accountId: mail, destroy: ids }, 'd']], BOB);
}

/** Change an event of alice's behind the app's back (no scheduling messages). */
export async function patchEvent(id: string, patch: Record<string, unknown>): Promise<void> {
  const account = await calendarAccount();
  await jmap([['CalendarEvent/set', { accountId: account, sendSchedulingMessages: false, update: { [id]: patch } }, 'u']], ALICE, CAL_USING);
}

export async function calendarIdByName(name: string): Promise<string> {
  const account = await calendarAccount();
  const r = await jmap([['Calendar/get', { accountId: account }, 'c']], ALICE, CAL_USING);
  return (r.c.list as { id: string; name: string }[]).find((c) => c.name === name)!.id;
}

/** Bob (the organiser) changes his copy; the update is emailed to alice. */
export async function bobUpdateEvent(bobEventId: string, patch: Record<string, unknown>): Promise<void> {
  const account = await calendarAccount(BOB);
  await jmap([['CalendarEvent/set', { accountId: account, sendSchedulingMessages: true, update: { [bobEventId]: patch } }, 'u']], BOB, CAL_USING);
}

/** Bob deletes his event; alice is emailed a cancellation. */
export async function bobCancelEvent(bobEventId: string): Promise<void> {
  const account = await calendarAccount(BOB);
  await jmap([['CalendarEvent/set', { accountId: account, sendSchedulingMessages: true, destroy: [bobEventId] }, 'd']], BOB, CAL_USING);
}

/** The participation statuses on bob's copy, keyed by lower-case address. */
export async function bobSeesStatuses(bobEventId: string): Promise<Record<string, string>> {
  const account = await calendarAccount(BOB);
  const r = await jmap([['CalendarEvent/get', { accountId: account, ids: [bobEventId], properties: ['participants'] }, 'g']], BOB, CAL_USING);
  const ps = (r.g.list[0]?.participants ?? {}) as Record<string, { calendarAddress: string; participationStatus: string }>;
  return Object.fromEntries(Object.values(ps).map((p) => [p.calendarAddress.replace(/^mailto:/i, '').toLowerCase(), p.participationStatus]));
}
