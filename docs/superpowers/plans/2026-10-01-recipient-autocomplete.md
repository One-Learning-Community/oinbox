# Recipient Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The To, Cc and Bcc fields suggest people from the user's own mail history as they type.

**Architecture:** A pure index (`src/mail/recipients.ts`) counts contacts per address and ranks matches. A store (`src/app/recipients.ts`) fills it from three sources (a one-off scan of Sent, every email the engine merges, and messages sent in this session), caches it in IndexedDB and answers `suggest()`. The recipient field moves from rozie Tags to rozie Combobox, which renders the list.

**Tech Stack:** TypeScript strict, SolidJS 1.9, Vite, Vitest (jsdom), Playwright, `@rozie-ui/combobox-solid` 0.6.0 (already a dependency), `idb-keyval`.

**Spec:** `docs/superpowers/specs/2026-10-01-recipient-autocomplete-design.md`

## Global Constraints

- No new dependencies. `@rozie-ui/tags-solid` is removed in Task 5.
- `ui/` never calls `jmap/`. The only new JMAP call is `MailEngine.sentRecipients` in `src/sync/engine.ts`.
- Limits, verbatim from the spec: 6 suggestions; Sent scan of the newest 500 messages, once per session; saved index cut to the 2,000 best-ranked entries; counted-id set cut to the 5,000 most recently added ids; saves at most once every 5 seconds.
- Suggestions never block writing mail: cache failures are swallowed; a failed scan leaves the store usable.
- The draft model does not change: each field holds `EmailAddress[]`.
- The accessible names of the fields stay "To", "Cc" and "Bcc".
- rozie gaps go in `docs/rozie-feedback.md`; do not patch around them silently.
- Match the surrounding code: 2-space indent, single quotes, comments only where the code can't say it.
- Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01UMoXfxooT3CRtWKGxJtpLC`
- Commands: `pnpm test` (unit), `pnpm typecheck`, `pnpm build`, `pnpm e2e` (needs the Docker stack in `deploy/`; see `e2e/README.md`). `E2E_SKIP_SEED=1 pnpm exec playwright test compose` runs one spec quickly. The e2e suite runs against `dist/`, so run `pnpm build` before it.

## Review Focus

1. **The same address in different letter case** (`Bob@Example.test`, `bob@example.test`): one index entry, and excluding one excludes the other. Pinned in Task 1.
2. **A stored cache of the wrong shape** (an older version, or garbage): the store starts empty instead of crashing. Pinned in Task 1 (`parseRecipientCache`) and used in Task 2.
3. **A display name with a comma** (`Roe, Sam`): the picked or pasted person stays one recipient with the right address; the name is never re-parsed. Pinned in Task 1 (`addUnique`) and Task 5 (e2e paste).
4. **One person in both To and Cc of a sent message:** counted once for that message. Pinned in Task 1 and Task 3.
5. **Emails reported before the cache has loaded** (warm start): counted once after the load, neither lost nor doubled. Pinned in Task 3.

---

### Task 1: The pure index

**Files:**
- Create: `src/mail/recipients.ts`
- Test: `src/mail/recipients.test.ts`

**Interfaces:**
- Consumes: `EmailAddress` from `src/jmap/types.ts` (`{ name: string | null; email: string }`); `parseAddressList(input: string): EmailAddress[]` from `src/mail/compose.ts`.
- Produces:
  - `interface Recipient { email: string; name: string; sent: number; received: number; last: string }`
  - `type RecipientIndex = Record<string, Recipient>` (key: lower-cased address)
  - `type ContactKind = 'sent' | 'received'`
  - `interface RecipientCache { index: RecipientIndex; counted: string[] }`
  - `isRobot(email: string): boolean`
  - `add(index: RecipientIndex, addresses: EmailAddress[], kind: ContactKind, at: string): RecipientIndex` (mutates and returns `index`)
  - `compareRecipients(a: Recipient, b: Recipient): number`
  - `suggest(index: RecipientIndex, query: string, opts: { exclude: Set<string>; limit: number }): Recipient[]`
  - `parseRecipientCache(value: unknown): RecipientCache | undefined`
  - `toAddress(r: Recipient): EmailAddress`
  - `completeAddress(text: string): EmailAddress | null`
  - `addUnique(list: EmailAddress[], more: EmailAddress[]): EmailAddress[]`

- [ ] **Step 1: Write the failing tests**

Create `src/mail/recipients.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  add,
  addUnique,
  completeAddress,
  isRobot,
  parseRecipientCache,
  suggest,
  toAddress,
  type Recipient,
  type RecipientIndex,
} from './recipients';

const bob = { name: 'Bob Example', email: 'bob@example.test' };
const none = { exclude: new Set<string>(), limit: 6 };
const emails = (list: Recipient[]) => list.map((r) => r.email);

function indexOf(...entries: Recipient[]): RecipientIndex {
  return Object.fromEntries(entries.map((r) => [r.email.toLowerCase(), r]));
}
const person = (email: string, name: string, sent: number, received: number, last: string): Recipient => ({ email, name, sent, received, last });

describe('add', () => {
  it('counts one contact per address and keeps the newest name and time', () => {
    const index: RecipientIndex = {};
    add(index, [{ name: 'Bob', email: 'bob@example.test' }], 'received', '2026-09-01T00:00:00Z');
    add(index, [bob], 'sent', '2026-09-03T00:00:00Z');
    add(index, [{ name: 'Old Name', email: 'bob@example.test' }], 'sent', '2026-09-02T00:00:00Z');
    expect(index).toEqual({ 'bob@example.test': { email: 'bob@example.test', name: 'Bob Example', sent: 2, received: 1, last: '2026-09-03T00:00:00Z' } });
  });

  it('keeps a name when a newer contact has none', () => {
    const index: RecipientIndex = {};
    add(index, [bob], 'sent', '2026-09-01T00:00:00Z');
    add(index, [{ name: null, email: 'bob@example.test' }], 'sent', '2026-09-02T00:00:00Z');
    expect(index['bob@example.test']!.name).toBe('Bob Example');
  });

  it('treats letter case as the same address and keeps the first spelling', () => {
    const index: RecipientIndex = {};
    add(index, [{ name: null, email: 'Bob@Example.test' }], 'sent', '2026-09-01T00:00:00Z');
    add(index, [{ name: null, email: 'bob@example.test' }], 'sent', '2026-09-02T00:00:00Z');
    expect(Object.keys(index)).toEqual(['bob@example.test']);
    expect(index['bob@example.test']).toMatchObject({ email: 'Bob@Example.test', sent: 2 });
  });

  it('counts a person once per message, even when listed twice', () => {
    const index: RecipientIndex = {};
    add(index, [bob, { name: null, email: 'BOB@example.test' }], 'sent', '2026-09-01T00:00:00Z');
    expect(index['bob@example.test']!.sent).toBe(1);
  });

  it('never indexes robots or malformed addresses', () => {
    const index: RecipientIndex = {};
    const robots = ['no-reply@x.test', 'noreply@x.test', 'NoReply+abc@x.test', 'do-not-reply@x.test', 'donotreply@x.test', 'mailer-daemon@x.test', 'postmaster@x.test', 'bounce@x.test', 'bounces-123@x.test'];
    add(index, [...robots, 'not-an-address', '@x.test'].map((email) => ({ name: null, email })), 'received', '2026-09-01T00:00:00Z');
    expect(index).toEqual({});
    expect(isRobot('norman@x.test')).toBe(false);
    expect(isRobot('bouncer@x.test')).toBe(false);
  });
});

