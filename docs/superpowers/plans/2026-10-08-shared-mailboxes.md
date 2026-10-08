# Shared Mailboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member of a Stalwart group account can switch to that shared mailbox in oinbox, work it like their own, send from it, and see from anywhere that another mailbox has unread mail.

**Architecture:** One `JmapClient` and one push stream per sign-in; one `MailEngine` (with its actions, labels, settings, composers, recipients and nav) per mail account in the session, bundled as an "account space". One space is on screen; switching re-mounts the router with a base path (`/shared/<accountId>`), so components keep capturing `useApp()` once, as today.

**Tech Stack:** SolidJS 1.9, @solidjs/router 1.0 (`<Router base>`), Vitest + jsdom, Playwright, Stalwart 0.16.23.

**Spec:** `docs/superpowers/specs/2026-10-08-shared-mailboxes-design.md`

## Global Constraints

- The user's own account keeps today's URLs; a shared account lives under `/shared/<accountId>/…`.
- With one mail account in the session, nothing on screen changes (no switcher).
- `JmapClient.accountId` keeps meaning "the user's own account".
- Calendar is personal only: no Calendar link while a shared account is open.
- Tab title counts unread Inbox conversations across all accounts: `(5) Inbox – <brand name>`.
- Notification for a shared account leads with its label: `Support: Nora Notifier`; several: `Support: 3 new messages`.
- Account label: `You` for the personal account; for a shared one the local part of its address, first letter capitalised (`support@example.test` → `Support`).
- Browser storage keys per account: snapshot and recipients use the key `<username>:<accountId>`; signing out clears every account's.
- Nothing is sent anywhere but Stalwart; no new dependencies.
- Commit after every task, message prefix `Shared mailboxes:`, with the session's attribution lines.

## Review Focus

1. **A `/shared/<id>` address whose account is no longer in the session** (membership removed, stale bookmark): the user expects their own inbox, not a blank page or an error. Pinned in Task 2 (`accountForPath` falls back) and Task 6 (e2e).
2. **Switching account with a composer open and unsaved text**: the text must be there on return. Pinned in Task 6 (e2e).
3. **A push change for account A while account B is on screen**: A's unread count must update and B's lists must not refetch. Pinned in Task 1 (engine test) and Task 6 (e2e dot).
4. **An attachment downloaded or uploaded in a shared account** must use that account's id in the URL, or Stalwart answers 404/403. Pinned in Task 1 (client test).
5. **An involuntary sign-out with drafts open in two accounts**: both are rescued and both come back. Pinned in Task 4 (unit test on `rescueAll`/`restoreAll`).

## File Structure

| File | Responsibility |
|---|---|
| `src/jmap/client.ts` (modify) | `upload`, `downloadUrl`, `fetchBlob` take an optional account id. |
| `src/sync/engine.ts` (modify) | `accountId` option; `downloadUrl`/`upload` pass-throughs so callers need not know the account. |
| `src/mail/labels.ts` (modify) | `labelLimits(session, accountId?)`. |
| `src/sync/fake-jmap.ts` (modify) | `accountId` field; `fakeClient(fakes)` serving several accounts from one session. |
| `src/app/accounts.ts` (create) | Pure: which accounts, their labels, base paths, path → account. Plus `createSpaces` (the per-account bundle and the current-space signal). |
| `src/app/notify.ts` (modify) | Account label in notification text; click path under the account's base. |
| `src/app/context.tsx` (modify) | `App` gains `spaces`. |
| `src/index.tsx` (modify) | Build spaces, fan push out, per-account snapshots and rescue, keyed router with base. |
| `src/ui/AccountSwitcher.tsx` (create) | The switcher menu. |
| `src/ui/Shell.tsx` (modify) | Switcher above Compose; total unread in the title; no Calendar link in a shared account. |
| `deploy/stalwart/groups.ndjson`, `deploy/seed.sh`, `deploy/seed/seed_mail.py` (modify/create) | `support` group, members, three seeded messages. |
| `e2e/shared.spec.ts` (create), `e2e/support/mail.ts` (modify) | End-to-end coverage. |

---

### Task 1: An engine and blob calls bound to any account

**Files:**
- Modify: `src/jmap/client.ts` (the `upload`, `downloadUrl`, `fetchBlob` methods), `src/sync/engine.ts` (constructor, `accountId` getter, `hasVacation`), `src/mail/labels.ts` (`labelLimits`), `src/sync/fake-jmap.ts`, `src/app/composer.ts:200`, `src/ui/Conversation.tsx:370`, `src/ui/MessageBody.tsx` (any `client.fetchBlob`/`downloadUrl` call)
- Test: `src/jmap/client.test.ts`, `src/sync/engine.test.ts`, `src/mail/labels.test.ts`

**Interfaces:**
- Produces:
  - `JmapClient.upload(blob: Blob, accountId?: string)`, `downloadUrl(blobId, name, type, accountId?: string)`, `fetchBlob(blobId, name, type, accountId?: string)`; omitted means the primary account.
  - `new MailEngine(client, { accountId?: Id, collapsedQueryChanges?, settleDelayMs? })`; `engine.accountId` returns the option or the client's primary.
  - `engine.upload(blob: Blob): Promise<UploadResult>` and `engine.fetchBlob(blobId: string, name: string, type: string): Promise<Blob>`, bound to the engine's account.
  - `labelLimits(session: Session, accountId?: Id): LabelLimits`.
  - `FakeJmap.accountId: string` (default `'a1'`), `FakeJmap.accountName: string` (default `'alice@example.test'`), and `fakeClient(fakes: FakeJmap[]): JmapClient` — one session listing every fake as an account (the first is primary and personal), each method call routed by its `accountId` argument.

- [ ] **Step 1: Write the failing tests**

In `src/jmap/client.test.ts` add (reuse the file's existing way of building a client with a stub `fetch` and a session; the session's `uploadUrl` is `http://x/upload/{accountId}/` and `downloadUrl` is `http://x/download/{accountId}/{blobId}/{name}?accept={type}`):

```ts
it('uploads to and downloads from the account it is told to, and the primary one otherwise', async () => {
  const urls: string[] = [];
  const client = clientWith((url) => {
    urls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify({ accountId: 'g', blobId: 'b1', type: 'text/plain', size: 1 })));
  });
  await client.upload(new Blob(['x']), 'g');
  await client.upload(new Blob(['x']));
  expect(urls).toEqual(['http://x/upload/g/', 'http://x/upload/a1/']);
  expect(client.downloadUrl('b1', 'n.txt', 'text/plain', 'g')).toBe('http://x/download/g/b1/n.txt?accept=text%2Fplain');
  expect(client.downloadUrl('b1', 'n.txt', 'text/plain')).toContain('/download/a1/');
});
```

