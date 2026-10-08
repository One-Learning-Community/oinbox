import { beforeEach, describe, expect, it } from 'vitest';
import type { Email } from '../jmap/types';
import { createNotifier, createNotifyPrefs, newInboxMail, notificationFor, tabTitle, type NotificationApi } from './notify';

const mail = (id: string, over: Partial<Email> = {}): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { I: true },
    keywords: {},
    from: [{ name: 'Bob Builder', email: 'bob@example.test' }],
    subject: `Subject ${id}`,
    ...over,
  }) as Email;

/** A browser's Notification, as far as oinbox uses it. */
function fakeApi(permission: NotificationPermission, answer: NotificationPermission = permission) {
  const shown: { title: string; body?: string; tag?: string; onclick: (() => void) | null }[] = [];
  const api: NotificationApi & { asked: number } = {
    asked: 0,
    permission,
    requestPermission: () => {
      api.asked++;
      api.permission = answer;
      return Promise.resolve(answer);
    },
    show: (title, options) => {
      const n = { title, ...options, onclick: null as (() => void) | null };
      shown.push(n);
      return n;
    },
  };
  return { api, shown };
}

beforeEach(() => localStorage.clear());

describe('tabTitle', () => {
  it('leads with the unread count when there is one', () => {
    expect(tabTitle(3, 'Acme Mail')).toBe('(3) Inbox – Acme Mail');
    expect(tabTitle(0, 'Acme Mail')).toBe('Inbox – Acme Mail');
  });
});

describe('newInboxMail', () => {
  it('keeps unread mail that arrived in the Inbox', () => {
    const got = newInboxMail([mail('a'), mail('b', { mailboxIds: { S: true } }), mail('c', { keywords: { $seen: true } }), mail('d', { keywords: { $draft: true } })], 'I');
    expect(got.map((e) => e.id)).toEqual(['a']);
  });
  it('is nothing before the Inbox is known', () => {
    expect(newInboxMail([mail('a')], undefined)).toEqual([]);
  });
});

describe('notificationFor', () => {
  it('names the sender and the subject of one message, and opens its conversation', () => {
    expect(notificationFor([mail('a')])).toEqual({ title: 'Bob Builder', body: 'Subject a', path: '/inbox/t/t-a', tag: 'oinbox-t-a' });
  });
  it('falls back to the address, and says so when there is no subject', () => {
    expect(notificationFor([mail('a', { from: [{ name: null, email: 'bob@example.test' }], subject: '' })])).toMatchObject({ title: 'bob@example.test', body: '(no subject)' });
  });
  it('collapses several into one, naming who they are from', () => {
    const many = [mail('a'), mail('b'), mail('c', { from: [{ name: 'Erin', email: 'erin@example.test' }] })];
    expect(notificationFor(many)).toEqual({ title: '3 new messages', body: 'Bob Builder, Erin', path: '/inbox', tag: 'oinbox-new' });
  });
});

const support = { id: 'g', address: 'support@example.test', personal: false, label: 'Support', base: '/shared/g' };

describe('notificationFor a shared account', () => {
  it('leads with the mailbox and opens the conversation there', () => {
    expect(notificationFor([mail('a')], support)).toEqual({ title: 'Support: Bob Builder', body: 'Subject a', path: '/shared/g/inbox/t/t-a', tag: 'oinbox-g-t-a' });
  });
  it('counts several under the mailbox', () => {
    expect(notificationFor([mail('a'), mail('b')], support)).toMatchObject({ title: 'Support: 2 new messages', path: '/shared/g/inbox', tag: 'oinbox-g-new' });
  });
  it("is unchanged for the user's own account", () => {
    const own = { id: 'b', address: 'alice@example.test', personal: true, label: 'You', base: '' };
    expect(notificationFor([mail('a')], own)).toEqual(notificationFor([mail('a')]));
  });
});