describe('suggest', () => {
  const index = indexOf(
    person('bob@example.test', 'Bob Example', 2, 2, '2026-09-10T00:00:00Z'),
    person('carol.nguyen@mail.partner.test', 'Carol Nguyen', 1, 5, '2026-09-12T00:00:00Z'),
    person('ci@builds.test', 'CI Bot', 0, 4, '2026-09-20T00:00:00Z'),
    person('zed@nowhere.test', '', 0, 1, '2026-09-01T00:00:00Z'),
  );

  it('returns nothing for an empty query', () => {
    expect(suggest(index, '', none)).toEqual([]);
    expect(suggest(index, '   ', none)).toEqual([]);
  });

  it('matches a prefix of a name word, in any letter case', () => {
    expect(emails(suggest(index, 'EXA', none))).toEqual(['bob@example.test']);
    expect(emails(suggest(index, 'ngu', none))).toEqual(['carol.nguyen@mail.partner.test']);
  });

  it('matches the mailbox part, whole and by its tokens', () => {
    expect(emails(suggest(index, 'carol.n', none))).toEqual(['carol.nguyen@mail.partner.test']);
    expect(emails(suggest(index, 'nguyen', none))).toEqual(['carol.nguyen@mail.partner.test']);
    expect(emails(suggest(index, 'zed', none))).toEqual(['zed@nowhere.test']);
  });

  it('matches the domain, whole and from each label', () => {
    expect(emails(suggest(index, 'mail.partner', none))).toEqual(['carol.nguyen@mail.partner.test']);
    expect(emails(suggest(index, 'partner', none))).toEqual(['carol.nguyen@mail.partner.test']);
  });

  it('matches the whole address as typed', () => {
    expect(emails(suggest(index, 'bob@ex', none))).toEqual(['bob@example.test']);
  });

  it('requires every query word to match', () => {
    expect(emails(suggest(index, 'bob exam', none))).toEqual(['bob@example.test']);
    expect(suggest(index, 'bob nguyen', none)).toEqual([]);
  });

  it('does not match in the middle of a token', () => {
    expect(suggest(index, 'xample', none)).toEqual([]);
  });

  it('ranks people written to first, then newest, then most frequent, then by address', () => {
    const ranked = indexOf(
      person('a@t.test', '', 0, 9, '2026-09-30T00:00:00Z'), // never written to: last tier
      person('b@t.test', '', 1, 0, '2026-09-01T00:00:00Z'), // written to, oldest
      person('c@t.test', '', 1, 0, '2026-09-05T00:00:00Z'), // written to, newest, fewer contacts
      person('d@t.test', '', 3, 0, '2026-09-05T00:00:00Z'), // written to, newest, more contacts
      person('e@t.test', '', 3, 0, '2026-09-05T00:00:00Z'), // tie with d: address order
    );
    expect(emails(suggest(ranked, 't.test', none))).toEqual(['d@t.test', 'e@t.test', 'c@t.test', 'b@t.test', 'a@t.test']);
  });

  it('leaves out excluded addresses and respects the limit', () => {
    expect(emails(suggest(index, 'b', { exclude: new Set(['bob@example.test']), limit: 6 }))).toEqual(['ci@builds.test']);
    expect(suggest(index, 'test', { exclude: new Set(), limit: 2 })).toHaveLength(2);
  });
});

describe('parseRecipientCache', () => {
  it('accepts a well-formed cache', () => {
    const cache = { index: indexOf(person('bob@example.test', 'Bob', 1, 0, '2026-09-01T00:00:00Z')), counted: ['e1'] };
    expect(parseRecipientCache(cache)).toEqual(cache);
  });

  it('rejects anything else', () => {
    for (const bad of [undefined, null, 'x', 42, [], {}, { index: {} }, { index: [], counted: [] }, { index: {}, counted: 'e1' }, { index: { a: { email: 'a@b.test' } }, counted: [] }, { index: {}, counted: [1] }]) {
      expect(parseRecipientCache(bad)).toBeUndefined();
    }
  });
});