(If the file has no `clientWith` helper, build the client the way its neighbouring tests do and call `useSession` with a session carrying those two URL templates and `primaryAccounts` pointing at `a1`.)

In `src/sync/engine.test.ts` add:

```ts
describe('an engine for a shared account', () => {
  const two = () => {
    const mine = new FakeJmap();
    const shared = new FakeJmap();
    shared.accountId = 'g';
    shared.accountName = 'support@example.test';
    for (const s of [mine, shared]) {
      s.addMailbox('I', 'Inbox', 'inbox');
      s.addMailbox('S', 'Sent', 'sent');
    }
    mine.addEmail({ id: 'm1', threadId: 'tm1', receivedAt: '2026-09-01T00:00:00Z', mailboxIds: { I: true } });
    shared.addEmail({ id: 'g1', threadId: 'tg1', receivedAt: '2026-09-01T00:00:00Z', mailboxIds: { I: true } });
    const client = fakeClient([mine, shared]);
    return { mine, shared, own: new MailEngine(client), group: new MailEngine(client, { accountId: 'g' }) };
  };

  it('reads only its own account', async () => {
    const { group, own } = two();
    await Promise.all([own.start(), group.start()]);
    const key = group.openQuery(inboxSpec);
    await group.ensureRange(key, 0, 10);
    expect(group.accountId).toBe('g');
    expect(group.state.queries[key]!.slots).toEqual(['g1']);
    expect(own.state.emails.g1).toBeUndefined();
  });

  it('ignores a state change for the other account', async () => {
    const { group, own, mine, shared } = two();
    await Promise.all([own.start(), group.start()]);
    await own.ensureRange(own.openQuery(inboxSpec), 0, 10);
    await group.ensureRange(group.openQuery(inboxSpec), 0, 10);
    shared.addEmail({ id: 'g2', threadId: 'tg2', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { I: true } });
    mine.calls = [];
    shared.calls = [];
    const change = { '@type': 'StateChange' as const, changed: { g: { Email: 'new', Mailbox: 'new', Thread: 'new' } } };
    own.onStateChange(change);
    group.onStateChange(change);
    await vi.waitFor(() => expect(group.state.emails.g2).toBeDefined());
    expect(mine.calls).toEqual([]);
  });
});
```

In `src/mail/labels.test.ts` add:

```ts
it('reads the limits of the account asked for', () => {
  const session = {
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
    accounts: {
      a1: { accountCapabilities: { 'urn:ietf:params:jmap:mail': { maxMailboxDepth: 10, maxSizeMailboxName: 200 } } },
      g: { accountCapabilities: { 'urn:ietf:params:jmap:mail': { maxMailboxDepth: 3, maxSizeMailboxName: 50 } } },
    },
  } as unknown as Session;
  expect(labelLimits(session, 'g')).toEqual({ maxDepth: 3, maxNameBytes: 50 });
  expect(labelLimits(session)).toEqual({ maxDepth: 10, maxNameBytes: 200 });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/jmap/client.test.ts src/sync/engine.test.ts src/mail/labels.test.ts`
Expected: FAIL — `fakeClient` is not exported; `upload` ignores its second argument; `labelLimits` ignores its second argument.

- [ ] **Step 3: Implement**

`src/jmap/client.ts`:

```ts
  async upload(blob: Blob, accountId = this.accountId): Promise<UploadResult> {
    const url = this.session.uploadUrl.replace('{accountId}', encodeURIComponent(accountId));
    // …body unchanged
  }

  downloadUrl(blobId: string, name: string, type: string, accountId = this.accountId): string {
    return this.session.downloadUrl
      .replace('{accountId}', encodeURIComponent(accountId))
      // …rest unchanged
  }

  async fetchBlob(blobId: string, name: string, type: string, accountId = this.accountId): Promise<Blob> {
    const res = await this.authFetch(this.downloadUrl(blobId, name, type, accountId), {}, false, true);
    // …rest unchanged
  }
```

`src/sync/engine.ts`:

```ts
  private readonly ownAccountId: Id | null;

  constructor(
    private readonly client: JmapClient,
    opts: { accountId?: Id; collapsedQueryChanges?: boolean; settleDelayMs?: number } = {},
  ) {
    this.ownAccountId = opts.accountId ?? null;
    // …unchanged
  }

  /** The account this engine reads and writes: a shared one when given, else the user's own. */
  get accountId(): Id {
    return this.ownAccountId ?? this.client.accountId;
  }

  upload(blob: Blob): Promise<UploadResult> {
    return this.client.upload(blob, this.accountId);
  }

  fetchBlob(blobId: string, name: string, type: string): Promise<Blob> {
    return this.client.fetchBlob(blobId, name, type, this.accountId);
  }
```

Import `UploadResult` from `../jmap/client`. `hasVacation()` already reads `accounts[this.accountId]`; leave it.

`src/mail/labels.ts`:

```ts
export function labelLimits(session: Session, accountId?: Id): LabelLimits {
  const account = accountId ?? session.primaryAccounts[MAIL];
  // …rest unchanged
```

Callers: in `src/app/composer.ts` replace `client.upload(file)` with `engine.upload(file)`; in `src/ui/Conversation.tsx` replace `client.fetchBlob(a.blobId!, …)` with `engine.fetchBlob(a.blobId!, …)` (take `engine` from `useApp()`); do the same for every other `client.fetchBlob`/`client.downloadUrl` (`grep -rn "fetchBlob\|downloadUrl" src --include='*.ts*'`).

`src/sync/fake-jmap.ts`: add fields `accountId = 'a1'` and `accountName = 'alice@example.test'`; keep `client()` as it is, and add below the class:

```ts
/** One session over several fakes: the first is the user's own account, the rest are shared ones. */
export function fakeClient(fakes: FakeJmap[]): JmapClient {
  const first = fakes[0]!;
  const caps = (f: FakeJmap) => ({ 'urn:ietf:params:jmap:mail': {}, ...(f.vacationSupported ? { [VACATION]: {} } : {}) });
  const session: Session = {
    capabilities: {},
    accounts: Object.fromEntries(fakes.map((f, i) => [f.accountId, { name: f.accountName, isPersonal: i === 0, isReadOnly: false, accountCapabilities: caps(f) }])),
    primaryAccounts: { 'urn:ietf:params:jmap:mail': first.accountId, 'urn:ietf:params:jmap:calendars': first.accountId },
    username: first.accountName,
    apiUrl: 'http://fake/jmap', downloadUrl: '', uploadUrl: '', eventSourceUrl: '', state: 's',
  };
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { using: string[]; methodCalls: Invocation[] };
    const done = new Map<string, Invocation>();
    const responses: Invocation[] = [];
    for (const [name, args, id] of body.methodCalls) {
      const fake = fakes.find((f) => f.accountId === args.accountId) ?? first;
      fake.usings.push(body.using);
      const [rname, result] = fake.dispatch(name, args, done, body.using);
      const inv: Invocation = [rname, result as Record<string, unknown>, id];
      done.set(id, inv);
      responses.push(inv);
    }
    return new Response(JSON.stringify({ methodResponses: responses, sessionState: 's' }));
  };
  const client = new JmapClient({ sessionUrl: 'http://fake/session', getToken: async () => 't', fetch: fetchImpl as typeof fetch });
  client.useSession(session);
  return client;
}
```