describe('createNotifyPrefs', () => {
  it('is off until switched on, and asks the browser when it is', async () => {
    const { api } = fakeApi('default', 'granted');
    const prefs = createNotifyPrefs(localStorage, api);
    expect(prefs.enabled()).toBe(false);
    expect(await prefs.setEnabled(true)).toBe(true);
    expect(api.asked).toBe(1);
    expect(prefs.enabled()).toBe(true);
    // The choice outlives the page.
    expect(createNotifyPrefs(localStorage, api).enabled()).toBe(true);
  });
  it('stays off and says it is blocked when the browser refuses', async () => {
    const { api } = fakeApi('default', 'denied');
    const prefs = createNotifyPrefs(localStorage, api);
    expect(await prefs.setEnabled(true)).toBe(false);
    expect(prefs.enabled()).toBe(false);
    expect(prefs.blocked()).toBe(true);
  });
  it('counts as off when permission was taken away after it was switched on', async () => {
    const { api } = fakeApi('granted');
    await createNotifyPrefs(localStorage, api).setEnabled(true);
    const later = createNotifyPrefs(localStorage, fakeApi('denied').api);
    expect(later.enabled()).toBe(false);
  });
  it('switches off without asking anything', async () => {
    const { api } = fakeApi('granted');
    const prefs = createNotifyPrefs(localStorage, api);
    await prefs.setEnabled(true);
    await prefs.setEnabled(false);
    expect(prefs.enabled()).toBe(false);
    expect(createNotifyPrefs(localStorage, api).enabled()).toBe(false);
  });
  it('is unsupported, and off, in a browser with no notifications', async () => {
    const prefs = createNotifyPrefs(localStorage, undefined);
    expect(prefs.supported).toBe(false);
    expect(await prefs.setEnabled(true)).toBe(false);
    expect(prefs.enabled()).toBe(false);
  });
});

describe('createNotifier', () => {
  const setup = (opts: { away: boolean; enabled: boolean }) => {
    const { api, shown } = fakeApi('granted');
    const opened: string[] = [];
    const notify = createNotifier({ api, enabled: () => opts.enabled, away: () => opts.away, inboxId: () => 'I', open: (p) => opened.push(p) });
    return { notify, shown, opened };
  };

  it('shows new Inbox mail while the user is away', () => {
    const { notify, shown } = setup({ away: true, enabled: true });
    notify([mail('a'), mail('b', { mailboxIds: { S: true } })]);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'Bob Builder', body: 'Subject a', tag: 'oinbox-t-a' });
  });
  it('says nothing while the user is looking at oinbox', () => {
    const { notify, shown } = setup({ away: false, enabled: true });
    notify([mail('a')]);
    expect(shown).toEqual([]);
  });
  it('says nothing when switched off', () => {
    const { notify, shown } = setup({ away: true, enabled: false });
    notify([mail('a')]);
    expect(shown).toEqual([]);
  });
  it('says nothing when none of the mail is for the Inbox', () => {
    const { notify, shown } = setup({ away: true, enabled: true });
    notify([mail('a', { keywords: { $seen: true } })]);
    expect(shown).toEqual([]);
  });
  it("opens a shared account's conversation under its base", () => {
    const { api, shown } = fakeApi('granted');
    const opened: string[] = [];
    const notify = createNotifier({ api, enabled: () => true, away: () => true, inboxId: () => 'I', open: (p) => opened.push(p), account: () => support });
    notify([mail('a')]);
    expect(shown[0]!.title).toBe('Support: Bob Builder');
    shown[0]!.onclick!();
    expect(opened).toEqual(['/shared/g/inbox/t/t-a']);
  });
  it('opens the conversation when the notification is clicked', () => {
    const { notify, shown, opened } = setup({ away: true, enabled: true });
    notify([mail('a')]);
    shown[0]!.onclick!();
    expect(opened).toEqual(['/inbox/t/t-a']);
  });
});