describe('field helpers', () => {
  it('toAddress turns an empty name into null', () => {
    expect(toAddress(person('zed@nowhere.test', '', 0, 1, ''))).toEqual({ name: null, email: 'zed@nowhere.test' });
    expect(toAddress(person('bob@example.test', 'Bob Example', 1, 0, ''))).toEqual(bob);
  });

  it('completeAddress accepts exactly one address', () => {
    expect(completeAddress('bob@example.test')).toEqual({ name: null, email: 'bob@example.test' });
    expect(completeAddress('Bob Example <bob@example.test>')).toEqual(bob);
    expect(completeAddress('bo')).toBeNull();
    expect(completeAddress('')).toBeNull();
    expect(completeAddress('a@x.test, b@y.test')).toBeNull();
  });

  it('addUnique appends new people, compares addresses without case, and never re-parses names', () => {
    const sam = { name: 'Roe, Sam', email: 'sam@nowhere.test' };
    const list = addUnique([bob], [{ name: null, email: 'BOB@example.test' }, sam, sam]);
    expect(list).toEqual([bob, sam]);
  });

  it('addUnique returns a new array', () => {
    const before = [bob];
    expect(addUnique(before, [])).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/mail/recipients.test.ts`
Expected: FAIL, "Failed to resolve import "./recipients"".

- [ ] **Step 3: Write the implementation**

Create `src/mail/recipients.ts`:

```ts
// Recipient suggestions from mail history: a per-address contact count and its ranking.
// Pure: no Solid, no JMAP.
import type { EmailAddress } from '../jmap/types';
import { parseAddressList } from './compose';

export interface Recipient {
  /** As first seen, original case. */
  email: string;
  /** The most recent non-empty display name, else ''. */
  name: string;
  /** Messages the user sent to this address. */
  sent: number;
  /** Messages received from this address. */
  received: number;
  /** ISO time of the most recent contact in either direction. */
  last: string;
}

/** Keyed by the lower-cased address. */
export type RecipientIndex = Record<string, Recipient>;
export type ContactKind = 'sent' | 'received';

/** What is kept in IndexedDB: the index and the ids of the emails already counted into it. */
export interface RecipientCache {
  index: RecipientIndex;
  counted: string[];
}

const ROBOT = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+\-.].*)?$/i;

const mailbox = (email: string) => email.slice(0, email.lastIndexOf('@'));
const domain = (email: string) => email.slice(email.lastIndexOf('@') + 1);

export function isRobot(email: string): boolean {
  return ROBOT.test(mailbox(email));
}

/**
 * Count one contact with each address of one message. Mutates and returns `index`.
 * Robots and malformed addresses are skipped; an address listed twice counts once.
 */
export function add(index: RecipientIndex, addresses: EmailAddress[], kind: ContactKind, at: string): RecipientIndex {
  const seen = new Set<string>();
  for (const a of addresses) {
    const email = a.email.trim();
    const key = email.toLowerCase();
    if (key.lastIndexOf('@') < 1 || !domain(key) || isRobot(key) || seen.has(key)) continue;
    seen.add(key);
    const cur = (index[key] ??= { email, name: '', sent: 0, received: 0, last: '' });
    cur[kind] += 1;
    const name = a.name?.trim() ?? '';
    if (name && (at >= cur.last || !cur.name)) cur.name = name;
    if (at > cur.last) cur.last = at;
  }
  return index;
}

/** Best first: people written to, then the most recent contact, then the most frequent. */
export function compareRecipients(a: Recipient, b: Recipient): number {
  return (
    Number(b.sent > 0) - Number(a.sent > 0) ||
    (a.last === b.last ? 0 : a.last < b.last ? 1 : -1) ||
    b.sent + b.received - (a.sent + a.received) ||
    (a.email === b.email ? 0 : a.email < b.email ? -1 : 1)
  );
}

function tokens(r: Recipient): string[] {
  const email = r.email.toLowerCase();
  const local = mailbox(email);
  const labels = domain(email).split('.');
  return [
    ...r.name.toLowerCase().split(/[^\p{L}\p{N}]+/u),
    local,
    ...local.split(/[._+-]/),
    ...labels.map((_, i) => labels.slice(i).join('.')),
    email,
  ].filter(Boolean);
}

/** People matching `query`: every query word must be a prefix of one of the person's tokens. */
export function suggest(index: RecipientIndex, query: string, opts: { exclude: Set<string>; limit: number }): Recipient[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: Recipient[] = [];
  for (const [key, r] of Object.entries(index)) {
    if (opts.exclude.has(key)) continue;
    const t = tokens(r);
    if (words.every((w) => t.some((x) => x.startsWith(w)))) out.push(r);
  }
  return out.sort(compareRecipients).slice(0, opts.limit);
}

/** A stored cache, if it has the shape this version writes; anything else is ignored. */
export function parseRecipientCache(value: unknown): RecipientCache | undefined {
  const c = value as Partial<RecipientCache> | null | undefined;
  if (!c || typeof c !== 'object' || !c.index || typeof c.index !== 'object' || Array.isArray(c.index)) return undefined;
  if (!Array.isArray(c.counted) || !c.counted.every((id) => typeof id === 'string')) return undefined;
  const ok = Object.values(c.index).every(
    (r) => r && typeof r.email === 'string' && typeof r.name === 'string' && typeof r.sent === 'number' && typeof r.received === 'number' && typeof r.last === 'string',
  );
  return ok ? { index: c.index, counted: c.counted } : undefined;
}

export function toAddress(r: Recipient): EmailAddress {
  return { name: r.name || null, email: r.email };
}

/** The address `text` spells out, if it is exactly one. */
export function completeAddress(text: string): EmailAddress | null {
  const parsed = parseAddressList(text);
  return parsed.length === 1 ? parsed[0]! : null;
}

/** `list` followed by the people in `more` it doesn't hold yet (addresses compared without case). */
export function addUnique(list: EmailAddress[], more: EmailAddress[]): EmailAddress[] {
  const seen = new Set(list.map((a) => a.email.toLowerCase()));
  const out = [...list];
  for (const a of more) {
    const key = a.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/mail/recipients.test.ts`
Expected: PASS, all tests green.

Run: `pnpm typecheck`
Expected: exits 0 with no output after `$ tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add src/mail/recipients.ts src/mail/recipients.test.ts
git commit -m "Add the recipient index: contact counts, matching and ranking"
```

---

### Task 2: Engine hooks and the cache functions

**Files:**
- Modify: `src/sync/engine.ts` (the `onPersist` field near line 94; `hydrate` near line 141; add `sentRecipients` after `sendDraft` near line 446; `mergeEmails` near line 718)
- Modify: `src/cache/persist.ts`
- Test: `src/sync/engine.test.ts`

**Interfaces:**
- Consumes: `RecipientCache`, `parseRecipientCache` from Task 1.
- Produces:
  - `MailEngine.onEmails: ((emails: Partial<Email>[]) => void) | null` — called with every batch of emails merged into the store, and with the emails of an applied snapshot.
  - `MailEngine.sentRecipients(limit: number): Promise<Partial<Email>[]>` — `id`, `to`, `cc`, `bcc`, `receivedAt` of the newest `limit` messages in the Sent mailbox; `[]` without a request when there is no Sent mailbox.
  - `loadRecipients(username: string): Promise<RecipientCache | undefined>` and `saveRecipients(username: string, cache: RecipientCache): Promise<void>` in `src/cache/persist.ts`; `clearCache(username)` also deletes the stored value.

- [ ] **Step 1: Write the failing tests**

Append to `src/sync/engine.test.ts`, inside the top-level `describe('MailEngine', …)` block, before its closing `});`:

```ts
  it('reports merged emails through onEmails', async () => {
    const seen = new Set<string>();
    engine.onEmails = (emails) => emails.forEach((e) => seen.add(e.id!));
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    expect([...seen].sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('reports the emails of an applied snapshot through onEmails', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    const snap = engine.snapshot();
    const fresh = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    const seen: string[] = [];
    fresh.onEmails = (emails) => seen.push(...emails.map((e) => e.id!));
    expect(fresh.hydrate(snap)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.sort()).toEqual(Object.keys(snap.emails).sort());
  });

  it('reads the recipients of the newest Sent messages in one request', async () => {
    const to = [{ name: 'Bob Example', email: 'bob@example.test' }];
    const cc = [{ name: null, email: 'carol@partner.test' }];
    server.addEmail({ id: 's1', threadId: 't9', receivedAt: '2026-09-03T00:00:00Z', mailboxIds: { S: true }, to, cc }, false);
    server.calls = [];
    const list = await engine.sentRecipients(1);
    expect(server.calls).toEqual(['Email/query', 'Email/get']);
    // limit 1: only the newest Sent message, not the older e2.
    expect(list).toEqual([{ id: 's1', receivedAt: '2026-09-03T00:00:00Z', to, cc }]);
  });

  it('skips the Sent scan when the account has no Sent mailbox', async () => {
    const bare = new FakeJmap();
    bare.addMailbox('I', 'Inbox', 'inbox');
    const e = createRoot(() => new MailEngine(bare.client(), { settleDelayMs: 0 }));
    await e.start();
    bare.calls = [];
    expect(await e.sentRecipients(500)).toEqual([]);
    expect(bare.calls).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/sync/engine.test.ts`
Expected: FAIL. The two `onEmails` tests fail on their assertions (nothing is reported); the two `sentRecipients` tests fail with "engine.sentRecipients is not a function" (and `tsc` would reject `onEmails`).

- [ ] **Step 3: Add `onEmails` to the engine**

In `src/sync/engine.ts`, directly below the line `onPersist: ((s: Snapshot) => void) | null = null;`, add:

```ts
  /** Called with every batch of emails merged into the store (the recipient index listens). */
  onEmails: ((emails: Partial<Email>[]) => void) | null = null;
```

In `hydrate`, replace:

```ts
      queries: snap.queries,
      ready: true,
    });
    return true;
```

with:

```ts
      queries: snap.queries,
      ready: true,
    });
    this.onEmails?.(Object.values(snap.emails));
    return true;
```

In `mergeEmails`, replace:

```ts
        if (!cur) m[id] = { ...e, id };
        else Object.assign(cur, e);
      }
    }));
  }
```

with:

```ts
        if (!cur) m[id] = { ...e, id };
        else Object.assign(cur, e);
      }
    }));
    this.onEmails?.(list);
  }
```

- [ ] **Step 4: Add `sentRecipients` to the engine**

In `src/sync/engine.ts`, directly after the closing brace of `sendDraft` (before the `ensureMailbox` doc comment), add:

```ts
  /** To, Cc and Bcc of the newest `limit` messages in Sent, for the recipient index. */
  async sentRecipients(limit: number): Promise<Partial<Email>[]> {
    const sent = this.mailboxByRole('sent')?.id;
    if (!sent) return [];
    const accountId = this.accountId;
    const b = this.client.batch();
    const q = b.call('Email/query', { accountId, filter: { inMailbox: sent }, sort: DEFAULT_SORT, limit });
    const g = b.call('Email/get', { accountId, '#ids': q.ref('/ids'), properties: ['to', 'cc', 'bcc', 'receivedAt'] });
    return (await this.client.send(b)).get(g).list;
  }
```

- [ ] **Step 5: Run the engine tests to verify they pass**

Run: `pnpm exec vitest run src/sync/engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the cache functions**

In `src/cache/persist.ts`, add to the imports at the top:

```ts
import { parseRecipientCache, type RecipientCache } from '../mail/recipients';
```

Replace the `clearCache` function with:

```ts
export async function clearCache(username: string): Promise<void> {
  localStorage.removeItem(SESSION_KEY);
  const s = idb();
  if (!s) return;
  await del(`snap:${username}`, s).catch(() => undefined);
  await del(`recipients:${username}`, s).catch(() => undefined);
}

export async function loadRecipients(username: string): Promise<RecipientCache | undefined> {
  const s = idb();
  if (!s) return undefined;
  try {
    return parseRecipientCache(await get<unknown>(`recipients:${username}`, s));
  } catch {
    return undefined;
  }
}

export async function saveRecipients(username: string, cache: RecipientCache): Promise<void> {
  const s = idb();
  if (!s) return;
  try {
    await set(`recipients:${username}`, cache, s);
  } catch {
    // Ignore: best effort.
  }
}
```

(`persist.ts` has no unit tests because jsdom has no IndexedDB; the shape check it relies on, `parseRecipientCache`, is tested in Task 1, and the store that calls these functions is tested in Task 3 with them mocked.)