and a public method on `FakeJmap` wrapping the two private steps `client()` already performs per call:

```ts
  /** Resolve a call's back-references against earlier answers, then handle it. */
  dispatch(name: string, args: Record<string, unknown>, done: Map<string, Invocation>, using: string[]) {
    return this.handle(name, this.resolve(args, done), using);
  }
```

Match the `JmapClient` constructor options to what `client()` in the same file passes.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** — `Shared mailboxes: an engine, uploads and downloads bound to any account`

---

### Task 2: Accounts — which, what they are called, where they live

**Files:**
- Create: `src/app/accounts.ts`, `src/app/accounts.test.ts`

**Interfaces:**
- Produces:

```ts
export interface AccountInfo { id: Id; address: string; personal: boolean; label: string; base: string }
export function mailAccounts(session: Session): AccountInfo[];            // own first, then by label
export function accountForPath(pathname: string, accounts: AccountInfo[]): AccountInfo; // falls back to the first
export function withinAccount(pathname: string, account: AccountInfo): string;          // path with the base removed
```

`base` is `''` for the personal account and `/shared/<encodeURIComponent(id)>` otherwise.

- [ ] **Step 1: Write the failing test** (`src/app/accounts.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import type { Session } from '../jmap/types';
import { accountForPath, mailAccounts, withinAccount } from './accounts';

const MAIL = 'urn:ietf:params:jmap:mail';
const session = (accounts: Record<string, { name: string; isPersonal: boolean; mail?: boolean }>, primary = 'b') =>
  ({
    primaryAccounts: { [MAIL]: primary },
    accounts: Object.fromEntries(Object.entries(accounts).map(([id, a]) => [id, { name: a.name, isPersonal: a.isPersonal, isReadOnly: false, accountCapabilities: a.mail === false ? {} : { [MAIL]: {} } }])),
  }) as unknown as Session;

describe('mailAccounts', () => {
  it('lists the user\'s own account first, then shared ones by name', () => {
    const got = mailAccounts(session({ s: { name: 'support@example.test', isPersonal: false }, b: { name: 'alice@example.test', isPersonal: true }, a: { name: 'accounts@example.test', isPersonal: false } }));
    expect(got).toEqual([
      { id: 'b', address: 'alice@example.test', personal: true, label: 'You', base: '' },
      { id: 'a', address: 'accounts@example.test', personal: false, label: 'Accounts', base: '/shared/a' },
      { id: 's', address: 'support@example.test', personal: false, label: 'Support', base: '/shared/s' },
    ]);
  });
  it('leaves out an account without mail', () => {
    expect(mailAccounts(session({ b: { name: 'alice@example.test', isPersonal: true }, c: { name: 'cal@example.test', isPersonal: false, mail: false } })).map((a) => a.id)).toEqual(['b']);
  });
  it('labels a name that is not an address by the name itself', () => {
    expect(mailAccounts(session({ b: { name: 'alice', isPersonal: true }, g: { name: 'front desk', isPersonal: false } }))[1]!.label).toBe('Front desk');
  });
});

describe('accountForPath', () => {
  const list = mailAccounts(session({ b: { name: 'alice@example.test', isPersonal: true }, s: { name: 'support@example.test', isPersonal: false } }));
  it('finds the shared account in the address', () => {
    expect(accountForPath('/shared/s/inbox/t/t1', list).id).toBe('s');
    expect(accountForPath('/shared/s', list).id).toBe('s');
  });
  it('is the user\'s own account everywhere else', () => {
    expect(accountForPath('/inbox', list).id).toBe('b');
    expect(accountForPath('/', list).id).toBe('b');
  });
  it('falls back to the user\'s own account for one they can no longer open', () => {
    expect(accountForPath('/shared/gone/inbox', list).id).toBe('b');
  });
  it('does not mistake a longer id for a shorter one', () => {
    expect(accountForPath('/shared/sx/inbox', list).id).toBe('b');
  });
});

describe('withinAccount', () => {
  const [own, shared] = mailAccounts(session({ b: { name: 'alice@example.test', isPersonal: true }, s: { name: 'support@example.test', isPersonal: false } })) as [ReturnType<typeof mailAccounts>[number], ReturnType<typeof mailAccounts>[number]];
  it('drops the account\'s base from a path', () => {
    expect(withinAccount('/shared/s/inbox/t/t1', shared)).toBe('/inbox/t/t1');
    expect(withinAccount('/shared/s', shared)).toBe('/');
    expect(withinAccount('/inbox', own)).toBe('/inbox');
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/app/accounts.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (`src/app/accounts.ts`)

```ts
import { MAIL, type Id, type Session } from '../jmap/types';

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
```

- [ ] **Step 4: Run** `pnpm vitest run src/app/accounts.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `Shared mailboxes: account list, labels and base paths`

---

### Task 3: Notifications that say which mailbox

**Files:**
- Modify: `src/app/notify.ts`, `src/app/notify.test.ts`

**Interfaces:**
- Consumes: `AccountInfo` from Task 2.
- Produces: `notificationFor(emails: Email[], account?: { label: string; base: string; personal: boolean; id: string }): NotificationText`; `createNotifier` gains an optional `account: () => AccountInfo | undefined` dependency and its `open` receives a full path including the base.

- [ ] **Step 1: Add the failing tests** to `src/app/notify.test.ts`

```ts
const support = { id: 'g', address: 'support@example.test', personal: false, label: 'Support', base: '/shared/g' };

describe('notificationFor a shared account', () => {
  it('leads with the mailbox and opens the conversation there', () => {
    expect(notificationFor([mail('a')], support)).toEqual({ title: 'Support: Bob Builder', body: 'Subject a', path: '/shared/g/inbox/t/t-a', tag: 'oinbox-g-t-a' });
  });
  it('counts several under the mailbox', () => {
    expect(notificationFor([mail('a'), mail('b')], support)).toMatchObject({ title: 'Support: 2 new messages', path: '/shared/g/inbox', tag: 'oinbox-g-new' });
  });
  it('is unchanged for the user\'s own account', () => {
    const own = { id: 'b', address: 'alice@example.test', personal: true, label: 'You', base: '' };
    expect(notificationFor([mail('a')], own)).toEqual(notificationFor([mail('a')]));
  });
});
```

and in the `createNotifier` block:

```ts
  it('opens a shared account\'s conversation under its base', () => {
    const { api, shown } = fakeApi('granted');
    const opened: string[] = [];
    const notify = createNotifier({ api, enabled: () => true, away: () => true, inboxId: () => 'I', open: (p) => opened.push(p), account: () => support });
    notify([mail('a')]);
    expect(shown[0]!.title).toBe('Support: Bob Builder');
    shown[0]!.onclick!();
    expect(opened).toEqual(['/shared/g/inbox/t/t-a']);
  });
```

- [ ] **Step 2: Run** `pnpm vitest run src/app/notify.test.ts` — Expected: FAIL (titles lack the prefix).

- [ ] **Step 3: Implement** in `src/app/notify.ts`

```ts
import type { AccountInfo } from './accounts';

export function notificationFor(emails: Email[], account?: AccountInfo): NotificationText {
  const shared = account && !account.personal ? account : null;
  const lead = shared ? `${shared.label}: ` : '';
  const base = shared?.base ?? '';
  const tag = shared ? `oinbox-${shared.id}-` : 'oinbox-';
  if (emails.length === 1) {
    const e = emails[0]!;
    return { title: lead + sender(e), body: e.subject || '(no subject)', path: `${base}/inbox/t/${e.threadId}`, tag: `${tag}${e.threadId}` };
  }
  const senders = [...new Set(emails.map(sender))];
  const named = senders.slice(0, 3).join(', ') + (senders.length > 3 ? ` and ${senders.length - 3} more` : '');
  return { title: `${lead}${emails.length} new messages`, body: named, path: `${base}/inbox`, tag: `${tag}new` };
}
```

In `createNotifier`, add `account?: () => AccountInfo | undefined` to `deps` and call `notificationFor(fresh, deps.account?.())`.

- [ ] **Step 4: Run** `pnpm vitest run src/app/notify.test.ts` — Expected: PASS (the earlier assertions still hold: no account means the old text).
- [ ] **Step 5: Commit** — `Shared mailboxes: notifications name the mailbox and open it`

---

### Task 4: Account spaces and the wiring

**Files:**
- Modify: `src/app/accounts.ts`, `src/app/accounts.test.ts`, `src/app/context.tsx`, `src/index.tsx`, `src/ui/Shell.tsx` (the notifier and title lines added on 2026-10-08), `src/cache/persist.ts` (`clearCache`)
- Test: `src/app/accounts.test.ts`

**Interfaces:**
- Consumes: Task 1 (`MailEngine` `accountId` option, `labelLimits(session, id)`), Task 2, Task 3.
- Produces:

```ts
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
  current: Accessor<AccountSpace>;
  /** Unread Inbox conversations of one space. */
  unread: (space: AccountSpace) => number;
  totalUnread: Accessor<number>;
  /** Change which space is on screen; the caller navigates. */
  show: (id: Id) => void;
}
export function createSpaces(accounts: AccountInfo[], build: (info: AccountInfo) => Omit<AccountSpace, 'info'>, initial: Id): Spaces;
export function storageKey(username: string, account: AccountInfo): string; // `${username}:${account.id}`
```

`App` gains `spaces: Spaces`. `App.engine`, `actions`, `labels`, `settings`, `composers`, `recipients` and `nav` become getters returning the current space's.

- [ ] **Step 1: Write the failing tests** (append to `src/app/accounts.test.ts`)

```ts
import { createRoot } from 'solid-js';
import { createSpaces, storageKey } from './accounts';

describe('createSpaces', () => {
  const list = mailAccounts(session({ b: { name: 'alice@example.test', isPersonal: true }, s: { name: 'support@example.test', isPersonal: false } }));
  const fakeSpace = (unread: number) => ({ engine: { state: { mailboxes: { I: { id: 'I', role: 'inbox', unreadThreads: unread }, S: { id: 'S', role: 'sent', unreadThreads: 9 } } } } }) as never;

  it('builds one space per account and starts on the one asked for', () =>
    createRoot((dispose) => {
      const spaces = createSpaces(list, (info) => fakeSpace(info.personal ? 2 : 3), 's');
      expect(spaces.list().map((s) => s.info.id)).toEqual(['b', 's']);
      expect(spaces.current().info.id).toBe('s');
      spaces.show('b');
      expect(spaces.current().info.id).toBe('b');
      dispose();
    }));
  it('counts each Inbox, and all of them together', () =>
    createRoot((dispose) => {
      const spaces = createSpaces(list, (info) => fakeSpace(info.personal ? 2 : 3), 'b');
      expect(spaces.list().map(spaces.unread)).toEqual([2, 3]);
      expect(spaces.totalUnread()).toBe(5);
      dispose();
    }));
  it('ignores a request to show an account that is not there', () =>
    createRoot((dispose) => {
      const spaces = createSpaces(list, () => fakeSpace(0), 'b');
      spaces.show('gone');
      expect(spaces.current().info.id).toBe('b');
      dispose();
    }));
  it('starts on the user\'s own account when the one asked for is not there', () =>
    createRoot((dispose) => {
      expect(createSpaces(list, () => fakeSpace(0), 'gone').current().info.id).toBe('b');
      dispose();
    }));
});

describe('storageKey', () => {
  it('keeps accounts apart under one user', () => {
    const [own, shared] = mailAccounts(session({ b: { name: 'alice@example.test', isPersonal: true }, s: { name: 'support@example.test', isPersonal: false } }));
    expect(storageKey('alice@example.test', own!)).toBe('alice@example.test:b');
    expect(storageKey('alice@example.test', shared!)).toBe('alice@example.test:s');
  });
});
```

Review Focus 5 (drafts in two accounts survive a sign-out): add to `src/app/rescue.test.ts`

```ts
  it('rescues and returns the composers of two accounts independently', () => {
    saveRescue(localStorage, 'b', [item('mine')], 0);
    saveRescue(localStorage, 's', [item('support 1'), item('support 2')], 0);
    expect(takeRescue(localStorage, 's', 1).map((r) => r.draft.subject)).toEqual(['support 1', 'support 2']);
    expect(takeRescue(localStorage, 'b', 1).map((r) => r.draft.subject)).toEqual(['mine']);
  });
```

(This one is expected to pass already: it pins behaviour the wiring below relies on.)

- [ ] **Step 2: Run** `pnpm vitest run src/app/accounts.test.ts src/app/rescue.test.ts` — Expected: `createSpaces` and `storageKey` tests FAIL (not exported); the rescue test passes.

- [ ] **Step 3: Implement `createSpaces`** (append to `src/app/accounts.ts`)

```ts
import { createMemo, createSignal, type Accessor } from 'solid-js';

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

export const storageKey = (username: string, account: AccountInfo): string => `${username}:${account.id}`;
```

with the `AccountSpace` and `Spaces` interfaces from the Interfaces block above, importing the types of `MailEngine`, `Actions`, `Labels`, `Settings`, `Composers`, `Recipients`, `Nav`.

- [ ] **Step 4: Run** `pnpm vitest run src/app/accounts.test.ts` — Expected: PASS.

- [ ] **Step 5: Wire `src/index.tsx`**

The session is needed before spaces can be built, and a warm start has it from the cache. Restructure `boot()` so that:

1. `cachedSession` is loaded and applied (`client.useSession`) as today. On a cold start (`!cachedSession`), `await client.loadSession()` first (inside the existing `try`/`onAuthError` handling that `start()` has today), then continue. From here on the session is known.
2. Build the spaces:

```ts
  const accounts = mailAccounts(client.session);
  const key = (info: AccountInfo) => storageKey(client.session.username, info);
  const spaces = createSpaces(
    accounts,
    (info) => {
      const engine = new MailEngine(client, { accountId: info.id });
      // Before the warm-start snapshot is applied, so it sees every email.
      const recipients = createRecipients(engine);
      return {
        engine,
        recipients,
        actions: createActions(engine, toasts.toast, confirmDialog.confirm),
        labels: createLabels(engine, toasts.toast, confirmDialog.confirm, () => labelLimits(client.session, info.id)),
        settings: createSettings(engine, toasts.toast, confirmDialog.confirm),
        composers: createComposers(engine, client, toasts.toast, confirmDialog.confirm, recipients.recordSent, (fn) => connection.onRecovered(fn)),
        nav: createNav(),
      };
    },
    accountForPath(location.pathname, accounts).id,
  );
  const each = (fn: (s: AccountSpace) => void) => spaces.list().forEach(fn);
```

3. Replace every single-engine use with all spaces:
   - warm start: `for (const s of spaces.list()) { const snap = await loadSnapshot(key(s.info)); if (snap) s.engine.hydrate(snap); }`
   - `start()`: `each((s) => { s.engine.onPersist = (snap) => void saveSnapshot(key(s.info), snap); void s.recipients.start(key(s.info)); })`, then `await Promise.all(spaces.list().map((s) => s.engine.start()))`, then rescue per space: `each((s) => { const r = takeRescue(localStorage, s.info.id); if (r.length) { s.composers.restore(r); restored += r.length; } })` with one toast for the total; `each((s) => void s.recipients.scanSent().catch((e) => onAuthError(e)))`.
   - push: `onStateChange: (c) => { each((s) => s.engine.onStateChange(c)); calendar.onStateChange(c); }`; in `onConnected`: `each((s) => { s.engine.setOnline(true); void s.engine.catchUp().catch(logUnexpected); void s.engine.refreshSettings().catch(logUnexpected); })`; `onDisconnected`: `each((s) => s.engine.setOnline(false))`.
   - `connection.onRetry` and the `offline` listener: `each((s) => void s.engine.catchUp().catch(logUnexpected))`.
   - `rescueDrafts`: `each((s) => saveRescue(localStorage, s.info.id, s.composers.snapshot()))`.
   - `leave` and `sessionLost`: `each((s) => s.recipients.stop())`, `each((s) => s.engine.setOnline(false))`, and `clearCache` for every key: `await Promise.all(spaces.list().map((s) => clearCache(key(s.info))))`. Also `clearCache(user)` once for the pre-slice key, so an old snapshot is removed.
4. The `App` object:

```ts
  const cur = spaces.current;
  const app: App = {
    client, calendar, auth, connection, signIn, signOut, spaces,
    get engine() { return cur().engine; },
    get actions() { return cur().actions; },
    get labels() { return cur().labels; },
    get settings() { return cur().settings; },
    get composers() { return cur().composers; },
    get recipients() { return cur().recipients; },
    get nav() { return cur().nav; },
    hasCalendars: () => client.hasSession && !!client.session.primaryAccounts[CALENDARS] && cur().info.personal,
    toast: toasts.toast,
    errors,
    images: await createImagePrefs(),
    ...theme,
  };
```

(`...theme` after getters is fine: it adds plain fields. Do not spread `app` anywhere, which would freeze the getters.)

5. The router, keyed on the account so the shell re-mounts and every `useApp()` capture is fresh:

```tsx
        <AppContext.Provider value={app}>
          <Show when={cur()} keyed>
            {(space) => (
              <Router base={space.info.base} root={(p) => <Shell {...p} toasts={toasts.Host} confirmHost={confirmDialog.Host} />}>
                {/* the existing <Route> list, unchanged */}
              </Router>
            )}
          </Show>
        </AppContext.Provider>
```

   Import `Show` from `solid-js`. The `/calendar` route keeps its `app.hasCalendars()` guard, which is now false in a shared account, so it redirects to `/inbox` there.

6. Following the address: the browser's back button can cross accounts. Add after `mount(...)`:

```ts
  window.addEventListener('popstate', () => spaces.show(accountForPath(location.pathname, accounts).id));
```

- [ ] **Step 6: Notifications and title for every account** (`src/ui/Shell.tsx`)

Replace the block added on 2026-10-08 (`const inbox = …` through `onCleanup(() => (app.engine.onArrived = null))`) with:

```tsx
  createEffect(() => (document.title = tabTitle(app.spaces.totalUnread(), branding().name)));
  for (const space of app.spaces.list()) {
    space.engine.onArrived = createNotifier({
      api: notifications.api,
      enabled: notifications.prefs.enabled,
      away: () => document.visibilityState === 'hidden' || !document.hasFocus(),
      inboxId: () => Object.values(space.engine.state.mailboxes).find((mb) => mb.role === 'inbox')?.id,
      account: () => space.info,
      open: (path) => {
        window.focus();
        // A full path, base included: go there through the browser so the right account mounts.
        history.pushState(null, '', path);
        app.spaces.show(space.info.id);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
    });
  }
  onCleanup(() => app.spaces.list().forEach((s) => (s.engine.onArrived = null)));
```

`src/app/context.tsx`: add `spaces: Spaces;` to `App` (import the type from `./accounts`).

`src/cache/persist.ts`: no signature change; `clearCache(key)` is called once per key.

- [ ] **Step 7: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm e2e`
Expected: all unit tests pass; the Chromium e2e suite passes as before (Alice has one account until Task 6, so nothing on screen has changed). If any component test builds an `App` by hand, add `spaces` to its fixture with `createSpaces` and one fake space.

- [ ] **Step 8: Commit** — `Shared mailboxes: one account space per mail account; push, snapshots, rescue and notifications for all of them`

---

### Task 5: The switcher

**Files:**
- Create: `src/ui/AccountSwitcher.tsx`, `src/ui/AccountSwitcher.test.tsx`
- Modify: `src/ui/Shell.tsx` (sidebar), `src/ui/styles.css`

**Interfaces:**
- Consumes: `Spaces`, `AccountSpace` (Task 4).
- Produces: `<AccountSwitcher spaces={Spaces} onSwitch={(space: AccountSpace) => void} />`. Renders nothing when `spaces.list().length < 2`.

- [ ] **Step 1: Write the failing test** (`src/ui/AccountSwitcher.test.tsx`)

```tsx
import { fireEvent, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { AccountSpace, Spaces } from '../app/accounts';
import { AccountSwitcher } from './AccountSwitcher';

const space = (id: string, label: string, address: string, drafts = 0): AccountSpace =>
  ({ info: { id, label, address, personal: id === 'b', base: id === 'b' ? '' : `/shared/${id}` }, composers: { list: () => new Array(drafts).fill({}) } }) as never;

function setup(list: AccountSpace[], unread: Record<string, number>, start = 'b') {
  const [cur, setCur] = createSignal(start);
  const spaces: Spaces = {
    list: () => list,
    current: () => list.find((s) => s.info.id === cur())!,
    unread: (s) => unread[s.info.id] ?? 0,
    totalUnread: () => Object.values(unread).reduce((a, b) => a + b, 0),
    show: setCur,
  };
  const switched: string[] = [];
  const view = render(() => <AccountSwitcher spaces={spaces} onSwitch={(s) => switched.push(s.info.id)} />);
  return { ...view, switched };
}

const you = space('b', 'You', 'alice@example.test');
const support = space('s', 'Support', 'support@example.test');

describe('AccountSwitcher', () => {
  it('is not there with a single account', () => {
    const { container } = setup([you], {});
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the open account, and a dot when another has unread mail', () => {
    const { getByRole } = setup([you, support], { b: 4, s: 3 });
    const button = getByRole('button', { name: /^You/ });
    expect(button).toHaveAccessibleName('You, alice@example.test. Unread mail in another mailbox.');
    expect(button.querySelector('.account-dot')).not.toBeNull();
  });
  it('has no dot when only the open account has unread mail', () => {
    const { getByRole } = setup([you, support], { b: 4, s: 0 });
    const button = getByRole('button', { name: /^You/ });
    expect(button).toHaveAccessibleName('You, alice@example.test');
    expect(button.querySelector('.account-dot')).toBeNull();
  });
  it('lists every account with its unread count and switches on choosing one', () => {
    const { getByRole, getAllByRole, switched } = setup([you, support], { b: 0, s: 3 });
    fireEvent.click(getByRole('button', { name: /^You/ }));
    const items = getAllByRole('menuitemradio');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['You, alice@example.test', 'Support, support@example.test, 3 unread']);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(items[1]!);
    expect(switched).toEqual(['s']);
  });
  it('marks an account with a composer open', () => {
    const { getByRole, getAllByRole } = setup([you, space('s', 'Support', 'support@example.test', 1)], { s: 0 });
    fireEvent.click(getByRole('button', { name: /^You/ }));
    expect(getAllByRole('menuitemradio')[1]).toHaveAccessibleName('Support, support@example.test, draft open');
  });
  it('closes on Escape and gives the focus back to the button', () => {
    const { getByRole, queryByRole } = setup([you, support], {});
    const button = getByRole('button', { name: /^You/ });
    fireEvent.click(button);
    fireEvent.keyDown(getByRole('menu'), { key: 'Escape' });
    expect(queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/ui/AccountSwitcher.test.tsx` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (`src/ui/AccountSwitcher.tsx`)

```tsx
import { createSignal, For, Show } from 'solid-js';
import type { AccountSpace, Spaces } from '../app/accounts';

/** Which mailbox is open, and the way to another: the user's own and the shared ones they belong to. */
export function AccountSwitcher(props: { spaces: Spaces; onSwitch: (space: AccountSpace) => void }) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  const current = () => props.spaces.current();
  const elsewhere = () => props.spaces.list().some((s) => s !== current() && props.spaces.unread(s) > 0);
  const name = (s: AccountSpace) =>
    [s.info.label, s.info.address, props.spaces.unread(s) ? `${props.spaces.unread(s)} unread` : '', s !== current() && s.composers.list().length ? 'draft open' : '']
      .filter(Boolean)
      .join(', ');
  const close = () => {
    setOpen(false);
    button.focus();
  };
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
  const move = (by: number) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + by + all.length) % all.length]?.focus();
  };

  return (
    <Show when={props.spaces.list().length > 1}>
      <div class="account-switcher">
        <button
          ref={button}
          type="button"
          class="account-button"
          aria-haspopup="menu"
          aria-expanded={open()}
          aria-label={`${current().info.label}, ${current().info.address}${elsewhere() ? '. Unread mail in another mailbox.' : ''}`}
          onClick={() => {
            setOpen(!open());
            if (open()) queueMicrotask(() => items()[0]?.focus());
          }}
        >
          <span class="account-label">{current().info.label}</span>
          <Show when={elsewhere()}>
            <span class="account-dot" />
          </Show>
          <span class="account-caret" aria-hidden="true">▾</span>
        </button>
        <Show when={open()}>
          <div
            ref={menu}
            class="account-menu"
            role="menu"
            aria-label="Mailboxes"
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') (e.preventDefault(), move(1));
              else if (e.key === 'ArrowUp') (e.preventDefault(), move(-1));
            }}
            onFocusOut={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== button) setOpen(false);
            }}
          >
            <For each={props.spaces.list()}>
              {(s) => (
                <button
                  type="button"
                  class="account-item"
                  role="menuitemradio"
                  aria-checked={s === current()}
                  aria-label={name(s)}
                  onClick={() => {
                    setOpen(false);
                    if (s !== current()) props.onSwitch(s);
                  }}
                >
                  <span class="account-item-main">
                    <span class="account-label">{s.info.label}</span>
                    <span class="account-address">{s.info.address}</span>
                  </span>
                  <Show when={s !== current() && s.composers.list().length}>
                    <span class="account-draft">Draft</span>
                  </Show>
                  <Show when={props.spaces.unread(s)}>
                    <span class="count">{props.spaces.unread(s)}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
```

- [ ] **Step 4: Run** `pnpm vitest run src/ui/AccountSwitcher.test.tsx` — Expected: PASS.

- [ ] **Step 5: Put it in the sidebar** (`src/ui/Shell.tsx`), directly above the Compose button:

```tsx
        <AccountSwitcher
          spaces={app.spaces}
          onSwitch={(space) => {
            // Through the browser, not the router: the router for the other account does not exist yet.
            history.pushState(null, '', `${space.info.base}/inbox`);
            app.spaces.show(space.info.id);
          }}
        />
```

Styles (`src/ui/styles.css`, after the `.compose-fab` rules; the 44px rule sits in the existing `@media (pointer: coarse)` block):

```css
.account-switcher { position: relative; margin: 0 12px 8px; }
.account-button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.account-button:hover { background: var(--hover); }
.account-label { font-weight: 500; }
.account-caret { margin-left: auto; color: var(--text-2); }
.account-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.account-menu { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 20; padding: 4px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); }
.account-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.account-item:hover, .account-item:focus-visible { background: var(--hover); }
.account-item[aria-checked="true"] .account-label::after { content: " ✓"; color: var(--accent); }
.account-item-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.account-address { color: var(--text-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.account-draft { color: var(--text-2); font-size: 12px; }
```

Use the variable names the stylesheet already defines for hover and surface colours (check `:root` at the top of `styles.css`; substitute if they differ) and add `.account-button, .account-item { min-height: 44px; }` inside the coarse-pointer block.

- [ ] **Step 6: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 7: Commit** — `Shared mailboxes: the account switcher`

---

### Task 6: Fixtures, end-to-end tests and docs

**Files:**
- Create: `deploy/stalwart/groups.ndjson`, `e2e/shared.spec.ts`
- Modify: `deploy/seed.sh`, `deploy/seed/seed_mail.py`, `e2e/support/mail.ts`, any e2e spec that counts Alice's identities, `README.md`, `CHANGELOG.md`, `docs/operating.md`, `deploy/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: e2e helpers `sharedAccountId(address = 'support@example.test', user = ALICE): Promise<string>`; `jmap(calls, user, using)` already accepts any `accountId` in its calls.

- [ ] **Step 1: The group fixture**

`deploy/stalwart/groups.ndjson`:

```json
{"@type":"upsert","object":"Account","matchOn":["name","domainId"],"value":{"acct-support":{"@type":"Group","name":"support","domainId":"#dom-example-grp","description":"Support (shared mailbox)"}}}
```

`deploy/seed.sh`, after the accounts block and before `Action/ReloadSettings`:

```bash
# The shared mailbox: a group, with alice and bob as members. Membership is set with an update that
# carries no credentials, so open sessions survive (re-applying an Account would reset its password).
{ echo '{"@type":"upsert","object":"Domain","matchOn":["name"],"value":{"dom-example-grp":{"name":"example.test"}}}'; cat stalwart/groups.ndjson; } | cli apply --stdin --quiet
accounts_json=$(cli query Account --json)
id_of() { printf '%s\n' "$accounts_json" | grep "\"emailAddress\":\"$1\"" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'; }
group_id=$(id_of support@example.test)
for member in alice bob; do
  cli update Account "$(id_of "$member@example.test")" --json "{\"memberGroupIds\":{\"$group_id\":true}}" >/dev/null
done
echo "seed: support@example.test is shared with alice and bob"
```

`deploy/seed/seed_mail.py`: in `messages()` (the function that builds `out`), before the sort, add three messages delivered to the group, and make `main()` count the group's existing Message-IDs so re-runs skip them:

```python
    SUPPORT = f"support@{DOMAIN}"
    shared = [
        ("Nora Quinn <nora@customer.test>", "Can't reset my password", ago(2, 4), "The reset link says it has expired. Could you send a new one?"),
        ("Omar Diaz <omar@customer.test>", "Invoice address change", ago(1, 6), "Please update our billing address before the next invoice."),
        ("Nora Quinn <nora@customer.test>", "Thank you!", ago(0, 3), "The new link worked. Thanks for the quick help."),
    ]
    for i, (frm, subj, date, body) in enumerate(shared):
        out.append(("smtp", build(frm, [SUPPORT], subj, date, f"shared-{i}@seed.test", body), [SUPPORT]))
```

and in `main()`, extend `present` with the group's ids, read through Alice's credentials:

```python
    sess = json.load(urllib.request.urlopen(urllib.request.Request(f"{BASE}/jmap/session", headers=auth(ALICE))))
    for acct in (a for a, v in sess["accounts"].items() if not v["isPersonal"]):
        r = jmap(ALICE, [["Email/query", {"accountId": acct}, "q"],
                         ["Email/get", {"accountId": acct, "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"}, "properties": ["messageId"]}, "g"]])
        present |= {mid for e in r["g"]["list"] for mid in (e.get("messageId") or [])}
```

(Use the script's own names for its base URL and auth-header helper; read the top of the file.)

Run: `cd deploy && ./seed.sh` twice. Expected: the first run reports 3 more SMTP deliveries; the second reports 0 and "already present" for them. Then `curl -s -u alice@example.test:oinbox-dev-pass localhost:8080/jmap/session | python3 -c "import sys,json; print({k:v['name'] for k,v in json.load(sys.stdin)['accounts'].items()})"` lists both accounts.

- [ ] **Step 2: Fix what the fixture changes**

Run: `pnpm build && pnpm e2e`
Expected: specs that count Alice's identities fail (her account now has a `support@example.test` identity). Update each such assertion to select rows by address rather than by count or position, e.g. `page.locator('.identity-row', { hasText: 'alice@example.test' })`. Everything else must pass.

- [ ] **Step 3: Write the e2e spec** (`e2e/shared.spec.ts`)

Add to `e2e/support/mail.ts`:

```ts
/** The id of a shared account as `user` sees it in their session. */
export async function sharedAccountId(address = 'support@example.test', user = ALICE): Promise<string> {
  const res = await fetch(`${BASE}/jmap/session`, { headers: { authorization: `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString('base64')}` } });
  const session = (await res.json()) as { accounts: Record<string, { name: string }> };
  const id = Object.entries(session.accounts).find(([, a]) => a.name === address)?.[0];
  if (!id) throw new Error(`${user} has no shared account ${address}`);
  return id;
}
```

```ts
import { expect, test, type Page } from '@playwright/test';
import { jmap, sendMail, sharedAccountId, uniqueTag, waitFor, ALICE, BOB } from './support/mail';
import { openInbox, rows, waitLive } from './support/app';
import { signInThroughStalwart } from './support/login';

const SUPPORT = 'support@example.test';
let support: string;
const createdInSupport: string[] = [];

test.beforeAll(async () => {
  support = await sharedAccountId();
});
test.afterEach(async () => {
  if (createdInSupport.length) await jmap([['Email/set', { accountId: support, destroy: createdInSupport.splice(0) }, 'd']]);
});

const switcher = (page: Page) => page.locator('.account-button');
const supportMail = async (subject: string) => {
  const r = await jmap([
    ['Email/query', { accountId: support, filter: { subject } }, 'q'],
    ['Email/get', { accountId: support, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'threadId', 'mailboxIds', 'from'] }, 'g'],
  ]);
  return (r.g.list as { id: string; subject: string; threadId: string; mailboxIds: Record<string, boolean>; from: { email: string }[] }[]).filter((e) => e.subject === subject);
};
async function deliverToSupport(subject: string) {
  await sendMail({ from: 'Nora Quinn <nora@customer.test>', to: [SUPPORT], subject, text: 'Delivered during an e2e run.' });
  const mail = await waitFor(async () => (await supportMail(subject))[0], 15_000, 'mail in the shared inbox');
  createdInSupport.push(mail.id);
  return mail;
}
async function switchTo(page: Page, label: string) {
  await switcher(page).click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${label},`) }).click();
}

