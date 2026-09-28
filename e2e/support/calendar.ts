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