- [ ] **Step 7: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exits 0; all unit tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/sync/engine.ts src/sync/engine.test.ts src/cache/persist.ts
git commit -m "Report merged emails from the engine; add the Sent recipient scan and the recipient cache"
```

---

### Task 3: The recipient store

**Files:**
- Create: `src/app/recipients.ts`
- Test: `src/app/recipients.test.ts`

**Interfaces:**
- Consumes: Task 1 (`add`, `compareRecipients`, `suggest`, types); Task 2 (`MailEngine.onEmails`, `MailEngine.sentRecipients`, `loadRecipients`, `saveRecipients`); `MailEngine.myAddresses(): Set<string>` (lower-cased addresses of the user).
- Produces:
  - `createRecipients(engine: MailEngine, opts?: { saveDelayMs?: number }): Recipients`
  - `interface Recipients { suggest(query: string, exclude: Set<string>): Recipient[]; recordSent(emailId: string, addresses: EmailAddress[]): void; start(username: string): Promise<void>; scanSent(): Promise<void>; stop(): void }`
  - `suggest` is reactive: it reads a Solid signal that changes whenever the index does. `exclude` holds lower-cased addresses.

- [ ] **Step 1: Write the failing tests**

Create `src/app/recipients.test.ts`:

```ts
import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRecipients, saveRecipients } from '../cache/persist';
import { DEFAULT_SORT, MailEngine } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import { createRecipients } from './recipients';

vi.mock('../cache/persist', () => ({
  loadRecipients: vi.fn(async () => undefined),
  saveRecipients: vi.fn(async () => undefined),
}));

const ME = 'alice@example.test';
const bob = { name: 'Bob Example', email: 'bob@example.test' };
const inbox = { filter: { inMailbox: 'I' }, sort: DEFAULT_SORT, collapseThreads: true };
const nobody = new Set<string>();

function setup() {
  const server = new FakeJmap();
  server.addMailbox('I', 'Inbox', 'inbox');
  server.addMailbox('S', 'Sent', 'sent');
  // Sent: alice wrote to Bob (also cc'd, to check he counts once) and Dana.
  server.addEmail({
    id: 's1', threadId: 't1', receivedAt: '2026-09-02T10:00:00Z', mailboxIds: { S: true },
    from: [{ name: 'Alice', email: ME }], to: [bob], cc: [{ name: null, email: 'BOB@example.test' }, { name: 'Dana', email: 'dana@example.test' }],
  }, false);
  // Inbox: Carol wrote to alice.
  server.addEmail({ id: 'r1', threadId: 't2', receivedAt: '2026-09-03T10:00:00Z', mailboxIds: { I: true }, from: [{ name: 'Carol Nguyen', email: 'carol@partner.test' }] }, false);
  const engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
  const store = createRecipients(engine, { saveDelayMs: 0 });
  return { server, engine, store };
}

async function openInbox(engine: MailEngine) {
  const key = engine.openQuery(inbox);
  await engine.ensureRange(key, 0, 10);
}