test('the switcher lists the shared mailbox, and switching shows its inbox', async ({ page }) => {
  await openInbox(page);
  await expect(switcher(page)).toContainText('You');
  await switchTo(page, 'Support');
  await expect(page).toHaveURL(new RegExp(`/shared/${support}/inbox$`));
  await expect(switcher(page)).toContainText('Support');
  await expect(rows(page).filter({ hasText: "Can't reset my password" })).toBeVisible();
  // Alice's own mail is not here.
  await expect(rows(page).filter({ hasText: 'Q3 planning offsite' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Calendar' })).toHaveCount(0);
});

test('mail arriving in the shared mailbox raises the dot and the tab count without a reload', async ({ page }) => {
  await openInbox(page);
  await waitLive(page);
  const before = Number((await page.title()).match(/^\((\d+)\)/)?.[1] ?? 0);
  await deliverToSupport(`Push test ${uniqueTag()}`);
  await expect(page.locator('.account-dot')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveTitle(new RegExp(`^\\(${before + 1}\\) `));
  await switcher(page).click();
  await expect(page.getByRole('menuitemradio', { name: /^Support, support@example\.test, \d+ unread$/ })).toBeVisible();
});

test('a reply from the shared mailbox is sent as support@ and filed in its Sent', async ({ page }) => {
  const subject = `Compose test ${uniqueTag()}`;
  const mail = await deliverToSupport(subject);
  await page.goto(`/shared/${support}/inbox/t/${mail.threadId}`);
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
  await page.locator('.composer .ProseMirror').last().fill('Here is a new link.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // Undo-send holds it for ten seconds.
  const sent = await waitFor(async () => (await supportMail(`Re: ${subject}`)).find((e) => e.from[0]?.email === SUPPORT), 30_000, 'the reply in the shared account');
  createdInSupport.push(sent.id);
  const boxes = (await jmap([['Mailbox/get', { accountId: support, properties: ['role'] }, 'm']])).m.list as { id: string; role: string | null }[];
  expect(sent.mailboxIds[boxes.find((b) => b.role === 'sent')!.id]).toBe(true);
});

test('a reload on a shared address stays in the shared mailbox; an unknown one goes to the user\'s own', async ({ page }) => {
  await page.goto(`/shared/${support}/inbox`);
  await expect(switcher(page)).toContainText('Support');
  await page.reload();
  await expect(switcher(page)).toContainText('Support');
  await expect(rows(page).filter({ hasText: "Can't reset my password" })).toBeVisible();
  await page.goto('/shared/nosuchaccount/inbox');
  await expect(switcher(page)).toContainText('You');
  await expect(rows(page).first()).toBeVisible();
});

test('a composer left open in one mailbox is still there, with its text, after switching away and back', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: /Compose/ }).click();
  await page.getByLabel('Subject').fill('Half-written');
  await page.locator('.composer .ProseMirror').fill('Do not lose me.');
  await switchTo(page, 'Support');
  await expect(page.locator('.composer')).toHaveCount(0);
  await switcher(page).click();
  await expect(page.getByRole('menuitemradio', { name: /^You, .*draft open$/ })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /^You,/ }).click();
  await expect(page.getByLabel('Subject')).toHaveValue('Half-written');
  await expect(page.locator('.composer .ProseMirror')).toHaveText('Do not lose me.');
  // Leave nothing behind.
  await page.locator('.composer').getByRole('button', { name: /Discard|Delete draft/ }).click();
});

test.describe('a user with no shared mailbox', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('sees no switcher', async ({ page }) => {
    await page.goto('/');
    await signInThroughStalwart(page, 'carol@example.test');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
  });
});
```

Adjust selectors to the app's real ones before running (`.composer`, the Subject label, the discard button's name and `signInThroughStalwart`'s parameters: read `e2e/compose.spec.ts` and `e2e/support/login.ts`). If Carol's 50,000-message mailbox is present, the last test still only waits for the top bar.

- [ ] **Step 4: Run**

Run: `pnpm build && pnpm exec playwright test --project=chromium e2e/shared.spec.ts`
Expected: 6 passed. Then `pnpm e2e:all`. Expected: everything passes on all four projects, bar the known expected failures listed in `docs/beta-audit.md`.

If the keyed `<Router base>` does not re-mount cleanly (blank pane after switching, or links without the base), stop and apply the spec's fallback: keep the account id in `sessionStorage` (`oinbox.account`), leave URLs alone, drop the `/shared/` cases from Tasks 2 and 6, and say so in the commit.

- [ ] **Step 5: Docs**

- `README.md`, under "What it does": `- **Shared mailboxes**: a Stalwart group you belong to appears in a switcher above Compose; work its inbox and send from it, with unread counts for every mailbox.` Remove "several accounts at once" from "Not in v1" and replace it with "accounts on more than one server at once, a combined inbox across mailboxes".
- `CHANGELOG.md`: one bullet under the current release.
- `docs/operating.md`, a new section before "Limits worth knowing":

```markdown
## Shared mailboxes

A shared mailbox is a Stalwart **group** account. Create the group in Stalwart's WebUI (Directory › Accounts › Group) with the address the team shares, and add each person to it under their own account's groups. From their next page load, the group appears in oinbox's switcher above Compose. Mail to the group's address is delivered to the group's Inbox only; replies sent from there are filed in the group's Sent, where every member sees them. Each member's own account also gains the group's address as an identity, for sending as the group from their own mailbox.
```

- `deploy/README.md`: mention the `support` group, its members and its three seeded messages in the seed description and the credentials table.

- [ ] **Step 6: Commit** — `Shared mailboxes: seeded support@ group, end-to-end tests, docs`
