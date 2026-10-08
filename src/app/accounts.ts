import { createMemo, createSignal, type Accessor } from 'solid-js';
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
export function mailAccounts(session: Session): AccountInfo[] {
  const own = session.primaryAccounts[MAIL];
  return Object.entries(session.accounts)
    .filter(([, a]) => a.accountCapabilities?.[MAIL])
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
}

export function createSpaces(accounts: AccountInfo[], build: (info: AccountInfo) => Omit<AccountSpace, 'info'>, initial: Id): Spaces {
  const spaces = accounts.map((info) => ({ info, ...build(info) }));
  const [currentId, setCurrentId] = createSignal(spaces.some((s) => s.info.id === initial) ? initial : spaces[0]!.info.id);
  const unread = (space: AccountSpace) => Object.values(space.engine.state.mailboxes).find((m) => m.role === 'inbox')?.unreadThreads ?? 0;
  return {
    list: () => spaces,
    current: createMemo(() => spaces.find((s) => s.info.id === currentId())!),
    unread,
    totalUnread: createMemo(() => spaces.reduce((n, s) => n + unread(s), 0)),
    show: (id) => {
      if (spaces.some((s) => s.info.id === id)) setCurrentId(id);
    },
  };
}

/** The key one account's snapshot and recipient cache are stored under in the browser. */
export const storageKey = (username: string, account: AccountInfo): string => `${username}:${account.id}`;