describe('createRecipients', () => {
  beforeEach(() => {
    vi.mocked(loadRecipients).mockReset().mockResolvedValue(undefined);
    vi.mocked(saveRecipients).mockReset().mockResolvedValue(undefined);
  });

  it('fills the index from the Sent scan, counting a person once per message', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await store.scanSent();
    expect(store.suggest('bob', nobody)).toEqual([{ email: 'bob@example.test', name: 'Bob Example', sent: 1, received: 0, last: '2026-09-02T10:00:00Z' }]);
    expect(store.suggest('dan', nobody).map((r) => r.email)).toEqual(['dana@example.test']);
  });

  it('adds the senders of merged emails', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await openInbox(engine);
    expect(store.suggest('car', nobody)).toEqual([{ email: 'carol@partner.test', name: 'Carol Nguyen', sent: 0, received: 1, last: '2026-09-03T10:00:00Z' }]);
  });

  it('counts an email once across a scan, a repeated scan, a merge, a reload and recordSent', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await store.scanSent();
    await store.scanSent();
    store.recordSent('s1', [bob]);
    await openInbox(engine);
    await openInbox(engine);
    await engine.loadThread('t2');
    expect(store.suggest('bob', nobody)[0]!.sent).toBe(1);
    expect(store.suggest('car', nobody)[0]!.received).toBe(1);
  });

  it('skips the user\'s own addresses and drafts', async () => {
    const { server, engine, store } = setup();
    server.addEmail({ id: 'm1', threadId: 't3', receivedAt: '2026-09-04T10:00:00Z', mailboxIds: { I: true }, from: [{ name: 'Alice', email: ME }] }, false);
    server.addEmail({ id: 'd1', threadId: 't4', receivedAt: '2026-09-04T11:00:00Z', mailboxIds: { I: true }, keywords: { $draft: true }, from: [{ name: 'Dave', email: 'dave@partner.test' }] }, false);
    await engine.start();
    await store.start(ME);
    await openInbox(engine);
    store.recordSent('x1', [{ name: 'Alice', email: ME }]);
    expect(store.suggest('ali', nobody)).toEqual([]);
    expect(store.suggest('dav', nobody)).toEqual([]);
  });

  it('leaves out excluded addresses', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await store.scanSent();
    expect(store.suggest('bob', new Set(['bob@example.test']))).toEqual([]);
  });

  it('holds back emails reported before the cache has loaded, then counts them once', async () => {
    vi.mocked(loadRecipients).mockResolvedValue({
      index: { 'carol@partner.test': { email: 'carol@partner.test', name: 'Carol Nguyen', sent: 0, received: 1, last: '2026-09-03T10:00:00Z' } },
      counted: ['r1'],
    });
    const { engine, store } = setup();
    await engine.start();
    await openInbox(engine); // reports r1 before the cache is loaded
    expect(store.suggest('car', nobody)).toEqual([]);
    await store.start(ME);
    expect(store.suggest('car', nobody)[0]!.received).toBe(1);
  });

  it('counts emails reported before the cache has loaded when the cache does not know them', async () => {
    const { engine, store } = setup();
    await engine.start();
    await openInbox(engine);
    await store.start(ME);
    expect(store.suggest('car', nobody)[0]!.received).toBe(1);
  });

  it('stays usable when the scan fails', async () => {
    const { engine, store } = setup();
    vi.spyOn(engine, 'sentRecipients').mockRejectedValueOnce(new Error('boom'));
    await engine.start();
    await store.start(ME);
    await expect(store.scanSent()).rejects.toThrow('boom');
    store.recordSent('n1', [{ name: 'Eve', email: 'eve@example.test' }]);
    expect(store.suggest('eve', nobody).map((r) => r.email)).toEqual(['eve@example.test']);
  });

  it('saves the index and the counted ids under the username', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await store.scanSent();
    await vi.waitFor(() => expect(saveRecipients).toHaveBeenCalled());
    const [user, cache] = vi.mocked(saveRecipients).mock.calls.at(-1)!;
    expect(user).toBe(ME);
    expect(Object.keys(cache.index).sort()).toEqual(['bob@example.test', 'dana@example.test']);
    expect(cache.counted).toContain('s1');
  });

  it('does not save after stop()', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    store.stop();
    store.recordSent('n1', [bob]);
    await new Promise((r) => setTimeout(r, 20));
    expect(saveRecipients).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/app/recipients.test.ts`
Expected: FAIL, "Failed to resolve import "./recipients"".

- [ ] **Step 3: Write the implementation**

Create `src/app/recipients.ts`:

```ts
import { batch, createSignal } from 'solid-js';
import { loadRecipients, saveRecipients } from '../cache/persist';
import type { EmailAddress } from '../jmap/types';
import { add, compareRecipients, suggest as rank, type ContactKind, type Recipient, type RecipientCache, type RecipientIndex } from '../mail/recipients';
import type { MailEngine } from '../sync/engine';

const SUGGESTIONS = 6;
const SCAN_LIMIT = 500;
const MAX_ENTRIES = 2000;
const MAX_COUNTED = 5000;
const SAVE_MS = 5000;

export interface Recipients {
  /** Reactive. `exclude` holds lower-cased addresses. */
  suggest(query: string, exclude: Set<string>): Recipient[];
  /** The recipients of a message that was just sent. */
  recordSent(emailId: string, addresses: EmailAddress[]): void;
  /** Load the user's cached index; emails reported earlier are counted once it is in. */
  start(username: string): Promise<void>;
  /** Read the recipients of recent Sent mail. Rejects if the request fails. */
  scanSent(): Promise<void>;
  stop(): void;
}

/** Recipient suggestions from mail history: Sent recipients, senders of synced mail, and messages just sent. */
export function createRecipients(engine: MailEngine, opts: { saveDelayMs?: number } = {}): Recipients {
  const index: RecipientIndex = {};
  /** Ids of emails already counted, oldest first. */
  const counted = new Set<string>();
  const [version, setVersion] = createSignal(0);
  const saveDelayMs = opts.saveDelayMs ?? SAVE_MS;
  let username: string | null = null;
  /** Work that arrived before the cache was loaded; null once it is. */
  let pending: (() => void)[] | null = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const snapshot = (): RecipientCache => ({
    index: Object.fromEntries(
      Object.values(index).sort(compareRecipients).slice(0, MAX_ENTRIES).map((r) => [r.email.toLowerCase(), r]),
    ),
    counted: [...counted].slice(-MAX_COUNTED),
  });

  const saveSoon = () => {
    if (stopped || saveTimer || !username) return;
    const user = username;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!stopped) void saveRecipients(user, snapshot());
    }, saveDelayMs);
  };

  const whenLoaded = (fn: () => void) => {
    if (pending) pending.push(fn);
    else fn();
  };

  const count = (emailId: string, addresses: EmailAddress[], kind: ContactKind, at: string) => {
    if (counted.has(emailId)) return;
    counted.add(emailId);
    const me = engine.myAddresses();
    add(index, addresses.filter((a) => !me.has(a.email.toLowerCase())), kind, at);
    setVersion((v) => v + 1);
    saveSoon();
  };

  engine.onEmails = (emails) =>
    whenLoaded(() =>
      batch(() => {
        const me = engine.myAddresses();
        for (const e of emails) {
          const from = e.from?.[0];
          // The user's own mail is counted by its recipients (the Sent scan), not by its sender.
          if (!e.id || !from || !e.receivedAt || e.keywords?.$draft || me.has(from.email.toLowerCase())) continue;
          count(e.id, [from], 'received', e.receivedAt);
        }
      }),
    );

  return {
    suggest: (query, exclude) => {
      version();
      if (!query.trim()) return [];
      return rank(index, query, { exclude: new Set([...exclude, ...engine.myAddresses()]), limit: SUGGESTIONS });
    },
    recordSent: (emailId, addresses) => whenLoaded(() => count(emailId, addresses, 'sent', new Date().toISOString())),
    start: async (user) => {
      username = user;
      const cache = await loadRecipients(user);
      if (cache) {
        Object.assign(index, cache.index);
        for (const id of cache.counted) counted.add(id);
      }
      const queued = pending ?? [];
      pending = null;
      for (const fn of queued) fn();
      setVersion((v) => v + 1);
    },
    scanSent: async () => {
      const emails = await engine.sentRecipients(SCAN_LIMIT);
      whenLoaded(() =>
        batch(() => {
          for (const e of emails) {
            if (e.id && e.receivedAt) count(e.id, [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])], 'sent', e.receivedAt);
          }
        }),
      );
    },
    stop: () => {
      stopped = true;
      if (saveTimer) clearTimeout(saveTimer);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/app/recipients.test.ts`
Expected: PASS, 10 tests.

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exits 0; all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/recipients.ts src/app/recipients.test.ts
git commit -m "Add the recipient store: Sent scan, senders of merged mail, cache, suggestions"
```

---

### Task 4: Wire the store into the app

**Files:**
- Modify: `src/app/context.tsx` (the `App` interface)
- Modify: `src/app/composer.ts` (`createComposers` signature near line 33; the send timer near line 204)
- Modify: `src/index.tsx`

**Interfaces:**
- Consumes: `createRecipients`, `Recipients` from Task 3.
- Produces: `App.recipients: Recipients` (read by Task 5 through `useApp()`); `createComposers(engine, client, toast, confirm, onSent)` where `onSent: (emailId: Id, recipients: EmailAddress[]) => void` is called after a message has been sent.

This task has no unit test of its own: there is no test harness for `createComposers` or `index.tsx`, and the store's behaviour is covered in Task 3. The wiring is checked by `tsc` here and exercised end to end in Task 5 (the "just wrote to" test fails if `onSent` is not called; every suggestion test fails if `start`/`scanSent` are not called).

- [ ] **Step 1: Add `recipients` to the app context**

In `src/app/context.tsx`, add to the imports:

```ts
import type { Recipients } from './recipients';
```

In the `App` interface, directly below `composers: Composers;`, add:

```ts
  recipients: Recipients;
```

- [ ] **Step 2: Report sent messages from the composer**

In `src/app/composer.ts`, change the import of JMAP types from:

```ts
import type { Id, Identity } from '../jmap/types';
```

to:

```ts
import type { EmailAddress, Id, Identity } from '../jmap/types';
```

Replace the `createComposers` signature:

```ts
export function createComposers(engine: MailEngine, client: JmapClient, toast: ToastFn, confirm: ConfirmFn) {
```

with:

```ts
export function createComposers(
  engine: MailEngine,
  client: JmapClient,
  toast: ToastFn,
  confirm: ConfirmFn,
  /** Called once a message has been submitted, with everyone it went to. */
  onSent: (emailId: Id, recipients: EmailAddress[]) => void,
) {
```

In `send`, replace:

```ts
        await engine.sendDraft(draftId, identityId);
        toast('Message sent.', 'success');
```

with:

```ts
        await engine.sendDraft(draftId, identityId);
        onSent(draftId, [...d.to, ...d.cc, ...d.bcc]);
        toast('Message sent.', 'success');
```

- [ ] **Step 3: Create and start the store in `index.tsx`**

In `src/index.tsx`, add to the imports (keep them in the file's alphabetical order):

```ts
import { createRecipients } from './app/recipients';
```

Replace:

```ts
  const engine = new MailEngine(client);
```

with:

```ts
  const engine = new MailEngine(client);
  // Before the warm-start snapshot is applied, so it sees every email.
  const recipients = createRecipients(engine);
```

Replace the `signOut` function:

```ts
  const signOut = () => {
    const user = client.hasSession ? client.session.username : null;
    auth.signOut();
    void (user ? clearCache(user) : Promise.resolve()).finally(() => location.assign('/'));
  };
```

with:

```ts
  const signOut = () => {
    const user = client.hasSession ? client.session.username : null;
    auth.signOut();
    recipients.stop();
    void (user ? clearCache(user) : Promise.resolve()).finally(() => location.assign('/'));
  };
```

In the `app` object, replace:

```ts
    composers: createComposers(engine, client, toasts.toast, confirmDialog.confirm),
```

with:

```ts
    composers: createComposers(engine, client, toasts.toast, confirmDialog.confirm, recipients.recordSent),
    recipients,
```

In `start`, replace:

```ts
    engine.onPersist = (snap) => void saveSnapshot(session.username, snap);
    await engine.start();
    void calendar.loadCalendars().catch((e) => onAuthError(e));
```

with:

```ts
    engine.onPersist = (snap) => void saveSnapshot(session.username, snap);
    void recipients.start(session.username);
    await engine.start();
    void calendar.loadCalendars().catch((e) => onAuthError(e));
    // Suggestions are a convenience: a failed scan is dropped unless it is an auth failure.
    void recipients.scanSent().catch((e) => onAuthError(e));
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: typecheck exits 0; all unit tests pass; the build prints `✓ built in …`.

Run: `E2E_SKIP_SEED=1 pnpm exec playwright test compose`
Expected: 7 passed (the setup test plus the six composer tests); nothing in the composer has changed for the user yet.

- [ ] **Step 5: Commit**

```bash
git add src/app/context.tsx src/app/composer.ts src/index.tsx
git commit -m "Start the recipient store with the app and record the recipients of sent mail"
```

---

### Task 5: The recipient field on rozie Combobox

**Files:**
- Create: `src/ui/RecipientField.tsx`
- Modify: `src/ui/ComposerView.tsx` (imports; the local `RecipientField` function, lines 11–30; the root `onKeyDown`; the three field usages)
- Modify: `src/ui/styles.css` (the `--rozie-tags-*` tokens near line 275; new rules after `.compose-field` rules near line 248)
- Modify: `e2e/support/compose.ts` (two locators, one new one)
- Modify: `e2e/compose.spec.ts` (five new tests appended)
- Modify: `package.json`, `pnpm-lock.yaml` (remove `@rozie-ui/tags-solid`)
- Modify: `docs/rozie-feedback.md`, `README.md`, `e2e/README.md`

**Interfaces:**
- Consumes: `useApp().recipients.suggest(query, exclude)` (Task 3/4); `addUnique`, `completeAddress`, `toAddress`, `Recipient` (Task 1); `formatAddress`, `parseAddressList` from `src/mail/compose.ts`; `Combobox`, `ComboboxHandle` from `@rozie-ui/combobox-solid`.
- Produces: `RecipientField(props: { id: string; label: 'To' | 'Cc' | 'Bcc'; value: EmailAddress[]; others: EmailAddress[]; onChange: (v: EmailAddress[]) => void })` and `closedSuggestions(e: Event): boolean`.

What you need to know about Combobox 0.6.0 (read from `node_modules/@rozie-ui/combobox-solid/dist/source/index.jsx`):

- In `multiple` mode `value` is an array of option values and each value renders a chip (`li.rozie-combobox-chip`); Backspace in an empty input removes the last one. Picking or removing fires `onChange({ value, option, selected })` where `value` is the new array.
- With `disableFilter` the `options` are rendered as given. Each keystroke fires `onSearch({ query })` and highlights the first option. Enter picks the highlighted option and calls `preventDefault()`.
- The handle has `seedQuery(text)`, which sets the input text, and `focus()`.
- The list is rendered inside the component (no portal), as `ul.rozie-combobox-list[role=listbox]` with `li.rozie-combobox-option[role=option]` children whose ids are `idBase + "-opt-" + index`. The input is `input[role=combobox]` and carries `aria-activedescendant`.
- It has no support for: committing on `,` or `;`, pasting several values, Tab to pick, staying closed when there are no options (it opens on focus and renders "No results"), or telling the host whether Escape closed anything (it consumes Escape whenever the input has focus). The field adds these from outside, as below.
- Its `on*` props are typed `(...args: unknown[]) => void`; cast the payload, as `src/ui/Overlays.tsx` does for CommandPalette.
- Solid delegates `keydown`, so the Combobox input's handler runs first and the field wrapper's `onKeyDown` after it, on the same event.

- [ ] **Step 1: Point the e2e helpers at the new markup and add the failing tests**

In `e2e/support/compose.ts`, replace:

```ts
export const recipientInput = (c: Locator, field: 'To' | 'Cc' | 'Bcc' = 'To') => c.getByRole('textbox', { name: field, exact: true });
export const recipientChips = (c: Locator, field: 'To' | 'Cc' | 'Bcc' = 'To') =>
  c.getByRole('group', { name: field, exact: true }).locator('.rozie-tags-chip');
```

with:

```ts
export const recipientInput = (c: Locator, field: 'To' | 'Cc' | 'Bcc' = 'To') => c.getByRole('combobox', { name: field, exact: true });
export const recipientChips = (c: Locator, field: 'To' | 'Cc' | 'Bcc' = 'To') =>
  c.getByRole('group', { name: field, exact: true }).locator('.rozie-combobox-chip');
/** The visible suggestion rows (only the field being typed in shows a list). */
export const suggestions = (c: Locator) => c.getByRole('option');
```

In `e2e/compose.spec.ts`, add `suggestions` and `recipientInput` to the import from `./support/compose` (keep the list alphabetical), then append these tests to the end of the file. Each test fills the subject first, so the draft the composer autosaves is found and deleted by the existing `afterEach`.

```ts
/** A floating composer with only the subject filled in. */
async function openComposer(page: import('@playwright/test').Page, subject: string) {
  await openInbox(page);
  await page.getByRole('button', { name: 'Compose' }).click();
  const c = floatingComposer(page);
  await expect(c).toBeVisible();
  await subjectInput(c).fill(subject);
  return c;
}

test('typing part of a name suggests a correspondent; Enter adds them and the message arrives', async ({ page }) => {
  const subject = newSubject();
  const c = await openComposer(page, subject);
  const to = recipientInput(c);
  await to.pressSequentially('bo');
  const bob = suggestions(c).filter({ hasText: BOB });
  await expect(bob).toBeVisible();
  await expect(bob).toContainText('Bob Example');
  // Alice has written to Bob, so he outranks "CI Bot", who has only written to her.
  await expect(suggestions(c).first()).toContainText(BOB);

  await to.press('Enter');
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(recipientChips(c)).toContainText(`Bob Example <${BOB}>`);
  await expect(to).toHaveValue('');
  await expect(suggestions(c)).toHaveCount(0);

  await typeBody(c, 'Picked from the list.');
  await sendAndWait(page, c);
  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  expect((await emailDetails(received.id, BOB)).to).toEqual([{ name: 'Bob Example', email: BOB }]);
});

test('people alice has written to rank first; ArrowDown and Enter pick the second; a chosen person is not offered again', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  const to = recipientInput(c);
  await to.pressSequentially('partner');
  // The seed has five people at partner.test; alice has written to Carol and Dave only.
  await expect(suggestions(c)).toHaveCount(5);
  const listed = () => suggestions(c).locator('.rcpt-option').evaluateAll((els) => els.map((el) => el.getAttribute('data-email')!));
  // Poll: senders are known as soon as the inbox has loaded, the Sent scan lands a moment later.
  await expect.poll(async () => (await listed()).slice(0, 2).sort()).toEqual(['carol@partner.test', 'dave@partner.test']);
  const order = await listed();
  expect(order.slice(2).sort()).toEqual(['frank@partner.test', 'grace@partner.test', 'heidi@partner.test']);

  await to.press('ArrowDown');
  await to.press('Enter');
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(recipientChips(c)).toContainText(order[1]!);

  await c.getByRole('button', { name: 'Cc/Bcc' }).click();
  const cc = recipientInput(c, 'Cc');
  await cc.pressSequentially('partner');
  await expect(suggestions(c)).toHaveCount(4);
  expect(await listed()).not.toContain(order[1]);
});

test('Tab picks the highlighted suggestion; Escape closes the list first and the composer second', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  const to = recipientInput(c);
  await to.pressSequentially('bo');
  await expect(suggestions(c).filter({ hasText: BOB })).toBeVisible();
  await to.press('Tab');
  await expect(recipientChips(c)).toContainText(BOB);
  await expect(to).toBeFocused();
  await expect(to).toHaveValue('');

  await to.pressSequentially('car');
  await expect(suggestions(c).filter({ hasText: 'carol@partner.test' })).toBeVisible();
  await to.press('Escape');
  await expect(suggestions(c)).toHaveCount(0);
  await expect(c).toBeVisible();
  await expect(to).toHaveValue('car');

  await to.press('Escape');
  await expect(c).toHaveCount(0);
});

