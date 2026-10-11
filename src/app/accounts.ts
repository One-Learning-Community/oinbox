import { createMemo, createSignal, type Accessor } from 'solid-js';
import { MethodError } from '../jmap/client';
import { MAIL, type Id, type Session } from '../jmap/types';
import type { MailEngine } from '../sync/engine';
import type { Nav } from '../ui/nav';
import type { Actions } from './actions';
import type { Composers } from './composer';
import type { Labels } from './labels';
import type { Recipients } from './recipients';
import type { Settings } from './settings';

/** A mail account the signed-in user may open: their own, or a shared one (a Stalwart group). */
export interface AccountInfo {
  id: Id;
  address: string;
  personal: boolean;
  /** "You", or the shared mailbox's name: "Support" for support@example.test. */
  label: string;
  /** What its addresses start with: '' for the user's own, /shared/<id> otherwise. */
  base: string;
}

const labelOf = (name: string): string => {
  const local = name.split('@')[0] || name;
  return local.charAt(0).toUpperCase() + local.slice(1);
};

/** The user's own account first, then the shared ones by label. */
export function mailAccounts(session: Session, except: ReadonlySet<Id> = new Set()): AccountInfo[] {
  const own = session.primaryAccounts[MAIL];
  return Object.entries(session.accounts)
    .filter(([id, a]) => a.accountCapabilities?.[MAIL] && (id === own || !except.has(id)))
    .map(([id, a]) => {
      const personal = id === own;
      return { id, address: a.name, personal, label: personal ? 'You' : labelOf(a.name), base: personal ? '' : `/shared/${encodeURIComponent(id)}` };
    })
    .sort((x, y) => Number(y.personal) - Number(x.personal) || x.label.localeCompare(y.label));
}

/** The account an address belongs to. An unknown or lost shared account is the user's own. */
export function accountForPath(pathname: string, accounts: AccountInfo[]): AccountInfo {
  return accounts.find((a) => a.base && (pathname === a.base || pathname.startsWith(`${a.base}/`))) ?? accounts[0]!;
}

/**
 * Where to go instead of `pathname`, or null when it is fine: a /shared/ address for an account the
 * user can no longer open (left the group, an old bookmark) has no route in their own mailbox.
 */
export function homePath(pathname: string, accounts: AccountInfo[]): string | null {
  const shared = pathname === '/shared' || pathname.startsWith('/shared/');
  return shared && !accountForPath(pathname, accounts).base ? '/inbox' : null;
}

export function withinAccount(pathname: string, account: AccountInfo): string {
  if (!account.base) return pathname;
  return pathname.slice(account.base.length) || '/';
}

/** Everything that belongs to one mail account: its engine and what hangs off it. */
export interface AccountSpace {
  info: AccountInfo;
  engine: MailEngine;
  actions: Actions;
  labels: Labels;
  settings: Settings;
  composers: Composers;
  recipients: Recipients;
  nav: Nav;
}

export interface Spaces {
  list: Accessor<AccountSpace[]>;
  /** The account on screen. */
  current: Accessor<AccountSpace>;
  /** Unread Inbox conversations of one space. */
  unread: (space: AccountSpace) => number;
  totalUnread: Accessor<number>;
  /** Change which space is on screen; the caller sees to the address. */
  show: (id: Id) => void;
  /** Take a shared account out of the list: it turned out not to be a mailbox. */
  hide: (id: Id) => void;
}

export function createSpaces(accounts: AccountInfo[], build: (info: AccountInfo) => Omit<AccountSpace, 'info'>, initial: Id): Spaces {
  const built = accounts.map((info) => ({ info, ...build(info) }));
  const [hidden, setHidden] = createSignal<ReadonlySet<Id>>(new Set());
  const spaces = createMemo(() => built.filter((s) => !hidden().has(s.info.id)));
  const [currentId, setCurrentId] = createSignal(built.some((s) => s.info.id === initial) ? initial : built[0]!.info.id);
  const unread = (space: AccountSpace) => Object.values(space.engine.state.mailboxes).find((m) => m.role === 'inbox')?.unreadThreads ?? 0;
  return {
    list: spaces,
    current: createMemo(() => spaces().find((s) => s.info.id === currentId()) ?? built[0]!),
    unread,
    totalUnread: createMemo(() => spaces().reduce((n, s) => n + unread(s), 0)),
    show: (id) => {
      if (spaces().some((s) => s.info.id === id)) setCurrentId(id);
    },
    hide: (id) => {
      const space = built.find((s) => s.info.id === id);
      if (!space || space.info.personal) return;
      setHidden(new Set(hidden()).add(id));
    },
  };
}

/** The key one account's snapshot and recipient cache are stored under in the browser. */
export const storageKey = (username: string, account: AccountInfo): string => `${username}:${account.id}`;

/**
 * Start every account's engine. The user's own must start; a shared mailbox that cannot (rights
 * taken away, a membership ended a moment ago) is reported and left behind, not allowed to stop the rest.
 */
export async function startAll(spaces: AccountSpace[], onFailed: (space: AccountSpace, error: unknown) => void): Promise<void> {
  const results = await Promise.allSettled(spaces.map((s) => s.engine.start()));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') return;
    if (spaces[i]!.info.personal) throw r.reason;
    onFailed(spaces[i]!, r.reason);
  });
}

/**
 * Whether a shared account failed to start because it is no mailbox at all. Someone who shares only
 * an address book or a calendar appears in the session as an account that lists the mail capability
 * (Stalwart lists every capability for every account) and then refuses every mail method.
 */
export function isNotAMailbox(e: unknown): boolean {
  return e instanceof MethodError && e.type === 'forbidden';
}

type Kept = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const notMailboxesKey = (username: string) => `oinbox.notMailboxes:${username}`;

/** The shared accounts found, on an earlier visit, to be no mailboxes: they are not offered again, even for a moment. */
export function notMailboxes(storage: Kept, username: string): Set<Id> {
  try {
    const ids: unknown = JSON.parse(storage.getItem(notMailboxesKey(username)) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id): id is Id => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function rememberNotMailboxes(storage: Kept, username: string, ids: ReadonlySet<Id>): void {
  try {
    if (ids.size) storage.setItem(notMailboxesKey(username), JSON.stringify([...ids]));
    else storage.removeItem(notMailboxesKey(username));
  } catch {
    // Storage that cannot be written costs a flash of the account on the next start, nothing more.
  }
}

/** Accounts the app was built with (from the remembered session) that the server no longer offers. */
export function lostAccounts(before: AccountInfo[], now: Session, except: ReadonlySet<Id> = new Set()): AccountInfo[] {
  const ids = new Set(mailAccounts(now, except).map((a) => a.id));
  return before.filter((a) => !ids.has(a.id));
}
