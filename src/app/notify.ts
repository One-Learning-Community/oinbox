import { createSignal } from 'solid-js';
import type { Email, Id } from '../jmap/types';

/** The part of the browser's Notification that oinbox uses, so tests can stand in for it. */
export interface NotificationApi {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  show(title: string, options: { body: string; tag: string }): { onclick: (() => void) | null };
}

/** The browser's own, or undefined where there is none (Safari on an iPhone outside a home-screen app). */
export function browserNotifications(): NotificationApi | undefined {
  if (typeof Notification === 'undefined') return undefined;
  return {
    get permission() {
      return Notification.permission;
    },
    requestPermission: () => Notification.requestPermission(),
    show: (title, options) => new Notification(title, options) as unknown as { onclick: (() => void) | null },
  };
}

export const tabTitle = (unread: number, name: string): string => `${unread > 0 ? `(${unread}) ` : ''}Inbox – ${name}`;

/** Of the mail that just arrived, what is worth a notification: unread, in the Inbox, not a draft. */
export const newInboxMail = (emails: Email[], inboxId: Id | undefined): Email[] =>
  inboxId ? emails.filter((e) => e.mailboxIds?.[inboxId] && !e.keywords?.$seen && !e.keywords?.$draft) : [];

const sender = (e: Email): string => e.from?.[0]?.name || e.from?.[0]?.email || 'Unknown sender';

export interface NotificationText {
  title: string;
  body: string;
  /** Where a click goes. */
  path: string;
  /** One notification per conversation; a later one with the same tag replaces it. */
  tag: string;
}

export function notificationFor(emails: Email[]): NotificationText {
  if (emails.length === 1) {
    const e = emails[0]!;
    return { title: sender(e), body: e.subject || '(no subject)', path: `/inbox/t/${e.threadId}`, tag: `oinbox-${e.threadId}` };
  }
  const senders = [...new Set(emails.map(sender))];
  const named = senders.slice(0, 3).join(', ') + (senders.length > 3 ? ` and ${senders.length - 3} more` : '');
  return { title: `${emails.length} new messages`, body: named, path: '/inbox', tag: 'oinbox-new' };
}

const KEY = 'oinbox.notify';

/** Whether this browser should show desktop notifications. Kept per browser: permission is per browser too. */
export function createNotifyPrefs(storage: Storage, api: NotificationApi | undefined) {
  const [wanted, setWanted] = createSignal(storage.getItem(KEY) === '1');
  const [permission, setPermission] = createSignal<NotificationPermission>(api?.permission ?? 'denied');
  return {
    supported: !!api,
    /** On, and the browser still allows it. */
    enabled: () => wanted() && permission() === 'granted',
    /** The browser refuses, so the switch cannot be turned on from here. */
    blocked: () => !!api && permission() === 'denied',
    /** Must be called from a click: browsers only ask for permission in answer to one. */
    async setEnabled(on: boolean): Promise<boolean> {
      if (on && api) setPermission(api.permission === 'granted' ? 'granted' : await api.requestPermission());
      const ok = on && !!api && permission() === 'granted';
      setWanted(ok);
      if (ok) storage.setItem(KEY, '1');
      else storage.removeItem(KEY);
      return ok;
    },
  };
}
export type NotifyPrefs = ReturnType<typeof createNotifyPrefs>;

/** Returns what to call with newly arrived mail. */
export function createNotifier(deps: {
  api: NotificationApi | undefined;
  enabled: () => boolean;
  /** The user is not looking at oinbox: the tab is hidden or the window is not in front. */
  away: () => boolean;
  inboxId: () => Id | undefined;
  open: (path: string) => void;
}) {
  return (arrived: Email[]): void => {
    if (!deps.api || !deps.enabled() || !deps.away()) return;
    const fresh = newInboxMail(arrived, deps.inboxId());
    if (!fresh.length) return;
    const text = notificationFor(fresh);
    const shown = deps.api.show(text.title, { body: text.body, tag: text.tag });
    shown.onclick = () => deps.open(text.path);
  };
}

const api = browserNotifications();
/** This browser's notifications and the user's choice, for the app. */
export const notifications = { api, prefs: createNotifyPrefs(localStorage, api) };