test('someone alice just wrote to is suggested straight away', async ({ page }) => {
  // Stalwart delivers bob+anything@ to Bob, so this is a brand-new address that still arrives.
  const tag = uniqueTag('plus').replace(/[^a-z0-9]/g, '');
  const address = `bob+${tag}@example.test`;
  const first = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: address, subject: first, body: 'First contact.' });
  await sendAndWait(page, c);
  await deliveredCopy(first, BOB, await mailboxByRole('inbox', BOB));

  // The Sent scan ran once at page load, before this send: only recording the send can know the address.
  const again = await openComposer(page, newSubject());
  await recipientInput(again).pressSequentially(tag);
  await expect(suggestions(again)).toHaveCount(1);
  await expect(suggestions(again)).toContainText(address);
});

test('free text still works: a comma commits, a pasted list adds everyone, Backspace removes the last, leaving the field commits', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  const to = recipientInput(c);
  await to.pressSequentially('zed@nowhere.test,');
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(recipientChips(c)).toContainText('zed@nowhere.test');
  await expect(to).toHaveValue('');

  await to.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, 'Ann Lee <ann@nowhere.test>; "Roe, Sam" <sam@nowhere.test>');
  await expect(recipientChips(c)).toHaveCount(3);
  // A name with a comma stays one person.
  await expect(recipientChips(c).nth(2)).toContainText('Roe, Sam <sam@nowhere.test>');

  await to.press('Backspace');
  await expect(recipientChips(c)).toHaveCount(2);

  await to.pressSequentially('yan@nowhere.test');
  await subjectInput(c).click();
  await expect(recipientChips(c)).toHaveCount(3);
  await expect(recipientChips(c).nth(2)).toContainText('yan@nowhere.test');
});
```

- [ ] **Step 2: Run the composer spec to verify it fails**

Run: `pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test compose`
Expected: FAIL. Every test that adds a recipient times out waiting for `getByRole('combobox', { name: 'To' })`, because the field is still a Tags text box.

- [ ] **Step 3: Write the field**

Create `src/ui/RecipientField.tsx`:

```tsx
import { Combobox, type ComboboxHandle } from '@rozie-ui/combobox-solid';
import { createMemo, createSignal, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { EmailAddress } from '../jmap/types';
import { formatAddress, parseAddressList } from '../mail/compose';
import { addUnique, completeAddress, toAddress, type Recipient } from '../mail/recipients';

interface Option {
  value: string;
  label: string;
  recipient: Recipient;
}

const listEscapes = new WeakSet<Event>();
/** Whether this Escape keypress was used up closing a suggestion list. */
export const closedSuggestions = (e: Event): boolean => listEscapes.has(e);

/**
 * To/Cc/Bcc: chips plus a text input that suggests people from mail history.
 * rozie Combobox renders the chips and the list; committing typed or pasted addresses,
 * Tab-to-pick and "no list without suggestions" are added here (docs/rozie-feedback.md).
 */
export function RecipientField(props: {
  /** Unique on the page: Combobox derives its element ids from it. */
  id: string;
  label: 'To' | 'Cc' | 'Bcc';
  value: EmailAddress[];
  /** The draft's other recipients, which are not offered again. */
  others: EmailAddress[];
  onChange: (v: EmailAddress[]) => void;
}) {
  const { recipients } = useApp();
  const [text, setText] = createSignal('');
  const [dismissed, setDismissed] = createSignal(false);
  let handle: ComboboxHandle | undefined;
  let root: HTMLDivElement | undefined;

  const taken = () => new Set([...props.value, ...props.others].map((a) => a.email.toLowerCase()));
  const found = createMemo(() => (dismissed() ? [] : recipients.suggest(text(), taken())));
  const options = createMemo<Option[]>(() =>
    found().map((r) => ({ value: r.email, label: r.name ? `${r.name} ${r.email}` : r.email, recipient: r })),
  );

  const addAll = (more: EmailAddress[]) => {
    props.onChange(addUnique(props.value, more));
    setText('');
    handle?.seedQuery('');
  };
  const commitTyped = (): boolean => {
    const typed = completeAddress(text());
    if (typed) addAll([typed]);
    return !!typed;
  };
  /** Combobox doesn't expose its highlighted option; its input's aria-activedescendant names it. */
  const highlighted = (): Recipient | undefined => {
    const id = root?.querySelector('input')?.getAttribute('aria-activedescendant') ?? '';
    return found()[Number(id.slice(id.lastIndexOf('-') + 1))] ?? found()[0];
  };

  // Runs after Combobox's own handler for the same keypress.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (found().length) {
        setDismissed(true);
        listEscapes.add(e);
      }
    } else if (e.defaultPrevented) {
      // Combobox picked the highlighted suggestion (Enter).
    } else if (e.key === 'Enter') {
      commitTyped();
    } else if (e.key === 'Tab' && !e.shiftKey && found().length) {
      e.preventDefault();
      addAll([toAddress(highlighted()!)]);
    } else if (e.key === ',' || e.key === ';') {
      e.preventDefault();
      commitTyped();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const pasted = parseAddressList(e.clipboardData?.getData('text/plain') ?? '');
    // A fragment pasted into half-typed text is ordinary text; whole addresses become recipients.
    if (pasted.length > 1 || (pasted.length === 1 && !text())) {
      e.preventDefault();
      addAll(pasted);
    }
  };

  return (
    <div class="compose-field">
      <span class="compose-label">{props.label}</span>
      <div
        ref={(el) => {
          root = el;
          // paste is not one of Solid's delegated events.
          el.addEventListener('paste', onPaste);
        }}
        class="recipient-field"
        role="group"
        aria-label={props.label}
        onKeyDown={onKeyDown}
        onFocusOut={(e) => {
          if (!root?.contains(e.relatedTarget as Node | null)) commitTyped();
        }}
      >
        <Combobox
          ref={(h) => (handle = h)}
          multiple
          disableFilter
          idBase={props.id}
          ariaLabel={props.label}
          value={props.value.map((a) => a.email)}
          options={options()}
          onSearch={(...args: unknown[]) => {
            setText((args[0] as { query: string }).query);
            setDismissed(false);
          }}
          onChange={(...args: unknown[]) => {
            const e = args[0] as { value: string[]; option: Option | null; selected: boolean };
            if (e.selected && e.option) addAll([toAddress(e.option.recipient)]);
            else props.onChange(props.value.filter((a) => e.value.includes(a.email)));
          }}
          chipSlot={(chip) => (
            <Show when={props.value[chip.index]}>
              {(a) => (
                <>
                  <span class="rcpt-chip-label">{formatAddress(a())}</span>
                  <button
                    type="button"
                    class="rcpt-chip-remove"
                    aria-label={`Remove ${formatAddress(a())}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chip.remove()}
                  >
                    ×
                  </button>
                </>
              )}
            </Show>
          )}
          optionSlot={(o) => {
            const r = () => (o.option as Option).recipient;
            return (
              <span class="rcpt-option" data-email={r().email}>
                <span class="rcpt-name">{r().name || r().email}</span>
                <Show when={r().name}>
                  <span class="rcpt-email">{r().email}</span>
                </Show>
              </span>
            );
          }}
          emptySlot={() => null}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Use it in the composer**

In `src/ui/ComposerView.tsx`:

Delete the import `import { Tags } from '@rozie-ui/tags-solid';`.

Replace:

```ts
import type { EmailAddress } from '../jmap/types';
import { formatAddress, parseAddressList } from '../mail/compose';
```

with:

```ts
import { formatAddress } from '../mail/compose';
```

Add, below the `Icon` import:

```ts
import { closedSuggestions, RecipientField } from './RecipientField';
```

Delete the whole local `function RecipientField(…) { … }` (from `function RecipientField(props: { label: string; …` through its closing brace, lines 11–30).

In the root `onKeyDown`, replace:

```ts
        } else if (e.key === 'Escape' && !props.inline) {
```

with:

```ts
        } else if (e.key === 'Escape' && !props.inline && !closedSuggestions(e)) {
```

Replace:

```tsx
      <RecipientField label="To" value={d().to} onChange={(to) => c.update({ to })} />
```

with:

```tsx
      <RecipientField id={`rcpt-${c.id}-to`} label="To" value={d().to} others={[...d().cc, ...d().bcc]} onChange={(to) => c.update({ to })} />
```

Replace:

```tsx
        <RecipientField label="Cc" value={d().cc} onChange={(cc) => c.update({ cc })} />
        <RecipientField label="Bcc" value={d().bcc} onChange={(bcc) => c.update({ bcc })} />
```

with:

```tsx
        <RecipientField id={`rcpt-${c.id}-cc`} label="Cc" value={d().cc} others={[...d().to, ...d().bcc]} onChange={(cc) => c.update({ cc })} />
        <RecipientField id={`rcpt-${c.id}-bcc`} label="Bcc" value={d().bcc} others={[...d().to, ...d().cc]} onChange={(bcc) => c.update({ bcc })} />
```

- [ ] **Step 5: Style it**

In `src/ui/styles.css`, delete the ten `--rozie-tags-*` lines from the `:root` theme-bridge block (from `--rozie-tags-bg: transparent;` through `--rozie-tags-font: inherit;`).

Directly after the line that starts `.compose-field select, .compose-subject {`, add:

```css
/* Recipient fields: rozie Combobox, flat inside the compose row. */
.recipient-field {
  --rozie-combobox-width: 100%;
  --rozie-combobox-bg: transparent;
  --rozie-combobox-border-width: 0;
  --rozie-combobox-focus-ring-width: 0;
  --rozie-combobox-font: inherit;
  --rozie-combobox-chips-padding: 4px 0;
  --rozie-combobox-input-padding: 4px 0;
  --rozie-combobox-chip-bg: var(--chip);
  --rozie-combobox-chip-color: var(--text);
  --rozie-combobox-list-bg: var(--surface);
  --rozie-combobox-list-border-color: var(--border);
  --rozie-combobox-list-shadow: var(--shadow);
}
/* Combobox opens on focus and shows "No results"; a recipient field shows a list only when it has suggestions. */
.recipient-field .rozie-combobox-list:not(:has(.rozie-combobox-option)) { display: none; }
.rcpt-chip-remove { border: 0; background: none; padding: 0 2px; color: var(--text-2); font: inherit; cursor: pointer; }
.rcpt-option { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rcpt-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rcpt-email { color: var(--text-3); font-size: 12px; white-space: nowrap; }
```

- [ ] **Step 6: Run the composer spec to verify it passes**

Run: `pnpm typecheck && pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test compose`
Expected: PASS, 12 passed (setup, the six existing composer tests, the five new ones).

If a new test fails because Combobox behaves differently from the notes at the top of this task, do not switch components or weaken the test. Stop and report which behaviour differed; the spec makes the fallback (Tags with our own list) a decision for the user.

- [ ] **Step 7: Look at it**

The token values in Step 5 were chosen from the token names, without seeing them rendered. Take screenshots in both themes and read them.

Create a throwaway `e2e/zz-look.spec.ts`:

```ts
import { test } from '@playwright/test';
import { openInbox } from './support/app';
import { floatingComposer, recipientInput, subjectInput, suggestions } from './support/compose';

for (const theme of ['light', 'dark'] as const) {
  test(`look: ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('oinbox.theme', t), theme);
    await openInbox(page);
    await page.getByRole('button', { name: 'Compose' }).click();
    const c = floatingComposer(page);
    // A subject the suite's cleanup recognises, in case the draft autosaves before the page closes.
    await subjectInput(c).fill(`Compose test e2e-look-${theme}`);
    await recipientInput(c).pressSequentially('carol@partner.test,');
    await recipientInput(c).pressSequentially('partner');
    await suggestions(c).first().waitFor();
    await page.screenshot({ path: `test-results/look-${theme}.png` });
  });
}
```

Run: `E2E_SKIP_SEED=1 pnpm exec playwright test zz-look`

Open `test-results/look-light.png` and `test-results/look-dark.png` and check each of these; fix any that fails by adjusting the `.recipient-field` rules from Step 5, rebuild, and re-run:

1. The To row is the same height as before and has no border or focus ring of its own.
2. The chip reads `carol@partner.test` with a visible `×`, on the app's chip colour, readable in both themes.
3. The list sits directly under the field, is not clipped by the composer window, and covers the rows below it rather than pushing them down.
4. Each row shows the name, then the address in smaller, dimmer text; the first row is highlighted.
5. Text and background contrast is readable in the dark theme.

Then delete the throwaway spec: `rm e2e/zz-look.spec.ts`. Any draft it autosaved is removed by the suite's start-up cleanup the next time `pnpm e2e` runs (Step 9).

- [ ] **Step 8: Remove Tags and update the docs**

Run: `grep -rn "tags-solid\|rozie-tags" src e2e` — expected: no output. Then:

```bash
pnpm remove @rozie-ui/tags-solid
```

In `README.md`, in the Layout table, replace `(rozie.js: Toast, CommandPalette, TipTap, Tags)` with `(rozie.js: Toast, CommandPalette, TipTap, Combobox, Dialog, FullCalendar, Popover)`. In the feature list, replace the Compose bullet's text `inline reply / reply-all / forward, identities, draft autosave, attachments, 10 s undo send.` with `inline reply / reply-all / forward, recipient suggestions from your mail history, identities, draft autosave, attachments, 10 s undo send.`

In `e2e/README.md`, in the Coverage table's `compose.spec.ts` row, append to the cell: ` Recipient suggestions: ranked from mail history, picked with Enter, ArrowDown or Tab, not offered twice, closed by Escape, learned from a message just sent; free text by comma, paste and blur.`

In `docs/rozie-feedback.md`, append:

```markdown

## Tags 0.1.11 — dropped from the recipient fields: no suggestions, no way to clear the draft
Wanted: To/Cc/Bcc that suggest people as you type. Tags has no suggestion list, no event for its
typed text, and no handle method to commit or clear that text after a suggestion is picked, so a
host can't add one beside it. oinbox moved the recipient fields to Combobox (below) and removed the
package. Suggest a `draft`/`input` event and `commit()`/`clearDraft()` on the handle, or an
`options` prop.

## Combobox 0.6.0 — adopted for recipient fields (`multiple` + `disableFilter`); six gaps for a token input
Wanted: a Gmail-style recipient field: chips, a suggestion list fed by the host, free text for
addresses nobody has suggested. Chips, the list, arrow keys, Enter and Backspace-to-remove work
out of the box. Everything below is added from outside in `src/ui/RecipientField.tsx`.
1. **No commit keys.** `,` and `;` should commit the typed text. We handle `keydown` on a wrapper
   and clear the input with `seedQuery('')`. Suggest `commitKeys` (Tags has `delimiters`).
2. **No paste-to-add.** Pasting `a@x, b@y` should add both. We handle `paste` on the wrapper.
   Tags has this.
3. **Tab doesn't pick, and the active option isn't exposed.** We read the input's
   `aria-activedescendant` and map the index back to our options. Suggest Tab-to-select as an
   option, or the active option on the handle or in an event.
4. **The list opens on focus and can't stay closed when there is nothing to show.** With
   `disableFilter` and no options it renders "No results". We hide a list that has no options with
   CSS (`:not(:has(.rozie-combobox-option))`), which leaves `aria-expanded="true"` on the input
   while nothing is shown. Suggest `openOnFocus={false}` and not opening while `options` is empty
   and there is no `empty` slot content.
5. **Escape is consumed whenever the input has focus**, because the popup counts as open even when
   it shows nothing, so a host can't tell "closed the list" from "nothing to close". We track it
   ourselves so the first Escape closes the list and the second closes the composer. Follows from 4.
6. **Free text needs `creatable`'s "Create …" row or host code.** A recipient field wants "commit
   what I typed if it validates" without a row in the list. We do it in the host; Tags' `validate`
   is the shape we'd want here.
Also: `on*` props are `(...args: unknown[]) => void` and slot contexts are loosely typed, the same
finding as FullCalendar and DataTable.
```

- [ ] **Step 9: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm e2e`
Expected: typecheck exits 0; all unit tests pass; the build succeeds; Playwright reports 34 passed.

- [ ] **Step 10: Commit**

```bash
git add src/ui/RecipientField.tsx src/ui/ComposerView.tsx src/ui/styles.css e2e/support/compose.ts e2e/compose.spec.ts package.json pnpm-lock.yaml docs/rozie-feedback.md README.md e2e/README.md
git commit -m "Suggest recipients from mail history; move the recipient fields to rozie Combobox"
```
