# Label Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can create, rename and delete labels (JMAP mailboxes without a role) from oinbox, and remove a label from a conversation.

**Architecture:** A pure module (`src/mail/labels.ts`) turns a typed path such as `Clients/Acme` into a plan or a validation message. The engine (`src/sync/engine.ts`) gains server-confirmed `Mailbox/set` calls and a delete sweep that strips the label from every email before destroying the mailbox, so no path destroys mail. An app layer (`src/app/labels.ts`) adds confirmation and toasts; the UI is a sidebar "+" and "⋯" menu, one create/rename dialog, a "Create …" row in the pickers, and an "×" on conversation chips.

**Tech Stack:** TypeScript strict, SolidJS 1.9, Vite, Vitest (jsdom), Playwright, `@rozie-ui/dialog-solid` 0.1.3, `@rozie-ui/popover-solid` 0.2.4, `@rozie-ui/command-palette-solid` 0.4.10 (all already dependencies).

**Spec:** `docs/superpowers/specs/2026-10-01-label-management-design.md`

## Global Constraints

- No new dependencies.
- `ui/` never calls `jmap/`. Every new JMAP call lives in `src/sync/engine.ts`.
- A label is a mailbox with no role. Mailboxes with a role are never renamed, deleted or unlabelled by this code. Stalwart reports `mayDelete: true` for Inbox, so `myRights` is not the guard.
- `onDestroyRemoveEmails: true` is never sent by the app. (The e2e cleanup helper sends it, for `e2e-` labels only.)
- Mutations are server-confirmed: the store changes when the server answers. No optimistic mailbox updates.
- Limits come from the session's `urn:ietf:params:jmap:mail` account capability, falling back to depth 10 and 255 bytes.
- Server facts (Stalwart 0.16.23, checked 2026-10-01): a parent and child can be created in one `Mailbox/set` with `parentId: "#<creation id>"`; a creation reference inside `update` is refused with a method-level `invalidResultReference`; `Email/query` with `limit: 0` returns everything, so counts use `limit: 1`; a duplicate sibling name (case-insensitive) is refused with `alreadyExists`; refusals on destroy are `mailboxHasChild` and `mailboxHasEmail`; `maxObjectsInSet` is 500.
- User-facing strings are copied verbatim from the spec. They use straight single quotes around names: `Deleted 'Receipts'.`
- rozie gaps go in `docs/rozie-feedback.md`. If a rozie component blocks a task, stop and tell the user.
- Match the surrounding code: 2-space indent, single quotes, comments only where the code can't say it.
- Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01UMoXfxooT3CRtWKGxJtpLC`
- Commands: `pnpm test` (unit), `pnpm typecheck`, `pnpm build`, `pnpm e2e` (needs the Docker stack in `deploy/`; see `e2e/README.md`). `E2E_SKIP_SEED=1 pnpm exec playwright test labels` runs one spec quickly. The e2e suite runs against `dist/`, so run `pnpm build` before it.
- e2e tests clean up what they create: labels are named `e2e-…` and mail has the subject `Label test e2e-…`.

## Review Focus

1. **Padded or oddly spaced input** (`  Clients /  New   label `): one normalized label, parents reused, no near-duplicate. Pinned in Task 1.
2. **Names that are short in characters but long in bytes** (64 emoji): refused by the byte limit before the server sees them. Pinned in Task 1.
3. **A stale warm-start snapshot:** a link to a label created since the last visit must not be redirected as "no longer exists" before the first sync. Pinned in Task 4 (`synced`) and used in Task 6.
4. **Deleting a label that is already gone on the server** (deleted from another client a moment ago): the delete resolves and the store is cleaned, with no error. Pinned in Task 4.
5. **A double submit of the create dialog** (Enter twice, or Enter then click): one label, no "already exists" error. Pinned in Task 6 (e2e).

---

### Task 1: Label paths (pure)

**Files:**
- Create: `src/mail/labels.ts`
- Test: `src/mail/labels.test.ts`
- Modify: `src/jmap/types.ts` (the `Session` interface)

**Interfaces:**
- Consumes: `Id`, `Mailbox`, `Session`, `MAIL` from `src/jmap/types.ts`.
- Produces:
  - `interface LabelLimits { maxDepth: number; maxNameBytes: number }`
  - `const DEFAULT_LIMITS: LabelLimits` (`{ maxDepth: 10, maxNameBytes: 255 }`)
  - `interface LabelPlan { parentId: Id | null; ancestors: string[]; name: string }`
  - `type PlanResult = { ok: true; plan: LabelPlan; path: string; noop: boolean } | { ok: false; error: string }`
  - `planLabel(path: string, mailboxes: Record<Id, Mailbox>, limits: LabelLimits, renaming?: Id): PlanResult`
  - `labelLimits(session: Session): LabelLimits`

- [ ] **Step 1: Let `Session` carry account capabilities**

In `src/jmap/types.ts`, change the `accounts` line of `Session` to:

```ts
  accounts: Record<Id, { name: string; isPersonal: boolean; isReadOnly: boolean; accountCapabilities?: Record<string, Record<string, unknown>> }>;
```

- [ ] **Step 2: Write the failing tests**

Create `src/mail/labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Mailbox, Session } from '../jmap/types';
import { DEFAULT_LIMITS, labelLimits, planLabel } from './labels';

const mb = (id: string, name: string, parentId: string | null = null, role: Mailbox['role'] = null): Mailbox => ({
  id, name, role, parentId, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
});

const boxes = {
  I: mb('I', 'Inbox', null, 'inbox'),
  S: mb('S', 'Sent Items', null, 'sent'),
  C: mb('C', 'Clients'),
  A: mb('A', 'Acme', 'C'),
  R: mb('R', 'Receipts'),
  X: mb('X', 'Sub', 'I'), // a label under Inbox, made by another client
};

const plan = (path: string, renaming?: string, limits = DEFAULT_LIMITS) => planLabel(path, boxes, limits, renaming);
const error = (path: string, renaming?: string, limits = DEFAULT_LIMITS) => {
  const r = plan(path, renaming, limits);
  return r.ok ? null : r.error;
};

describe('planLabel', () => {
  it('plans a top-level label', () => {
    expect(plan('Travel')).toEqual({ ok: true, plan: { parentId: null, ancestors: [], name: 'Travel' }, path: 'Travel', noop: false });
  });

  it('reuses an existing parent whatever its letter case', () => {
    expect(plan('clients/New')).toEqual({ ok: true, plan: { parentId: 'C', ancestors: [], name: 'New' }, path: 'Clients/New', noop: false });
  });

  it('lists the missing ancestors, outermost first', () => {
    expect(plan('Projects/2026/Q1')).toEqual({ ok: true, plan: { parentId: null, ancestors: ['Projects', '2026'], name: 'Q1' }, path: 'Projects/2026/Q1', noop: false });
    expect(plan('Clients/Acme/Invoices/Paid')).toEqual({
      ok: true, plan: { parentId: 'A', ancestors: ['Invoices'], name: 'Paid' }, path: 'Clients/Acme/Invoices/Paid', noop: false,
    });
  });

  it('trims segments and collapses inner whitespace', () => {
    expect(plan('  Clients /  New   label ')).toEqual({ ok: true, plan: { parentId: 'C', ancestors: [], name: 'New label' }, path: 'Clients/New label', noop: false });
    expect(plan('a\tb')).toMatchObject({ ok: true, plan: { name: 'a b' } });
  });

  it('refuses empty names and empty segments', () => {
    for (const p of ['', '   ', 'a//b', '/a', 'a/']) expect(error(p)).toBe("A label name can't be empty.");
  });

  it('refuses control characters', () => {
    expect(error('a\u0007b')).toBe("Label names can't contain control characters.");
  });

  it('measures the name limit in UTF-8 bytes', () => {
    expect(plan('x'.repeat(255)).ok).toBe(true);
    expect(error('x'.repeat(256))).toBe(`'${'x'.repeat(30)}…' is too long.`);
    expect(plan('😀'.repeat(63)).ok).toBe(true);
    expect(error('😀'.repeat(64))).toBe(`'${'😀'.repeat(15)}…' is too long.`);
    expect(error('Clients/abcd', undefined, { maxDepth: 10, maxNameBytes: 3 })).toBe("'Clients' is too long.");
  });

  it('refuses system mailboxes anywhere in the path', () => {
    expect(error('Inbox/Foo')).toBe("'Inbox' is a system mailbox.");
    expect(error('sent items')).toBe("'Sent Items' is a system mailbox.");
  });

  it('refuses a path that already exists, comparing case-insensitively', () => {
    expect(error('receipts')).toBe("A label named 'Receipts' already exists.");
    expect(error('clients/acme')).toBe("A label named 'Clients/Acme' already exists.");
  });

  it('refuses paths deeper than the limit', () => {
    expect(plan('a/b/c/d/e/f/g/h/i/j').ok).toBe(true);
    expect(error('a/b/c/d/e/f/g/h/i/j/k')).toBe('Labels can be nested at most 10 deep.');
  });

  describe('renaming', () => {
    it('treats the same parent and exact name as a no-op', () => {
      expect(plan('Receipts', 'R')).toMatchObject({ ok: true, noop: true });
      expect(plan('Clients/Acme', 'A')).toMatchObject({ ok: true, noop: true });
    });

    it('treats a change of case as a real rename, not a duplicate', () => {
      expect(plan('receipts', 'R')).toEqual({ ok: true, plan: { parentId: null, ancestors: [], name: 'receipts' }, path: 'receipts', noop: false });
    });

    it('moves a label when the parent part changes', () => {
      expect(plan('Clients/Receipts', 'R')).toMatchObject({ ok: true, plan: { parentId: 'C', ancestors: [], name: 'Receipts' }, noop: false });
      expect(plan('Sub', 'X')).toMatchObject({ ok: true, plan: { parentId: null, name: 'Sub' } });
    });

    it('still refuses the name of another label', () => {
      expect(error('Receipts', 'C')).toBe("A label named 'Receipts' already exists.");
    });

    it('refuses moving a label inside itself', () => {
      expect(error('Clients/Sub', 'C')).toBe("A label can't be moved inside itself.");
      expect(error('Clients/Acme/Clients', 'C')).toBe("A label can't be moved inside itself.");
    });

    it('counts the label\'s own sub-labels against the depth limit', () => {
      const tight = { maxDepth: 3, maxNameBytes: 255 };
      expect(plan('x/Clients', 'C', tight).ok).toBe(true); // 2 levels + Acme below = 3
      expect(error('x/y/Clients', 'C', tight)).toBe('Labels can be nested at most 3 deep.');
    });
  });
});

describe('labelLimits', () => {
  const session = (mail: Record<string, unknown> | undefined): Session => ({
    capabilities: {}, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' }, username: 'u', apiUrl: '', downloadUrl: '', uploadUrl: '', eventSourceUrl: '', state: 's',
    accounts: { a1: { name: 'u', isPersonal: true, isReadOnly: false, ...(mail ? { accountCapabilities: { 'urn:ietf:params:jmap:mail': mail } } : {}) } },
  });

  it('reads the limits from the mail capability', () => {
    expect(labelLimits(session({ maxMailboxDepth: 4, maxSizeMailboxName: 100 }))).toEqual({ maxDepth: 4, maxNameBytes: 100 });
  });

  it('falls back when the capability or a value is missing', () => {
    expect(labelLimits(session(undefined))).toEqual(DEFAULT_LIMITS);
    expect(labelLimits(session({ maxMailboxDepth: null }))).toEqual(DEFAULT_LIMITS);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm exec vitest run src/mail/labels.test.ts`
Expected: FAIL, cannot resolve `./labels`.

- [ ] **Step 4: Implement**

Create `src/mail/labels.ts`:

```ts
import { MAIL, type Id, type Mailbox, type Session } from '../jmap/types';

export interface LabelLimits {
  maxDepth: number;
  maxNameBytes: number;
}

export const DEFAULT_LIMITS: LabelLimits = { maxDepth: 10, maxNameBytes: 255 };

/** What to send for a typed path: where it hangs, which ancestors are missing, and the leaf name. */
export interface LabelPlan {
  /** The deepest ancestor that already exists, or null for the top level. */
  parentId: Id | null;
  /** Names of the ancestors to create, outermost first. */
  ancestors: string[];
  name: string;
}

export type PlanResult =
  /** `path` is the normalized path for display; `noop` is a rename that changes nothing. */
  | { ok: true; plan: LabelPlan; path: string; noop: boolean }
  | { ok: false; error: string };

export function labelLimits(session: Session): LabelLimits {
  const account = session.primaryAccounts[MAIL];
  const mail = account ? session.accounts[account]?.accountCapabilities?.[MAIL] : undefined;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback);
  return {
    maxDepth: num(mail?.maxMailboxDepth, DEFAULT_LIMITS.maxDepth),
    maxNameBytes: num(mail?.maxSizeMailboxName, DEFAULT_LIMITS.maxNameBytes),
  };
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();

/** How many levels of sub-labels hang below a mailbox. */
function subtreeHeight(id: Id, all: Mailbox[], depth = 0): number {
  if (depth >= 10) return 0;
  let height = 0;
  for (const m of all) if (m.parentId === id) height = Math.max(height, 1 + subtreeHeight(m.id, all, depth + 1));
  return height;
}

/**
 * Turn a typed label path ("Clients/Acme") into a plan, or say why it can't be one.
 * Existing parents are matched case-insensitively and reused. With `renaming`, the path is
 * the new place and name for that label.
 */
export function planLabel(path: string, mailboxes: Record<Id, Mailbox>, limits: LabelLimits, renaming?: Id): PlanResult {
  const fail = (error: string): PlanResult => ({ ok: false, error });
  const segments = path.split('/').map((s) => s.trim().replace(/\s+/g, ' '));
  if (segments.some((s) => !s)) return fail("A label name can't be empty.");
  if (segments.some((s) => CONTROL.test(s))) return fail("Label names can't contain control characters.");
  const long = segments.find((s) => encoder.encode(s).length > limits.maxNameBytes);
  if (long) return fail(`'${long.length > 30 ? `${long.slice(0, 30)}…` : long}' is too long.`);

  const all = Object.values(mailboxes);
  const childOf = (parentId: Id | null, name: string) =>
    all.find((m) => (m.parentId ?? null) === parentId && m.name.toLowerCase() === name.toLowerCase());

  let parentId: Id | null = null;
  const shown: string[] = [];
  let i = 0;
  for (; i < segments.length - 1; i++) {
    const hit = childOf(parentId, segments[i]!);
    if (!hit) break;
    if (hit.id === renaming) return fail("A label can't be moved inside itself.");
    if (hit.role) return fail(`'${hit.name}' is a system mailbox.`);
    parentId = hit.id;
    shown.push(hit.name);
  }
  const ancestors = segments.slice(i, -1);
  const name = segments[segments.length - 1]!;

  const existing = ancestors.length ? undefined : childOf(parentId, name);
  if (existing?.role) return fail(`'${existing.name}' is a system mailbox.`);
  if (existing && existing.id !== renaming) return fail(`A label named '${[...shown, existing.name].join('/')}' already exists.`);

  const below = renaming ? subtreeHeight(renaming, all) : 0;
  if (segments.length + below > limits.maxDepth) return fail(`Labels can be nested at most ${limits.maxDepth} deep.`);

  return {
    ok: true,
    plan: { parentId, ancestors, name },
    path: [...shown, ...ancestors, name].join('/'),
    noop: !!existing && existing.name === name,
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm exec vitest run src/mail/labels.test.ts && pnpm typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/mail/labels.ts src/mail/labels.test.ts src/jmap/types.ts
git commit -m "Add label path parsing and validation"
```

---

### Task 2: Selectors and the unlabel patch

**Files:**
- Modify: `src/sync/selectors.ts`, `src/sync/patch.ts`
- Test: `src/sync/selectors.test.ts`, `src/sync/patch.test.ts`

**Interfaces:**
- Consumes: `Mailbox`, `Id`; `archivePatch`, `MutableEmail` in `src/sync/patch.ts`.
- Produces:
  - `isLabel(mb: Mailbox): boolean` and `subLabelCount(id: Id, mailboxes: Record<Id, Mailbox>): number` in `selectors.ts`
  - `unlabelPatch(emails: MutableEmail[], labelId: Id, archiveId: Id): Record<Id, EmailPatch>` and `onlyIn(e: MutableEmail, mailboxId: Id): boolean` in `patch.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/sync/selectors.test.ts` (and add `isLabel, subLabelCount` to its import from `./selectors`):

```ts
describe('labels', () => {
  const tree = {
    I: mb('I', 'Inbox', 'inbox'),
    C: mb('C', 'Clients'),
    A: mb('A', 'Acme', null, 'C'),
    N: mb('N', 'Invoices', null, 'A'),
    B: mb('B', 'Bolt', null, 'C'),
    R: mb('R', 'Receipts'),
  };

  it('isLabel is true only for mailboxes without a role', () => {
    expect(isLabel(tree.C)).toBe(true);
    expect(isLabel(tree.I)).toBe(false);
  });

  it('subLabelCount counts every descendant', () => {
    expect(subLabelCount('C', tree)).toBe(3);
    expect(subLabelCount('A', tree)).toBe(1);
    expect(subLabelCount('R', tree)).toBe(0);
  });
});
```

Append to `src/sync/patch.test.ts` (and add `onlyIn, unlabelPatch` to its import from `./patch`):

```ts
describe('unlabelPatch', () => {
  const both = { id: 'e1', keywords: {}, mailboxIds: { I: true as const, W: true as const } };
  const only = { id: 'e2', keywords: {}, mailboxIds: { W: true as const } };
  const other = { id: 'e3', keywords: {}, mailboxIds: { I: true as const } };

  it('removes the label, and sends an email with no other mailbox to Archive', () => {
    expect(unlabelPatch([both, only, other], 'W', 'A')).toEqual({
      e1: { 'mailboxIds/W': null },
      e2: { 'mailboxIds/W': null, 'mailboxIds/A': true },
    });
  });

  it('onlyIn is true when the mailbox is the email\'s only one', () => {
    expect(onlyIn(only, 'W')).toBe(true);
    expect(onlyIn(both, 'W')).toBe(false);
    expect(onlyIn(other, 'W')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run src/sync/selectors.test.ts src/sync/patch.test.ts`
Expected: FAIL, `isLabel` / `unlabelPatch` are not exported.

- [ ] **Step 3: Implement**

In `src/sync/selectors.ts`, after `labelPath`:

```ts
/** A mailbox the user manages as a label: one without a role. */
export function isLabel(mb: Mailbox): boolean {
  return !mb.role;
}

/** How many labels sit below a mailbox, at any depth. */
export function subLabelCount(id: Id, mailboxes: Record<Id, Mailbox>): number {
  const all = Object.values(mailboxes);
  let count = 0;
  let level = new Set([id]);
  for (let depth = 0; level.size && depth < 10; depth++) {
    const next = all.filter((m) => m.parentId && level.has(m.parentId)).map((m) => m.id);
    count += next.length;
    level = new Set(next);
  }
  return count;
}
```

In `src/sync/patch.ts`, after `archivePatch`:

```ts
/** Take a label off emails. The rule is archive's: an email left in no mailbox goes to Archive. */
export const unlabelPatch = archivePatch;

/** True when `mailboxId` is the only mailbox the email is in. */
export function onlyIn(e: MutableEmail, mailboxId: Id): boolean {
  return !!e.mailboxIds?.[mailboxId] && Object.keys(e.mailboxIds).length === 1;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run src/sync/selectors.test.ts src/sync/patch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/selectors.ts src/sync/selectors.test.ts src/sync/patch.ts src/sync/patch.test.ts
git commit -m "Add label selectors and the unlabel patch"
```

---

### Task 3: Engine create and rename, with Mailbox/set in the fake

**Files:**
- Modify: `src/sync/fake-jmap.ts`, `src/sync/engine.ts`, `src/jmap/types.ts`
- Test: `src/sync/engine.test.ts`

**Interfaces:**
- Consumes: `LabelPlan` from `src/mail/labels.ts`.
- Produces:
  - `MailEngine.createLabel(plan: LabelPlan): Promise<Id>` (the leaf's id)
  - `MailEngine.updateLabel(id: Id, plan: LabelPlan): Promise<void>`
  - `MailboxSetArgs` in `types.ts` (`SetArgs<Mailbox>` plus `onDestroyRemoveEmails?: boolean`)
  - `FakeJmap`: `addMailbox(id, name, role?, parentId?)`, `bumpMailbox(change)`, `sent: [string, Record<string, unknown>][]`, `onCall`, `mailboxState`, a working `Mailbox/set`, `Mailbox/get` honouring `ids` and reporting `totalEmails` / `totalThreads`, and a real `Mailbox/changes`.

- [ ] **Step 1: Type `onDestroyRemoveEmails`**

In `src/jmap/types.ts`, after `SetArgs`:

```ts
export interface MailboxSetArgs extends SetArgs<Mailbox> {
  onDestroyRemoveEmails?: boolean;
}
```

and change the `Methods` entry to:

```ts
  'Mailbox/set': { args: MailboxSetArgs; result: SetResult<Mailbox> };
```

- [ ] **Step 2: Extend the fake**

In `src/sync/fake-jmap.ts`:

Add fields after `calls: string[] = [];`:

```ts
  /** Every call with its resolved arguments, for asserting on what was sent. */
  sent: [string, Record<string, unknown>][] = [];
  /** Runs before each call is handled: lets a test change server state mid-flow, or throw. */
  onCall: ((name: string, args: Record<string, unknown>) => void) | null = null;
  mailboxState = 1;
  mailboxLog: { state: number; created: string[]; updated: string[]; destroyed: string[] }[] = [];
  private nextMailboxId = 1;
```

Replace `addMailbox` and add `bumpMailbox` and `withCounts`:

```ts
  addMailbox(id: string, name: string, role: Mailbox['role'] = null, parentId: string | null = null) {
    this.mailboxes.set(id, {
      id, name, role, parentId, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
    });
  }

  bumpMailbox(c: Partial<{ created: string[]; updated: string[]; destroyed: string[] }>) {
    this.mailboxState++;
    this.mailboxLog.push({ state: this.mailboxState, created: c.created ?? [], updated: c.updated ?? [], destroyed: c.destroyed ?? [] });
  }

  private withCounts(m: Mailbox): Mailbox {
    const inside = [...this.emails.values()].filter((e) => e.mailboxIds?.[m.id]);
    return { ...m, totalEmails: inside.length, totalThreads: new Set(inside.map((e) => e.threadId)).size };
  }
```

At the top of `handle`, replace `this.calls.push(name);` with:

```ts
    this.calls.push(name);
    this.sent.push([name, args]);
    this.onCall?.(name, args);
```

Replace the `Mailbox/get` case:

```ts
      case 'Mailbox/get': {
        const all = [...this.mailboxes.values()];
        const list = (ids ? all.filter((m) => ids.includes(m.id)) : all).map((m) => this.withCounts(m));
        return [name, { accountId: 'a1', state: `m${this.mailboxState}`, list, notFound: [] }];
      }
```

In the `Email/changes` / `Thread/changes` / `Mailbox/changes` case, replace the `Mailbox/changes` line and move `uniq` above it:

```ts
        const since = Number(String(args.sinceState).slice(1));
        const uniq = (xs: string[]) => [...new Set(xs)];
        if (name === 'Mailbox/changes') {
          const entries = this.mailboxLog.filter((l) => l.state > since);
          const destroyed = uniq(entries.flatMap((l) => l.destroyed));
          const created = uniq(entries.flatMap((l) => l.created)).filter((id) => !destroyed.includes(id));
          const updated = uniq(entries.flatMap((l) => l.updated)).filter((id) => !created.includes(id) && !destroyed.includes(id));
          return [name, { accountId: 'a1', oldState: args.sinceState, newState: `m${this.mailboxState}`, hasMoreChanges: false, created, updated, destroyed, updatedProperties: null }];
        }
        const entries = this.log.filter((l) => l.state > since);
```

(Delete the later `const uniq = …` line so it is declared once.)

Add a `Mailbox/set` case before `Email/set`:

```ts
      case 'Mailbox/set': {
        const oldState = `m${this.mailboxState}`;
        const all = () => [...this.mailboxes.values()];
        const clash = (parentId: string | null, mbName: string, except?: string) =>
          all().some((m) => m.id !== except && (m.parentId ?? null) === parentId && m.name.toLowerCase() === mbName.toLowerCase());
        const exists = (mbName: string) => ({ type: 'alreadyExists', description: `A mailbox with name '${mbName}' already exists.` });

        const update = (args.update ?? {}) as Record<string, { name?: string; parentId?: string | null }>;
        // Stalwart refuses a creation reference inside an update, failing the whole call.
        if (Object.values(update).some((p) => typeof p.parentId === 'string' && p.parentId.startsWith('#'))) {
          return ['error', { type: 'invalidResultReference', description: 'Id reference not found.' }];
        }

        const created: Record<string, { id: string }> = {};
        const notCreated: Record<string, { type: string; description?: string }> = {};
        const real = new Map<string, string>();
        // Creates may refer to each other in any order: keep going while one more resolves.
        let pending = Object.entries((args.create ?? {}) as Record<string, Partial<Mailbox>>);
        while (pending.length) {
          const waiting: typeof pending = [];
          for (const [cid, props] of pending) {
            let parentId = props.parentId ?? null;
            if (parentId?.startsWith('#')) {
              const resolved = real.get(parentId.slice(1));
              if (!resolved) {
                waiting.push([cid, props]);
                continue;
              }
              parentId = resolved;
            }
            if (clash(parentId, props.name!)) {
              notCreated[cid] = exists(props.name!);
              continue;
            }
            const id = `mb${this.nextMailboxId++}`;
            this.mailboxes.set(id, {
              id, name: props.name!, role: props.role ?? null, parentId, sortOrder: 0,
              totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: props.isSubscribed ?? false,
            });
            real.set(cid, id);
            created[cid] = { id };
          }
          if (waiting.length === pending.length) {
            for (const [cid] of waiting) notCreated[cid] = { type: 'invalidProperties', description: 'Unknown parent.' };
            break;
          }
          pending = waiting;
        }

        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string; description?: string }> = {};
        for (const [id, patch] of Object.entries(update)) {
          const m = this.mailboxes.get(id);
          if (!m) {
            notUpdated[id] = { type: 'notFound' };
            continue;
          }
          const mbName = patch.name ?? m.name;
          const parentId = patch.parentId === undefined ? m.parentId : patch.parentId;
          if (clash(parentId, mbName, id)) {
            notUpdated[id] = exists(mbName);
            continue;
          }
          m.name = mbName;
          m.parentId = parentId;
          updated[id] = null;
        }

        const destroyed: string[] = [];
        const notDestroyed: Record<string, { type: string; description?: string }> = {};
        for (const id of (args.destroy ?? []) as string[]) {
          if (!this.mailboxes.has(id)) {
            notDestroyed[id] = { type: 'notFound' };
            continue;
          }
          if (all().some((m) => m.parentId === id)) {
            notDestroyed[id] = { type: 'mailboxHasChild', description: 'Mailbox has at least one children.' };
            continue;
          }
          const inside = [...this.emails.values()].filter((e) => e.mailboxIds?.[id]);
          if (inside.length && !args.onDestroyRemoveEmails) {
            notDestroyed[id] = { type: 'mailboxHasEmail', description: 'Mailbox is not empty.' };
            continue;
          }
          for (const e of inside) {
            delete e.mailboxIds![id];
            if (!Object.keys(e.mailboxIds!).length) {
              this.emails.delete(e.id);
              this.bump({ destroyed: [e.id] });
            }
          }
          this.mailboxes.delete(id);
          destroyed.push(id);
        }

        const change = { created: Object.values(created).map((c) => c.id), updated: Object.keys(updated), destroyed };
        if (change.created.length || change.updated.length || change.destroyed.length) this.bumpMailbox(change);
        const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
        return [name, {
          accountId: 'a1', oldState, newState: `m${this.mailboxState}`,
          created: orNull(created), updated: orNull(updated), destroyed: destroyed.length ? destroyed : null,
          notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
        }];
      }
```

- [ ] **Step 3: Write the failing engine tests**

Append to `src/sync/engine.test.ts`:

```ts
describe('MailEngine labels: create and rename', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  beforeEach(async () => {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    server.addMailbox('A', 'Archive', 'archive');
    server.addMailbox('W', 'Work');
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
  });

  it('creates a label and its missing ancestors in one Mailbox/set', async () => {
    server.calls = [];
    const id = await engine.createLabel({ parentId: 'W', ancestors: ['Clients'], name: 'Acme' });
    expect(server.calls).toEqual(['Mailbox/set']);
    const acme = engine.state.mailboxes[id]!;
    const clients = engine.state.mailboxes[acme.parentId!]!;
    expect([clients.name, clients.parentId, acme.name]).toEqual(['Clients', 'W', 'Acme']);
    expect(acme).toMatchObject({ role: null, isSubscribed: true, totalEmails: 0 });
    expect(server.mailboxes.get(id)).toMatchObject({ name: 'Acme', parentId: clients.id, isSubscribed: true });
  });

  it('throws the server\'s message when a create is refused', async () => {
    await expect(engine.createLabel({ parentId: null, ancestors: [], name: 'work' })).rejects.toThrow("A mailbox with name 'work' already exists.");
    expect(Object.keys(engine.state.mailboxes).sort()).toEqual(['A', 'I', 'W']);
  });

  it('renames a label in place with one request', async () => {
    server.calls = [];
    await engine.updateLabel('W', { parentId: null, ancestors: [], name: 'Jobs' });
    expect(server.calls).toEqual(['Mailbox/set']);
    expect(engine.state.mailboxes.W).toMatchObject({ name: 'Jobs', parentId: null });
    expect(server.mailboxes.get('W')?.name).toBe('Jobs');
  });

  it('moves a label under new ancestors, creating them first', async () => {
    server.calls = [];
    await engine.updateLabel('W', { parentId: null, ancestors: ['Old', '2025'], name: 'Work' });
    expect(server.calls).toEqual(['Mailbox/set', 'Mailbox/set']);
    const year = engine.state.mailboxes[engine.state.mailboxes.W!.parentId!]!;
    const old = engine.state.mailboxes[year.parentId!]!;
    expect([old.name, old.parentId, year.name]).toEqual(['Old', null, '2025']);
    expect(server.mailboxes.get('W')?.parentId).toBe(year.id);
  });

  it('throws the server\'s message when a rename is refused, leaving the store alone', async () => {
    await expect(engine.updateLabel('W', { parentId: null, ancestors: [], name: 'Archive' })).rejects.toThrow('already exists');
    expect(engine.state.mailboxes.W?.name).toBe('Work');
  });

  it('picks up a label renamed by another client', async () => {
    server.mailboxes.get('W')!.name = 'Renamed elsewhere';
    server.bumpMailbox({ updated: ['W'] });
    await engine.catchUp();
    expect(engine.state.mailboxes.W?.name).toBe('Renamed elsewhere');
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `pnpm exec vitest run src/sync/engine.test.ts`
Expected: the new `describe` FAILS with `engine.createLabel is not a function` (the last test, which needs only the fake, passes); every earlier test still PASSES.

- [ ] **Step 5: Implement in the engine**

In `src/sync/engine.ts`, add the import:

```ts
import type { LabelPlan } from '../mail/labels';
```

Replace the tail of `ensureMailbox` (from the `// The server returns only…` comment to `return mb.id;`) with:

```ts
    // The server returns only the properties it set; fill in the ones we sent.
    const mb: Mailbox = { ...blankMailbox(name, null, role), ...created };
    this.mergeMailboxes([mb]);
    return mb.id;
```

Add after `ensureMailbox`:

```ts
  /** Create a label and its missing ancestors. Returns the label's id. */
  async createLabel(plan: LabelPlan): Promise<Id> {
    const ids = await this.createMailboxChain(plan.parentId, [...plan.ancestors, plan.name]);
    return ids[ids.length - 1]!;
  }

  /** Rename a label and/or move it under another parent. */
  async updateLabel(id: Id, plan: LabelPlan): Promise<void> {
    // Stalwart refuses a creation reference inside an update, so missing ancestors go first.
    const made = plan.ancestors.length ? await this.createMailboxChain(plan.parentId, plan.ancestors) : [];
    const parentId = made.length ? made[made.length - 1]! : plan.parentId;
    const b = this.client.batch();
    const call = b.call('Mailbox/set', { accountId: this.accountId, update: { [id]: { name: plan.name, parentId } } });
    const err = (await this.client.send(b)).get(call).notUpdated?.[id];
    if (err) throw new Error(err.description ?? err.type);
    if (this.state.mailboxes[id]) this.set('mailboxes', id, { name: plan.name, parentId });
    this.persistSoon();
  }

  /** Create nested mailboxes in one Mailbox/set, each child naming its parent by creation id. */
  private async createMailboxChain(parentId: Id | null, names: string[]): Promise<Id[]> {
    const create: Record<string, Partial<Mailbox>> = {};
    names.forEach((name, i) => {
      create[`c${i}`] = { name, parentId: i === 0 ? parentId : `#c${i - 1}`, isSubscribed: true };
    });
    const b = this.client.batch();
    const call = b.call('Mailbox/set', { accountId: this.accountId, create });
    const r = (await this.client.send(b)).get(call);
    const made: Mailbox[] = [];
    for (let i = 0; i < names.length; i++) {
      const created = r.created?.[`c${i}`];
      if (!created) break;
      made.push({ ...blankMailbox(names[i]!, i === 0 ? parentId : made[i - 1]!.id), ...created });
    }
    this.mergeMailboxes(made);
    this.persistSoon();
    if (made.length < names.length) {
      const err = r.notCreated?.[`c${made.length}`];
      throw new Error(err?.description ?? err?.type ?? 'The label was not created');
    }
    return made.map((m) => m.id);
  }
```

Add next to `byId` at the bottom of the file:

```ts
/** A mailbox as the server makes it, for filling in what a Mailbox/set response leaves out. */
function blankMailbox(name: string, parentId: Id | null, role: MailboxRole | null = null): Mailbox {
  return { id: '', name, role, parentId, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true };
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/sync/fake-jmap.ts src/sync/engine.ts src/sync/engine.test.ts src/jmap/types.ts
git commit -m "Create and rename labels in the engine; teach the fake Mailbox/set"
```

---

### Task 4: Engine delete, orphan count, and destroyed-mailbox cleanup

**Files:**
- Modify: `src/sync/fake-jmap.ts`, `src/sync/engine.ts`
- Test: `src/sync/engine.test.ts`

**Interfaces:**
- Consumes: `unlabelPatch`, `onlyIn`, `applyEmailPatch`, `MutableEmail` from `src/sync/patch.ts`; the fake's `Mailbox/set`, `sent` and `onCall` from Task 3.
- Produces:
  - `MailEngine.countOrphans(id: Id): Promise<number>`
  - `MailEngine.destroyLabel(id: Id): Promise<void>`
  - `MailState.synced: boolean` (true once the store has been reconciled with the server in this session)
  - A mailbox leaving the store, by push or locally, takes its `{ inMailbox }` live queries with it.

- [ ] **Step 1: Teach the fake's Email/query the filter operators**

In `src/sync/fake-jmap.ts`, add a method above `queryIds` and use it there:

```ts
  private matches(e: Rec, f: Record<string, unknown> | null | undefined): boolean {
    if (!f) return true;
    if (typeof f.operator === 'string') {
      const results = (f.conditions as Record<string, unknown>[]).map((c) => this.matches(e, c));
      return f.operator === 'AND' ? results.every(Boolean) : f.operator === 'OR' ? results.some(Boolean) : !results.some(Boolean);
    }
    if (f.inMailbox && !e.mailboxIds?.[f.inMailbox as string]) return false;
    if (f.inMailboxOtherThan) {
      const not = new Set(f.inMailboxOtherThan as string[]);
      if (!Object.keys(e.mailboxIds ?? {}).some((id) => !not.has(id))) return false;
    }
    return true;
  }
```

and in `queryIds` replace the first two lines of the body with:

```ts
    let list = [...this.emails.values()].filter((e) => this.matches(e, args.filter as Record<string, unknown> | null));
```

- [ ] **Step 2: Write the failing tests**

Append to `src/sync/engine.test.ts`:

```ts
describe('MailEngine labels: delete', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  const workSpec = { filter: { inMailbox: 'W' }, sort: DEFAULT_SORT, collapseThreads: true };
  const mailboxSets = () => server.sent.filter(([n]) => n === 'Mailbox/set').map(([, a]) => a);

  function setup(withArchive = true) {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    if (withArchive) server.addMailbox('A', 'Archive', 'archive');
    server.addMailbox('W', 'Work');
    server.addEmail({ id: 'x1', threadId: 't1', receivedAt: '2026-09-01T10:00:00Z', mailboxIds: { W: true } }, false);
    server.addEmail({ id: 'x2', threadId: 't2', receivedAt: '2026-09-01T11:00:00Z', mailboxIds: { W: true, I: true } }, false);
    server.addEmail({ id: 'x3', threadId: 't3', receivedAt: '2026-09-01T12:00:00Z', mailboxIds: { I: true } }, false);
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
  }

  beforeEach(async () => {
    setup();
    await engine.start();
  });

  it('counts the emails that are in the label and nowhere else, asking for one id', async () => {
    expect(await engine.countOrphans('W')).toBe(1);
    const [, args] = server.sent.filter(([n]) => n === 'Email/query').pop()!;
    expect(args).toMatchObject({
      filter: { operator: 'AND', conditions: [{ inMailbox: 'W' }, { operator: 'NOT', conditions: [{ inMailboxOtherThan: ['W'] }] }] },
      limit: 1,
      calculateTotal: true,
    });
  });

  it('strips the label from its mail, archives the orphans, then destroys the mailbox', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    await engine.destroyLabel('W');
    expect(server.emails.get('x1')?.mailboxIds).toEqual({ A: true });
    expect(server.emails.get('x2')?.mailboxIds).toEqual({ I: true });
    expect(server.emails.get('x3')?.mailboxIds).toEqual({ I: true });
    expect(server.mailboxes.has('W')).toBe(false);
    expect(engine.state.mailboxes.W).toBeUndefined();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(engine.state.emails.x1?.mailboxIds).toEqual({ A: true });
  });

  it('never asks the server to remove the emails', async () => {
    await engine.destroyLabel('W');
    expect(mailboxSets().length).toBeGreaterThan(0);
    for (const args of mailboxSets()) expect(args.onDestroyRemoveEmails).not.toBe(true);
  });

  it('works through a large label a page at a time', async () => {
    for (let i = 0; i < 501; i++) {
      server.addEmail({ id: `b${i}`, threadId: `bt${i}`, receivedAt: '2026-08-01T00:00:00Z', mailboxIds: { W: true } }, false);
    }
    server.calls = [];
    await engine.destroyLabel('W');
    expect(server.calls.filter((c) => c === 'Email/set')).toHaveLength(2);
    expect([...server.emails.values()].filter((e) => e.mailboxIds?.W)).toHaveLength(0);
    expect(server.emails.get('b500')?.mailboxIds).toEqual({ A: true });
    expect(server.mailboxes.has('W')).toBe(false);
  });

  it('creates Archive when an orphan needs it and the account has none', async () => {
    setup(false);
    await engine.start();
    await engine.destroyLabel('W');
    const archive = [...server.mailboxes.values()].find((m) => m.role === 'archive');
    expect(archive).toBeDefined();
    expect(server.emails.get('x1')?.mailboxIds).toEqual({ [archive!.id]: true });
  });

  it('does not create Archive when no email would be orphaned', async () => {
    setup(false);
    server.emails.get('x1')!.mailboxIds = { W: true, I: true };
    await engine.start();
    await engine.destroyLabel('W');
    expect([...server.mailboxes.values()].some((m) => m.role === 'archive')).toBe(false);
  });

  it('sweeps once more when mail arrives during the delete', async () => {
    let arrived = false;
    server.onCall = (name, args) => {
      if (name !== 'Mailbox/set' || !args.destroy || arrived) return;
      arrived = true;
      server.addEmail({ id: 'late', threadId: 't9', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { W: true } });
    };
    await engine.destroyLabel('W');
    expect(server.emails.get('late')?.mailboxIds).toEqual({ A: true });
    expect(server.mailboxes.has('W')).toBe(false);
  });

  it('gives up, keeping the label, when mail keeps arriving', async () => {
    let n = 0;
    server.onCall = (name, args) => {
      if (name === 'Mailbox/set' && args.destroy) server.addEmail({ id: `late${n++}`, threadId: `lt${n}`, receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { W: true } });
    };
    await expect(engine.destroyLabel('W')).rejects.toThrow();
    expect(server.mailboxes.has('W')).toBe(true);
    expect(engine.state.mailboxes.W).toBeDefined();
    expect(server.emails.size).toBe(5); // nothing was destroyed
  });

  it('leaves the label in place when a page of updates is refused', async () => {
    server.rejectUpdates.add('x1');
    await expect(engine.destroyLabel('W')).rejects.toThrow('forbidden');
    expect(server.mailboxes.has('W')).toBe(true);
    expect(engine.state.mailboxes.W).toBeDefined();
    expect(server.emails.has('x1')).toBe(true);
  });

  it('succeeds when the label is already gone on the server', async () => {
    for (const e of server.emails.values()) delete e.mailboxIds!.W;
    server.emails.get('x1')!.mailboxIds = { A: true };
    server.mailboxes.delete('W');
    await engine.destroyLabel('W');
    expect(engine.state.mailboxes.W).toBeUndefined();
  });

  it('surfaces mailboxHasChild from the server', async () => {
    server.addMailbox('K', 'Kid', null, 'W');
    await expect(engine.destroyLabel('W')).rejects.toThrow('Mailbox has at least one children.');
  });

  it('drops a label destroyed by another client, with its live query', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    const inboxKey = engine.openQuery(inboxSpec);
    await engine.ensureRange(inboxKey, 0, 10);
    for (const e of server.emails.values()) delete e.mailboxIds!.W;
    server.emails.get('x1')!.mailboxIds = { A: true };
    server.mailboxes.delete('W');
    server.bumpMailbox({ destroyed: ['W'] });
    await engine.catchUp();
    expect(engine.state.mailboxes.W).toBeUndefined();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(engine.state.queries[inboxKey]).toBeDefined();
  });

  it('is synced only after reconciling with the server, not straight from a snapshot', async () => {
    expect(engine.state.synced).toBe(true);
    const warm = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    expect(warm.hydrate(engine.snapshot())).toBe(true);
    expect(warm.state.ready).toBe(true);
    expect(warm.state.synced).toBe(false);
    await warm.start();
    expect(warm.state.synced).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm exec vitest run src/sync/engine.test.ts`
Expected: the new `describe` FAILS (`engine.countOrphans is not a function`, `engine.destroyLabel is not a function`, `synced` undefined, and the push test finds the dead query still there); earlier tests PASS.

- [ ] **Step 4: Implement in the engine**

In `src/sync/engine.ts`:

Change the patch import to:

```ts
import { applyEmailPatch, onlyIn, unlabelPatch, type EmailPatch, type MutableEmail } from './patch';
```

Add below `PAGE_SIZE`:

```ts
/** Emails per request while emptying a label (Stalwart's maxObjectsInSet). */
const SWEEP_PAGE = 500;
```

Add `synced` to `MailState`, after `ready`:

```ts
  /** True once the store has been reconciled with the server in this session (a snapshot alone may be stale). */
  synced: boolean;
```

and `synced: false,` after `ready: false,` in the constructor's initial store.

In `start()`, set it on both paths:

```ts
    if (this.states.Mailbox) {
      await this.catchUp();
      this.set('synced', true);
      return;
    }
```

and change the last line of `start()` to:

```ts
    this.set({ mailboxes: byId(mailboxes.list), identities, ready: true, synced: true });
```

In `resetAll()`, change the first `this.set({ … })` to:

```ts
    this.set({ emails: {}, threads: {}, bodies: {}, mailboxes: {}, synced: false });
```

Add after `updateLabel`:

```ts
  /** How many emails are in this mailbox and no other. */
  async countOrphans(id: Id): Promise<number> {
    const b = this.client.batch();
    const q = b.call('Email/query', {
      accountId: this.accountId,
      filter: { operator: 'AND', conditions: [{ inMailbox: id }, { operator: 'NOT', conditions: [{ inMailboxOtherThan: [id] }] }] },
      // Stalwart reads limit 0 as "no limit".
      limit: 1,
      calculateTotal: true,
    });
    return (await this.client.send(b)).get(q).total ?? 0;
  }

  /**
   * Delete a label without deleting mail: take the label off every email (those with no other
   * mailbox go to Archive), then destroy the empty mailbox. The server is never asked to remove
   * emails, so a failure midway leaves the label in place with less mail in it.
   */
  async destroyLabel(id: Id): Promise<void> {
    try {
      await this.sweepLabel(id);
      if (await this.destroyEmptyMailbox(id)) {
        // Mail arrived during the sweep.
        await this.sweepLabel(id);
        if (await this.destroyEmptyMailbox(id)) throw new Error('New mail keeps arriving in this label');
      }
    } finally {
      this.persistSoon();
    }
    this.forgetMailboxes([id]);
    await this.catchUp().catch(() => undefined);
  }

  /** Resolves true if the server refused because the mailbox still holds mail. */
  private async destroyEmptyMailbox(id: Id): Promise<boolean> {
    const b = this.client.batch();
    const call = b.call('Mailbox/set', { accountId: this.accountId, destroy: [id], onDestroyRemoveEmails: false });
    const err = (await this.client.send(b)).get(call).notDestroyed?.[id];
    // notFound: another client deleted it first.
    if (!err || err.type === 'notFound') return false;
    if (err.type === 'mailboxHasEmail') return true;
    throw new Error(err.description ?? err.type);
  }

  private async sweepLabel(id: Id): Promise<void> {
    const accountId = this.accountId;
    const seen = new Set<Id>();
    for (;;) {
      const b = this.client.batch();
      const q = b.call('Email/query', { accountId, filter: { inMailbox: id }, collapseThreads: false, limit: SWEEP_PAGE });
      const g = b.call('Email/get', { accountId, '#ids': q.ref('/ids'), properties: ['mailboxIds'] });
      const page = (await this.client.send(b)).get(g).list as MutableEmail[];
      if (!page.length) return;
      if (page.every((e) => seen.has(e.id))) throw new Error("The server didn't apply the change");
      page.forEach((e) => seen.add(e.id));

      const archive = page.some((e) => onlyIn(e, id)) ? await this.ensureMailbox('archive', 'Archive') : '';
      const patches = unlabelPatch(page, id, archive);
      const sb = this.client.batch();
      const call = sb.call('Email/set', { accountId, update: patches });
      const failed = Object.values((await this.client.send(sb)).get(call).notUpdated ?? {})[0];
      if (failed) throw new Error(failed.description ?? failed.type);
      this.set('emails', produce((m) => {
        for (const [eid, patch] of Object.entries(patches)) {
          const e = m[eid];
          if (e) Object.assign(e, applyEmailPatch(e, patch));
        }
      }));
    }
  }

  /** Drop mailboxes from the store, and with them the live queries that list them. */
  private forgetMailboxes(ids: Id[]): void {
    if (!ids.length) return;
    const gone = new Set(ids);
    solidBatch(() => {
      this.set('mailboxes', produce((m) => ids.forEach((id) => delete m[id])));
      for (const q of Object.values(this.state.queries)) {
        const f = q.filter as Record<string, unknown> | null;
        if (!f || Object.keys(f).length !== 1 || typeof f.inMailbox !== 'string' || !gone.has(f.inMailbox)) continue;
        this.ranges.delete(q.key);
        this.set('queries', produce((all) => void delete all[q.key]));
      }
    });
  }
```

In `catchUpOnce`, replace the line

```ts
        this.set('mailboxes', produce((m) => ch.destroyed.forEach((id) => delete m[id])));
```

with

```ts
        this.forgetMailboxes(ch.destroyed);
```

and make the `queryChanges` loop skip queries that were just dropped, by adding as the first line of the `for (const { q, call } of qcs)` body:

```ts
        if (!this.state.queries[q.key]) continue;
```

In `resetQuery`, add as the first line:

```ts
    if (!this.state.queries[key]) return;
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/sync/fake-jmap.ts src/sync/engine.ts src/sync/engine.test.ts
git commit -m "Delete labels without deleting mail; drop the queries of a destroyed mailbox"
```

---

### Task 5: App layer: labels, confirm with a pending action, removeLabel

**Files:**
- Create: `src/app/labels.ts`, `src/app/labels.test.ts`, `src/app/actions.test.ts`
- Modify: `src/ui/ConfirmDialog.tsx`, `src/app/actions.ts`, `src/app/context.tsx`, `src/index.tsx`

**Interfaces:**
- Consumes: `planLabel`, `labelLimits`, `DEFAULT_LIMITS`, `LabelLimits`, `PlanResult` (Task 1); `subLabelCount`, `labelPath` (Task 2); `unlabelPatch`, `onlyIn` (Task 2); `MailEngine.createLabel / updateLabel / countOrphans / destroyLabel` (Tasks 3, 4).
- Produces:
  - `ConfirmOptions.run?: () => Promise<void>` and `ConfirmOptions.pendingLabel?: string`
  - `createLabels(engine: MailEngine, toast: ToastFn, confirm: ConfirmFn, limits: () => LabelLimits)` returning
    `{ validate(path: string, renaming?: Id): PlanResult; create(path: string, opts?: { quiet?: boolean }): Promise<Id>; rename(id: Id, path: string): Promise<void>; remove(id: Id): Promise<boolean>; deletedHere(id: Id): boolean }`
  - `type Labels = ReturnType<typeof createLabels>`; `deleteMessage(totalEmails: number, totalThreads: number, orphans: number | null): string`
  - `actions.removeLabel(threadIds: Id[], label: Id): Promise<void>`
  - `App.labels: Labels`

- [ ] **Step 1: Let the confirm dialog run an action while it stays open**

Replace `src/ui/ConfirmDialog.tsx` with:

```tsx
import { Dialog } from '@rozie-ui/dialog-solid';
import { createSignal, Show, type JSX } from 'solid-js';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Work to do on confirm. The dialog stays open, showing `pendingLabel`, until it settles. */
  run?: () => Promise<void>;
  pendingLabel?: string;
}

export interface ConfirmFn {
  /** Resolves whether the user confirmed. With `run`, resolves after it finished and rejects if it failed. */
  (opts: ConfirmOptions): Promise<boolean>;
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
  reject: (e: unknown) => void;
}

/** A single blocking confirm dialog, queued one at a time via `confirm()`. */
export function createConfirmDialog(): { confirm: ConfirmFn; Host: () => JSX.Element } {
  const [pending, setPending] = createSignal<Pending | null>(null);
  const [busy, setBusy] = createSignal(false);

  const confirm: ConfirmFn = (opts) => new Promise((resolve, reject) => setPending({ opts, resolve, reject }));

  const finish = (ok: boolean) => {
    const p = pending();
    if (!p || busy()) return;
    if (ok && p.opts.run) {
      setBusy(true);
      p.opts.run().then(() => p.resolve(true), p.reject).finally(() => {
        setBusy(false);
        setPending(null);
      });
      return;
    }
    p.resolve(ok);
    setPending(null);
  };

  const Host = () => (
    <Show when={pending()}>
      {(p) => (
        <Dialog open onOpenChange={(open) => !open && finish(false)} ariaLabelledby="confirm-title">
          <h2 id="confirm-title">{p().opts.title}</h2>
          <p>{p().opts.message}</p>
          <div class="dialog-actions">
            <button disabled={busy()} onClick={() => finish(false)}>Cancel</button>
            <button class="danger" disabled={busy()} onClick={() => finish(true)} autofocus>
              {busy() ? (p().opts.pendingLabel ?? p().opts.confirmLabel ?? 'Confirm') : (p().opts.confirmLabel ?? 'Confirm')}
            </button>
          </div>
        </Dialog>
      )}
    </Show>
  );

  return { confirm, Host };
}
```

- [ ] **Step 2: Write the failing tests for the label operations**

Create `src/app/labels.test.ts`:

```ts
import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../mail/labels';
import { MailEngine } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import type { ConfirmFn, ConfirmOptions } from '../ui/ConfirmDialog';
import type { ToastFn } from './actions';
import { createLabels, deleteMessage } from './labels';

describe('deleteMessage', () => {
  it('says an empty label is empty', () => {
    expect(deleteMessage(0, 0, 0)).toBe('This label is empty.');
  });

  it('says how many conversations stay and how many move to Archive', () => {
    expect(deleteMessage(14, 12, 5)).toBe('Its 12 conversations stay in your mail. 5 that are only in this label move to Archive.');
    expect(deleteMessage(1, 1, 1)).toBe('Its 1 conversation stays in your mail. 1 that is only in this label moves to Archive.');
  });

  it('leaves the Archive sentence out when nothing is only in the label', () => {
    expect(deleteMessage(3, 3, 0)).toBe('Its 3 conversations stay in your mail.');
  });

  it('stays general when the count is unknown', () => {
    expect(deleteMessage(3, 3, null)).toBe('Its 3 conversations stay in your mail. Any that are only in this label move to Archive.');
  });
});

describe('createLabels', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  let toast: ReturnType<typeof vi.fn<ToastFn>>;
  let asked: ConfirmOptions | null;
  let answer: boolean;
  let labels: ReturnType<typeof createLabels>;

  beforeEach(async () => {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    server.addMailbox('A', 'Archive', 'archive');
    server.addMailbox('W', 'Work');
    server.addMailbox('C', 'Clients');
    server.addMailbox('K', 'Acme', null, 'C');
    server.addEmail({ id: 'w1', threadId: 't1', receivedAt: '2026-09-01T10:00:00Z', mailboxIds: { W: true } }, false);
    server.addEmail({ id: 'w2', threadId: 't2', receivedAt: '2026-09-01T11:00:00Z', mailboxIds: { W: true, I: true } }, false);
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    toast = vi.fn<ToastFn>();
    asked = null;
    answer = true;
    const confirm: ConfirmFn = async (opts) => {
      asked = opts;
      if (!answer) return false;
      await opts.run?.();
      return true;
    };
    labels = createLabels(engine, toast, confirm, () => DEFAULT_LIMITS);
  });

  it('creates a label and says so', async () => {
    const id = await labels.create('clients/New');
    expect(engine.state.mailboxes[id]).toMatchObject({ name: 'New', parentId: 'C' });
    expect(toast).toHaveBeenCalledWith("Created 'Clients/New'.", 'success');
  });

  it('creates quietly for the pickers', async () => {
    await labels.create('Quiet', { quiet: true });
    expect(toast).not.toHaveBeenCalled();
  });

  it('rejects an invalid path with the validation message and sends nothing', async () => {
    server.calls = [];
    await expect(labels.create('work')).rejects.toThrow("A label named 'Work' already exists.");
    expect(server.calls).toEqual([]);
  });

  it('renames and says so', async () => {
    await labels.rename('W', 'Jobs');
    expect(engine.state.mailboxes.W?.name).toBe('Jobs');
    expect(toast).toHaveBeenCalledWith("Renamed to 'Jobs'.", 'success');
  });

  it('sends nothing for a rename that changes nothing', async () => {
    server.calls = [];
    await labels.rename('W', ' Work ');
    expect(server.calls).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('refuses to delete a label that has sub-labels, without asking', async () => {
    expect(await labels.remove('C')).toBe(false);
    expect(asked).toBeNull();
    expect(server.mailboxes.has('C')).toBe(true);
  });

  it('refuses to delete a system mailbox', async () => {
    expect(await labels.remove('I')).toBe(false);
    expect(asked).toBeNull();
  });

  it('asks with the counts, deletes, and says so', async () => {
    expect(await labels.remove('W')).toBe(true);
    expect(asked).toMatchObject({
      title: "Delete 'Work'?",
      message: 'Its 2 conversations stay in your mail. 1 that is only in this label moves to Archive.',
      confirmLabel: 'Delete',
      pendingLabel: 'Deleting…',
    });
    expect(server.mailboxes.has('W')).toBe(false);
    expect(server.emails.get('w1')?.mailboxIds).toEqual({ A: true });
    expect(labels.deletedHere('W')).toBe(true);
    expect(toast).toHaveBeenCalledWith("Deleted 'Work'.", 'success');
  });

  it('marks the label as deleted here before the store drops it', async () => {
    const seen: boolean[] = [];
    server.onCall = (name, args) => {
      if (name === 'Mailbox/set' && args.destroy) seen.push(labels.deletedHere('W'));
    };
    await labels.remove('W');
    expect(seen).toEqual([true]);
  });

  it('keeps the wording general when the count fails', async () => {
    server.onCall = (name, args) => {
      if (name === 'Email/query' && args.limit === 1) throw new Error('boom');
    };
    await labels.remove('W');
    expect(asked?.message).toBe('Its 2 conversations stay in your mail. Any that are only in this label move to Archive.');
    expect(server.mailboxes.has('W')).toBe(false);
  });

  it('does nothing when the user cancels', async () => {
    answer = false;
    expect(await labels.remove('W')).toBe(false);
    expect(server.mailboxes.has('W')).toBe(true);
    expect(labels.deletedHere('W')).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('reports a delete that stopped halfway', async () => {
    server.rejectUpdates.add('w1');
    expect(await labels.remove('W')).toBe(false);
    expect(server.mailboxes.has('W')).toBe(true);
    expect(labels.deletedHere('W')).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      "Couldn't finish deleting 'Work'. Some conversations may already have been removed from it; try again. (forbidden)",
      'error',
    );
  });
});
```

Create `src/app/actions.test.ts`:

```ts
import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SORT, MailEngine } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import { createActions, type ToastFn } from './actions';

describe('actions.removeLabel', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  let toast: ReturnType<typeof vi.fn<ToastFn>>;
  let actions: ReturnType<typeof createActions>;

  async function setup(withArchive: boolean) {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    if (withArchive) server.addMailbox('A', 'Archive', 'archive');
    server.addMailbox('W', 'Work');
    // Thread t1: one message only in Work, one in Work and Inbox.
    server.addEmail({ id: 'w1', threadId: 't1', receivedAt: '2026-09-01T10:00:00Z', mailboxIds: { W: true } }, false);
    server.addEmail({ id: 'w2', threadId: 't1', receivedAt: '2026-09-01T11:00:00Z', mailboxIds: { W: true, I: true } }, false);
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    const key = engine.openQuery({ filter: { inMailbox: 'W' }, sort: DEFAULT_SORT, collapseThreads: true });
    await engine.ensureRange(key, 0, 10);
    toast = vi.fn<ToastFn>();
    actions = createActions(engine, toast, async () => true);
  }

  beforeEach(() => setup(true));

  it('takes the label off the thread, archiving a message with no other mailbox', async () => {
    await actions.removeLabel(['t1'], 'W');
    expect(server.emails.get('w1')?.mailboxIds).toEqual({ A: true });
    expect(server.emails.get('w2')?.mailboxIds).toEqual({ I: true });
    expect(toast).toHaveBeenCalledWith("Removed 'Work'.", 'info', expect.objectContaining({ label: 'Undo' }));
  });

  it('undo puts the label back', async () => {
    await actions.removeLabel(['t1'], 'W');
    toast.mock.calls[0]![2]!.run();
    await vi.waitFor(() => expect(server.emails.get('w1')?.mailboxIds).toEqual({ W: true }));
    expect(server.emails.get('w2')?.mailboxIds).toEqual({ W: true, I: true });
  });

  it('creates Archive when it is needed and missing', async () => {
    await setup(false);
    await actions.removeLabel(['t1'], 'W');
    const archive = [...server.mailboxes.values()].find((m) => m.role === 'archive');
    expect(archive).toBeDefined();
    expect(server.emails.get('w1')?.mailboxIds).toEqual({ [archive!.id]: true });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm exec vitest run src/app/labels.test.ts src/app/actions.test.ts`
Expected: FAIL, cannot resolve `./labels`; `actions.removeLabel is not a function`.

- [ ] **Step 4: Implement the label operations**

Create `src/app/labels.ts`:

```ts
import type { Id } from '../jmap/types';
import { planLabel, type LabelLimits, type PlanResult } from '../mail/labels';
import type { MailEngine } from '../sync/engine';
import { labelPath, subLabelCount } from '../sync/selectors';
import type { ConfirmFn } from '../ui/ConfirmDialog';
import type { ToastFn } from './actions';

/** The confirm text for deleting a label. `orphans` is null when the count couldn't be fetched. */
export function deleteMessage(totalEmails: number, totalThreads: number, orphans: number | null): string {
  if (totalEmails === 0) return 'This label is empty.';
  const kept = `Its ${totalThreads} conversation${totalThreads === 1 ? ' stays' : 's stay'} in your mail.`;
  if (orphans === null) return `${kept} Any that are only in this label move to Archive.`;
  if (orphans === 0) return kept;
  return `${kept} ${orphans} that ${orphans === 1 ? 'is' : 'are'} only in this label move${orphans === 1 ? 's' : ''} to Archive.`;
}

/** Creating, renaming and deleting labels: validation, confirmation and toasts around the engine. */
export function createLabels(engine: MailEngine, toast: ToastFn, confirm: ConfirmFn, limits: () => LabelLimits) {
  const deleted = new Set<Id>();
  const validate = (path: string, renaming?: Id): PlanResult => planLabel(path, engine.state.mailboxes, limits(), renaming);

  return {
    validate,

    /** True for a label deleted in this session: its view closes without the "no longer exists" notice. */
    deletedHere: (id: Id) => deleted.has(id),

    /** Throws the validation or server message. `quiet` skips the toast (the pickers show their own). */
    async create(path: string, opts: { quiet?: boolean } = {}): Promise<Id> {
      const r = validate(path);
      if (!r.ok) throw new Error(r.error);
      const id = await engine.createLabel(r.plan);
      if (!opts.quiet) toast(`Created '${r.path}'.`, 'success');
      return id;
    },

    /** Throws the validation or server message. */
    async rename(id: Id, path: string): Promise<void> {
      const r = validate(path, id);
      if (!r.ok) throw new Error(r.error);
      if (r.noop) return;
      await engine.updateLabel(id, r.plan);
      toast(`Renamed to '${r.path}'.`, 'success');
    },

    /** Confirm, then delete. Resolves whether the label was deleted. */
    async remove(id: Id): Promise<boolean> {
      const mb = engine.state.mailboxes[id];
      if (!mb || mb.role || subLabelCount(id, engine.state.mailboxes) > 0) return false;
      const path = labelPath(mb, engine.state.mailboxes);
      // The count only improves the wording.
      const orphans = await engine.countOrphans(id).catch(() => null);
      try {
        const ok = await confirm({
          title: `Delete '${path}'?`,
          message: deleteMessage(mb.totalEmails, mb.totalThreads, orphans),
          confirmLabel: 'Delete',
          pendingLabel: 'Deleting…',
          run: async () => {
            // Before the store drops the mailbox, so its view knows why it disappeared.
            deleted.add(id);
            try {
              await engine.destroyLabel(id);
            } catch (e) {
              deleted.delete(id);
              throw e;
            }
          },
        });
        if (!ok) return false;
      } catch (e) {
        toast(`Couldn't finish deleting '${path}'. Some conversations may already have been removed from it; try again. (${(e as Error).message})`, 'error');
        return false;
      }
      toast(`Deleted '${path}'.`, 'success');
      return true;
    },
  };
}

export type Labels = ReturnType<typeof createLabels>;
```

- [ ] **Step 5: Implement `removeLabel`**

In `src/app/actions.ts`, change the patch import to:

```ts
import { archivePatch, keywordPatch, movePatch, onlyIn, trashPatch, unlabelPatch, type EmailPatch } from '../sync/patch';
```

and add after `addLabel`:

```ts
    /** Take a label off conversations. A message left in no mailbox goes to Archive. */
    async removeLabel(threadIds: Id[], label: Id) {
      const emails = engine.threadEmails(threadIds);
      let archive = role('archive') ?? '';
      if (!archive && emails.some((e) => onlyIn(e, label))) {
        try {
          archive = await engine.ensureMailbox('archive', 'Archive');
        } catch (e) {
          toast((e as Error).message, 'error');
          return;
        }
      }
      const name = engine.state.mailboxes[label]?.name ?? 'label';
      await moveWithUndo(emails, unlabelPatch(emails, label, archive), `Removed '${name}'.`);
    },
```

- [ ] **Step 6: Wire `labels` into the app**

In `src/app/context.tsx`, add the import `import type { Labels } from './labels';` and the field after `actions: Actions;`:

```ts
  labels: Labels;
```

In `src/index.tsx`, add the imports:

```ts
import { createLabels } from './app/labels';
import { DEFAULT_LIMITS, labelLimits } from './mail/labels';
```

and in the `app` object, after the `actions:` line:

```ts
    labels: createLabels(engine, toasts.toast, confirmDialog.confirm, () => (client.hasSession ? labelLimits(client.session) : DEFAULT_LIMITS)),
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/app/labels.ts src/app/labels.test.ts src/app/actions.ts src/app/actions.test.ts src/app/context.tsx src/index.tsx src/ui/ConfirmDialog.tsx
git commit -m "Add label operations with confirm and toasts; remove a label from conversations"
```

---

### Task 6: Sidebar, the create/rename dialog, and the dead-label redirect

**Files:**
- Create: `src/ui/LabelDialog.tsx`, `e2e/support/labels.ts`, `e2e/labels.spec.ts`
- Modify: `src/ui/nav.ts`, `src/ui/Shell.tsx`, `src/ui/keyboard.ts`, `src/ui/icons.tsx`, `src/ui/styles.css`, `e2e/cleanup.ts`, `e2e/global-setup.ts`

**Interfaces:**
- Consumes: `App.labels` (Task 5); `isLabel`, `subLabelCount`, `labelPath` (Task 2); `MailState.synced` (Task 4); rozie `Dialog`, `Popover`.
- Produces:
  - `nav.labelDialog(): LabelDialogState | null`, `nav.setLabelDialog(s)`, with `type LabelDialogState = { kind: 'create' } | { kind: 'rename'; id: Id }`
  - `<LabelDialog />`
  - e2e helpers in `e2e/support/labels.ts`: `allMailboxes`, `pathOf`, `labelByPath`, `createLabel`, `destroyLabel`, `destroyE2eLabels`
  - DOM hooks later tasks and tests use: sidebar rows are `.nav-row`; the menu button is named `Options for <path>`; menu items have `role="menuitem"`.

- [ ] **Step 1: Write the e2e helpers**

Create `e2e/support/labels.ts`:

```ts
// Labels (mailboxes without a role), arranged and checked straight through JMAP.
import { accountId, ALICE, jmap } from './mail';

export interface LabelInfo {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
}

export async function allMailboxes(user = ALICE): Promise<LabelInfo[]> {
  const r = await jmap([['Mailbox/get', { accountId: await accountId(user), properties: ['name', 'parentId', 'role'] }, 'm']], user);
  return r.m.list as LabelInfo[];
}

export function pathOf(mb: LabelInfo, all: LabelInfo[]): string {
  const parts = [mb.name];
  let parent = all.find((m) => m.id === mb.parentId);
  while (parent) {
    parts.unshift(parent.name);
    const next = parent.parentId;
    parent = all.find((m) => m.id === next);
  }
  return parts.join('/');
}

export async function labelByPath(path: string, user = ALICE): Promise<LabelInfo | undefined> {
  const all = await allMailboxes(user);
  return all.find((m) => pathOf(m, all) === path);
}

/** Create a label and any missing parents. Returns the leaf's id. */
export async function createLabel(path: string, user = ALICE): Promise<string> {
  const acct = await accountId(user);
  const all = await allMailboxes(user);
  let parentId: string | null = null;
  let soFar = '';
  for (const name of path.split('/')) {
    soFar = soFar ? `${soFar}/${name}` : name;
    const existing = all.find((m) => pathOf(m, all) === soFar);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const r = await jmap([['Mailbox/set', { accountId: acct, create: { c: { name, parentId, isSubscribed: true } } }, 's']], user);
    parentId = r.s.created.c.id as string;
  }
  return parentId!;
}

export async function destroyLabel(id: string, user = ALICE): Promise<void> {
  await jmap([['Mailbox/set', { accountId: await accountId(user), destroy: [id], onDestroyRemoveEmails: true }, 'd']], user);
}

/** Destroy every label under a top-level `e2e-…` label, deepest first, with the test mail in it. */
export async function destroyE2eLabels(user = ALICE): Promise<number> {
  const all = await allMailboxes(user);
  const mine = all.filter((m) => !m.role && pathOf(m, all).startsWith('e2e-'));
  const depth = (m: LabelInfo) => pathOf(m, all).split('/').length;
  mine.sort((a, b) => depth(b) - depth(a));
  for (const m of mine) await destroyLabel(m.id, user);
  return mine.length;
}
```

In `e2e/cleanup.ts`, add `'Label test'` to the prefix list:

```ts
    for (const prefix of ['Push test', 'Archive target', 'Archive neighbour', 'Compose test', 'Label test']) {
```

In `e2e/global-setup.ts`, add the import `import { destroyE2eLabels } from './support/labels';` and, after the `if (removed) console.log(…)` line:

```ts
  const labels = await destroyE2eLabels();
  if (labels) console.log(`e2e: removed ${labels} leftover test label(s)`);
```

- [ ] **Step 2: Write the failing e2e tests**

Create `e2e/labels.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows, threadList, waitLive } from './support/app';
import { createLabel, destroyE2eLabels, destroyLabel, labelByPath } from './support/labels';
import { deliverToAlice, destroyEmails, mailboxByRole, threadEmails, uniqueTag, updateEmails } from './support/mail';

const created: string[] = [];
test.afterEach(async () => {
  await destroyEmails(created.splice(0));
  await destroyE2eLabels();
});

const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const labelRow = (page: Page, path: string) =>
  page.locator('nav.sidebar .nav-row').filter({ has: page.locator('.name', { hasText: exact(path) }) });
const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text });
const createDialog = (page: Page) => page.getByRole('dialog', { name: 'New label' });
const nameField = (page: Page) => page.getByRole('textbox', { name: 'Label name' });

async function openMenu(page: Page, path: string) {
  await labelRow(page, path).hover();
  await page.getByRole('button', { name: `Options for ${path}`, exact: true }).click();
}

test('"+" creates a label that appears in the sidebar; a double submit creates it once', async ({ page }) => {
  const tag = uniqueTag();
  await openInbox(page);
  await page.getByRole('button', { name: 'New label' }).click();
  await expect(createDialog(page)).toBeVisible();
  await expect(nameField(page)).toBeFocused();
  await nameField(page).fill(tag);
  // Two submits in one tick, as a fast double Enter would produce.
  await nameField(page).evaluate((el) => {
    const form = (el as HTMLInputElement).form!;
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(createDialog(page)).toBeHidden();
  await expect(labelRow(page, tag)).toHaveCount(1);
  await expect(toast(page, `Created '${tag}'.`)).toBeVisible();
  await expect(toast(page, 'already exists')).toHaveCount(0);
  expect(await labelByPath(tag)).toBeDefined();
});

test('a path creates the parent too; a duplicate and an empty segment are refused inline', async ({ page }) => {
  const tag = uniqueTag();
  await openInbox(page);
  await page.getByRole('button', { name: 'New label' }).click();
  await nameField(page).fill(`${tag}/Child`);
  await nameField(page).press('Enter');
  await expect(createDialog(page)).toBeHidden();
  await expect(labelRow(page, tag)).toBeVisible();
  await expect(labelRow(page, `${tag}/Child`)).toBeVisible();
  const child = await labelByPath(`${tag}/Child`);
  expect(child?.parentId).toBe((await labelByPath(tag))?.id);

  await page.getByRole('button', { name: 'New label' }).click();
  await nameField(page).fill(`${tag}/child`);
  await nameField(page).press('Enter');
  const error = createDialog(page).getByRole('alert');
  await expect(error).toHaveText(`A label named '${tag}/Child' already exists.`);
  // Once an error shows, it follows the typing.
  await nameField(page).fill(`${tag}//x`);
  await expect(error).toHaveText("A label name can't be empty.");
  await createDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(createDialog(page)).toBeHidden();
  expect(await labelByPath(`${tag}/x`)).toBeUndefined();
});

test('renaming the label being viewed changes the title and sidebar, not the URL', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(tag);
  await page.goto(`/label/${id}`);
  await expect(threadList(page)).toHaveAttribute('aria-label', tag);

  await openMenu(page, tag);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename label' });
  await expect(nameField(page)).toHaveValue(tag);
  await expect(nameField(page)).toBeFocused();
  await nameField(page).fill(`${tag}-renamed`);
  await nameField(page).press('Enter');

  await expect(dialog).toBeHidden();
  await expect(threadList(page)).toHaveAttribute('aria-label', `${tag}-renamed`);
  await expect(labelRow(page, `${tag}-renamed`)).toBeVisible();
  await expect(labelRow(page, tag)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/label/${id}$`));
  expect((await labelByPath(`${tag}-renamed`))?.id).toBe(id);
});

test('renaming to another parent moves the label', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(`${tag}/Acme`);
  await openInbox(page);
  await expect(labelRow(page, `${tag}/Acme`)).toBeVisible();

  await openMenu(page, `${tag}/Acme`);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await nameField(page).fill(`${tag}-b/Acme`);
  await nameField(page).press('Enter');

  await expect(labelRow(page, `${tag}-b/Acme`)).toBeVisible();
  await expect(labelRow(page, `${tag}-b`)).toBeVisible();
  await expect(labelRow(page, `${tag}/Acme`)).toHaveCount(0);
  await expect(labelRow(page, tag)).toBeVisible();
  expect((await labelByPath(`${tag}-b/Acme`))?.id).toBe(id);
});

test('deleting a label keeps its mail: shared mail loses the label, mail only there moves to Archive', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(tag);
  const inbox = await mailboxByRole('inbox');
  const both = await deliverToAlice({ from: 'Both <both@partner.test>', subject: `Label test ${tag} both`, text: 'in the inbox and the label' });
  const only = await deliverToAlice({ from: 'Only <only@partner.test>', subject: `Label test ${tag} only`, text: 'only in the label' });
  created.push(both.id, only.id);
  await updateEmails({ [both.id]: { [`mailboxIds/${id}`]: true }, [only.id]: { mailboxIds: { [id]: true } } });

  await page.goto(`/label/${id}`);
  await expect(rows(page)).toHaveCount(2);
  await openMenu(page, tag);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete '${tag}'?` });
  await expect(dialog).toContainText('Its 2 conversations stay in your mail. 1 that is only in this label moves to Archive.');
  await dialog.getByRole('button', { name: 'Delete' }).click();

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(toast(page, `Deleted '${tag}'.`)).toBeVisible();
  await expect(toast(page, 'no longer exists')).toHaveCount(0);
  await expect(labelRow(page, tag)).toHaveCount(0);
  expect(await labelByPath(tag)).toBeUndefined();
  const archive = await mailboxByRole('archive');
  expect((await threadEmails(both.threadId))[0]!.mailboxIds).toEqual({ [inbox]: true });
  expect((await threadEmails(only.threadId))[0]!.mailboxIds).toEqual({ [archive]: true });
});

test('a label with a sub-label cannot be deleted; the menu works from the keyboard', async ({ page }) => {
  const tag = uniqueTag();
  await createLabel(`${tag}/Child`);
  await openInbox(page);
  await expect(labelRow(page, `${tag}/Child`)).toBeVisible();

  await openMenu(page, tag);
  const rename = page.getByRole('menuitem', { name: 'Rename' });
  const del = page.getByRole('menuitem', { name: 'Delete (has 1 sub-label)' });
  await expect(rename).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(del).toBeFocused();
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(del).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Options for ${tag}`, exact: true })).toBeFocused();
  expect(await labelByPath(tag)).toBeDefined();
});

test('a label deleted by another client while it is being viewed sends the view to the Inbox', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(tag);
  await page.goto(`/label/${id}`);
  await expect(threadList(page)).toHaveAttribute('aria-label', tag);
  await waitLive(page);

  await destroyLabel(id);
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(toast(page, 'That label no longer exists.')).toBeVisible();
  await expect(labelRow(page, tag)).toHaveCount(0);

  // A stale link to it lands on the Inbox too.
  await page.goto(`/label/${id}`);
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(rows(page).first()).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e tests to see them fail**

Run: `pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test labels`
Expected: every test FAILS (no "New label" button, no `.nav-row`, no redirect).

- [ ] **Step 4: Add the dialog state to nav and keep shortcuts out of the dialog**

In `src/ui/nav.ts`, add after `PickerKind`:

```ts
export type LabelDialogState = { kind: 'create' } | { kind: 'rename'; id: Id };
```

inside `createNav`, after the `helpOpen` signal:

```ts
  const [labelDialog, setLabelDialog] = createSignal<LabelDialogState | null>(null);
```

and in the returned object, after `setHelpOpen,`:

```ts
    labelDialog,
    setLabelDialog,
```

In `src/ui/keyboard.ts`, in `onKey`, add before the `if (nav.picker() || nav.helpOpen())` block:

```ts
    if (nav.labelDialog()) return;
```

- [ ] **Step 5: Add the "add" icon**

In `src/ui/icons.tsx`, add to `paths` after `more`:

```ts
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
```

- [ ] **Step 6: Write the dialog**

Create `src/ui/LabelDialog.tsx`:

```tsx
import { Dialog } from '@rozie-ui/dialog-solid';
import { createEffect, createSignal, onMount, Show } from 'solid-js';
import { useApp } from '../app/context';
import { labelPath } from '../sync/selectors';
import type { LabelDialogState } from './nav';

/** Create and rename share one dialog: a single path field, checked by the same rules. */
export function LabelDialog() {
  const { nav } = useApp();
  return (
    <Show when={nav.labelDialog()} keyed>
      {(state) => <LabelForm state={state} />}
    </Show>
  );
}

function LabelForm(props: { state: LabelDialogState }) {
  const { engine, labels, nav } = useApp();
  const renaming = props.state.kind === 'rename' ? props.state.id : undefined;
  const current = renaming ? engine.state.mailboxes[renaming] : undefined;
  const [text, setText] = createSignal(current ? labelPath(current, engine.state.mailboxes) : '');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;

  // rozie Dialog opens its <dialog> in its own onMount, which runs after this one.
  onMount(() => queueMicrotask(() => {
    input?.focus();
    input?.select();
  }));

  // The label was deleted elsewhere while its rename dialog was open.
  createEffect(() => {
    if (renaming && !engine.state.mailboxes[renaming]) nav.setLabelDialog(null);
  });

  const close = () => {
    if (!busy()) nav.setLabelDialog(null);
  };

  const onInput = (value: string) => {
    setText(value);
    // Correct the message as the user types, but only once one is showing.
    if (!error()) return;
    const check = labels.validate(value, renaming);
    setError(check.ok ? '' : check.error);
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    try {
      if (renaming) await labels.rename(renaming, text());
      else await labels.create(text());
      nav.setLabelDialog(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const action = () => (renaming ? (busy() ? 'Saving…' : 'Save') : busy() ? 'Creating…' : 'Create');

  return (
    <Dialog open onOpenChange={(open) => !open && close()} ariaLabelledby="label-dialog-title">
      <form class="label-form" onSubmit={submit}>
        <h2 id="label-dialog-title">{renaming ? 'Rename label' : 'New label'}</h2>
        <input
          ref={input}
          type="text"
          aria-label="Label name"
          aria-invalid={!!error()}
          aria-describedby="label-dialog-hint label-dialog-error"
          autocomplete="off"
          spellcheck={false}
          value={text()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
        <p id="label-dialog-hint" class="label-hint">Use / to nest, e.g. Clients/Acme</p>
        <p id="label-dialog-error" class="label-error" role="alert">{error()}</p>
        <div class="dialog-actions">
          <button type="button" onClick={close}>Cancel</button>
          <button type="submit" class="primary" disabled={busy()}>{action()}</button>
        </div>
      </form>
    </Dialog>
  );
}
```

- [ ] **Step 7: Add the sidebar controls and the redirect**

In `src/ui/Shell.tsx`:

Change the imports:

```ts
import { Popover } from '@rozie-ui/popover-solid';
import { A, useLocation, useNavigate, useParams, type RouteSectionProps } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, lazy, on, onCleanup, Show, type JSX } from 'solid-js';
import { useApp } from '../app/context';
import type { Mailbox } from '../jmap/types';
import { isLabel, labelPath, mailboxSlug, resolveView, searchSlug, sidebarMailboxes, subLabelCount } from '../sync/selectors';
```

and add `import { LabelDialog } from './LabelDialog';` with the other `./` imports.

In `Shell`'s JSX, add `<LabelDialog />` after `<HelpDialog />`.

In `Sidebar`, change the first line to `const { engine, hasCalendars, nav } = useApp();` and replace the `<Show when={groups().labels.length}> … </Show>` block with:

```tsx
      <div class="nav-section">
        <span>Labels</span>
        <button class="icon-btn nav-add" type="button" aria-label="New label" title="New label" onClick={() => nav.setLabelDialog({ kind: 'create' })}>
          <Icon name="add" />
        </button>
      </div>
      <For each={groups().labels}>
        {(mb) => (
          <div class="nav-row">
            {item(mb, mailboxSlug(mb), labelPath(mb, engine.state.mailboxes), 'label', mb.unreadThreads)}
            <Show when={isLabel(mb)}>
              <LabelMenu mailbox={mb} />
            </Show>
          </div>
        )}
      </For>
```

Add after `Sidebar`:

```tsx
/** The "⋯" menu of a label row: Rename and Delete. */
function LabelMenu(props: { mailbox: Mailbox }) {
  const { engine, labels, nav } = useApp();
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const path = () => labelPath(props.mailbox, engine.state.mailboxes);
  const subs = createMemo(() => subLabelCount(props.mailbox.id, engine.state.mailboxes));
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => items()[0]?.focus({ preventScroll: true }));
  }, { defer: true }));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      button?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  };

  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };

  return (
    <span class="nav-menu">
      <Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="manual"
        placement="bottom-end"
        strategy="fixed"
        offset={4}
        anchorSlot={() => (
          <button
            ref={button}
            class="icon-btn nav-more"
            type="button"
            aria-label={`Options for ${path()}`}
            aria-haspopup="menu"
            aria-expanded={open()}
            onClick={() => setOpen(!open())}
          >
            <Icon name="more" />
          </button>
        )}
      >
        <div class="menu" role="menu" aria-label={`Options for ${path()}`} ref={menu} onKeyDown={onKeyDown}>
          <button type="button" role="menuitem" onClick={() => choose(() => nav.setLabelDialog({ kind: 'rename', id: props.mailbox.id }))}>
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            aria-disabled={subs() > 0}
            onClick={() => subs() === 0 && choose(() => void labels.remove(props.mailbox.id))}
          >
            {subs() > 0 ? `Delete (has ${subs()} sub-label${subs() === 1 ? '' : 's'})` : 'Delete'}
          </button>
        </div>
      </Popover>
    </span>
  );
}
```

In `MailView`, change the first lines and add the redirect before `return`:

```tsx
  const params = useParams<{ slug?: string; id?: string; q?: string; threadId?: string }>();
  const { engine, labels, toast } = useApp();
  const navigate = useNavigate();
```

```tsx
  // A label that is gone (deleted here or elsewhere, or a stale link) has no view: go to the Inbox.
  // Only once the store has been reconciled; a warm-start snapshot may not know a new label yet.
  createEffect(() => {
    const id = params.id;
    if (!id || view() || !engine.state.synced) return;
    if (!labels.deletedHere(id)) toast('That label no longer exists.', 'info');
    navigate('/inbox', { replace: true });
  });
```

- [ ] **Step 8: Style it**

In `src/ui/styles.css`, replace the `.nav-section` rule with:

```css
.nav-section { display: flex; align-items: center; justify-content: space-between; margin: 16px 6px 4px 26px; font-size: 14px; color: var(--text-2); }
.nav-add, .nav-more { width: 28px; height: 28px; }
.nav-row { position: relative; }
.nav-row .nav-item { padding-right: 40px; }
.nav-menu {
  position: absolute; top: 2px; right: 6px;
  --rozie-popover-bg: var(--surface); --rozie-popover-color: var(--text); --rozie-popover-border: 1px solid var(--border);
  --rozie-popover-shadow: var(--shadow); --rozie-popover-padding: 4px;
}
.nav-more { opacity: 0; }
.nav-row:hover .nav-more, .nav-row:focus-within .nav-more, .nav-more[aria-expanded='true'] { opacity: 1; }
@media (hover: none) { .nav-more { opacity: 1; } }
.menu { display: flex; flex-direction: column; min-width: 160px; }
.menu [role='menuitem'] { border: 0; background: none; text-align: left; padding: 8px 12px; border-radius: 4px; cursor: pointer; color: var(--text); }
.menu [role='menuitem']:hover, .menu [role='menuitem']:focus-visible { background: var(--hover); outline: none; }
.menu [role='menuitem'][aria-disabled='true'] { color: var(--text-3); cursor: default; }
```

After the `.dialog-actions button.danger:hover` rule, add:

```css
.dialog-actions button.primary { border-color: transparent; background: var(--accent); color: var(--surface); }
.dialog-actions button:disabled { opacity: 0.6; cursor: default; }
.label-form input { width: 100%; min-width: min(360px, 70vw); padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); font: inherit; }
.label-form input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.label-form input[aria-invalid='true'] { border-color: var(--danger); }
.rozie-dialog .label-hint { margin: 6px 0 0; font-size: 12px; color: var(--text-3); }
.rozie-dialog .label-error { margin: 6px 0 16px; min-height: 18px; font-size: 13px; color: var(--danger); }
```

- [ ] **Step 9: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test labels`
Expected: unit tests and typecheck PASS; all seven tests in `labels.spec.ts` PASS.

If a test fails because of how rozie Popover or Dialog behaves (focus, dismissal, positioning), find the cause in `node_modules/@rozie-ui/*/dist/source/index.jsx` before changing the test. A behaviour that can't be had without reaching into the component's internals is a blocker: stop and tell the user.

- [ ] **Step 10: Commit**

```bash
git add src/ui/LabelDialog.tsx src/ui/Shell.tsx src/ui/nav.ts src/ui/keyboard.ts src/ui/icons.tsx src/ui/styles.css e2e/support/labels.ts e2e/labels.spec.ts e2e/cleanup.ts e2e/global-setup.ts
git commit -m "Manage labels from the sidebar: create, rename, delete; leave a label's view when it is gone"
```

---

### Task 7: "Create …" in the Move and Label pickers

**Files:**
- Create: `src/ui/picker.ts`, `src/ui/picker.test.ts`
- Modify: `src/ui/Overlays.tsx`, `e2e/labels.spec.ts`

**Interfaces:**
- Consumes: `App.labels.validate` and `App.labels.create(path, { quiet: true })` (Task 5); `actions.addLabel`, `actions.moveTo`.
- Produces: `pickerScore(label: string, query: string): number | null` (always positive for a match, so a row scored 0 sorts last).

rozie CommandPalette ranks rows with a default scorer that it doesn't export, and its `score` prop replaces that scorer for every row. Keeping the "Create" row last therefore means scoring all rows here.

- [ ] **Step 1: Write the failing unit test**

Create `src/ui/picker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pickerScore } from './picker';

describe('pickerScore', () => {
  it('ranks exact over prefix over word start over substring over subsequence', () => {
    const scores = ['Receipts', 'Receipts 2025', 'Clients/Receipts', 'Prereceipts', 'Rare cheap trips'].map((l) => pickerScore(l, 'receipts'));
    expect(scores).toEqual([5, 4, 3, 2, null]);
    expect(pickerScore('Receipts', 'rcp')).toBe(1);
  });

  it('ignores case and surrounding space', () => {
    expect(pickerScore('Receipts', '  RECEIPTS ')).toBe(5);
  });

  it('hides rows that do not match', () => {
    expect(pickerScore('Receipts', 'xyz')).toBeNull();
  });

  it('is positive for every match, so a row scored 0 sorts last', () => {
    for (const q of ['r', 'rec', 'receipts', 'rps']) expect(pickerScore('Receipts', q)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run src/ui/picker.test.ts`
Expected: FAIL, cannot resolve `./picker`.

- [ ] **Step 3: Implement the scorer**

Create `src/ui/picker.ts`:

```ts
/**
 * Rank a picker row against the typed text; null hides it. Every match scores above 0, so the
 * "Create" row can be pinned last with a score of 0. rozie CommandPalette doesn't export its
 * default scorer and `score` replaces it for all rows (docs/rozie-feedback.md).
 */
export function pickerScore(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (l === q) return 5;
  if (l.startsWith(q)) return 4;
  const at = l.indexOf(q);
  if (at > 0) return /[\s/\-_.]/.test(l[at - 1]!) ? 3 : 2;
  // A subsequence still matches, as with the default scorer: "rcp" finds "Receipts".
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 1 : null;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm exec vitest run src/ui/picker.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing e2e test**

Append to `e2e/labels.spec.ts`:

```ts
test('the Label picker creates a missing label and applies it', async ({ page }) => {
  const tag = uniqueTag();
  const mail = await deliverToAlice({ from: 'Picker <picker@partner.test>', subject: `Label test ${tag} picker`, text: 'label me' });
  created.push(mail.id);
  await page.goto(`/inbox/t/${mail.threadId}`);
  await expect(page.locator('article.msg').first()).toBeVisible();

  await page.keyboard.press('l');
  await page.getByPlaceholder('Label as…').fill(tag);
  await expect(page.getByRole('option', { name: `Create '${tag}'` })).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator('.conv-head .chip', { hasText: tag })).toBeVisible();
  await expect(toast(page, 'Labeled')).toBeVisible();
  await expect(toast(page, 'Created')).toHaveCount(0);
  await expect(labelRow(page, tag)).toBeVisible();
  const label = await labelByPath(tag);
  expect(label).toBeDefined();
  await expect.poll(async () => (await threadEmails(mail.threadId))[0]?.mailboxIds[label!.id] ?? false).toBe(true);
});

test('the pickers offer no Create row for an existing label or a system mailbox', async ({ page }) => {
  const tag = uniqueTag();
  await createLabel(tag);
  const mail = await deliverToAlice({ from: 'Picker <picker@partner.test>', subject: `Label test ${tag} nocreate`, text: 'x' });
  created.push(mail.id);
  await page.goto(`/inbox/t/${mail.threadId}`);
  await expect(page.locator('article.msg').first()).toBeVisible();

  await page.keyboard.press('l');
  await page.getByPlaceholder('Label as…').fill(tag.toUpperCase());
  await expect(page.getByRole('option', { name: tag, exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Create / })).toHaveCount(0);
  await page.getByPlaceholder('Label as…').fill('Inbox');
  await expect(page.getByRole('option', { name: /^Create / })).toHaveCount(0);
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test labels -g "picker"`
Expected: the first test FAILS (no `Create '…'` option); the second passes already.

- [ ] **Step 7: Add the Create row to the pickers**

In `src/ui/Overlays.tsx`:

Add the imports:

```ts
import type { Id } from '../jmap/types';
import { pickerScore } from './picker';
```

Add above `MailboxPicker`:

```ts
/** The id of the picker row that creates the typed label. */
const CREATE = '\u0000create';

interface PickerItem {
  id: string;
  label: string;
  group: string;
  /** For the Create row: the path to create. */
  create?: string;
}
```

In `MailboxPicker`, change the first line to `const { engine, nav, actions, labels, toast } = useApp();` and replace the `items` memo with:

```ts
  const items = createMemo<PickerItem[]>(() => {
    const p = nav.picker();
    if (!p) return [];
    const exclude = new Set(['drafts', 'flagged', ...(p.kind === 'label' ? ['inbox', 'sent', 'trash', 'junk', 'archive'] : ['sent'])]);
    const list: PickerItem[] = Object.values(engine.state.mailboxes)
      .filter((m) => !(m.role && exclude.has(m.role)) && m.id !== current()?.mailboxId)
      .map((m) => ({
        id: m.id,
        label: m.role === 'inbox' ? 'Inbox' : labelPath(m, engine.state.mailboxes),
        group: m.role ? 'System' : 'Labels',
      }))
      .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group === 'System' ? -1 : 1));
    // Typed text that is a valid new label (so not an existing path) can be created on the spot.
    const typed = query().trim();
    const plan = typed ? labels.validate(typed) : null;
    if (plan?.ok) list.push({ id: CREATE, label: `Create '${plan.path}'`, group: 'New', create: typed });
    return list;
  });
```

Add a `score` prop to `<CommandPalette>` and replace its `onSelect`:

```tsx
      score={(...args: unknown[]) => {
        const [item, q] = args as [PickerItem, string];
        return item.id === CREATE ? 0 : pickerScore(item.label, q);
      }}
      onSelect={(...args: unknown[]) => {
        const { item } = args[0] as { item: PickerItem };
        const p = nav.picker();
        const view = current();
        close();
        if (!p || !view) return;
        const apply = (id: Id) => {
          if (p.kind === 'label') actions.addLabel(p.threadIds, id);
          else actions.moveTo(p.threadIds, view, id);
          nav.clearSelection();
        };
        if (item.create === undefined) apply(item.id);
        else labels.create(item.create, { quiet: true }).then(apply, (e) => toast(`Couldn't create the label: ${(e as Error).message}`, 'error'));
      }}
```

- [ ] **Step 8: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test labels keyboard`
Expected: all PASS.

If Enter does not pick the Create row when it is the only row, read how CommandPalette chooses its active option in `node_modules/@rozie-ui/command-palette-solid/dist/source/index.jsx` before changing anything. If the row cannot be made keyboard-selectable through the documented props, that is a blocker: stop and tell the user.

- [ ] **Step 9: Commit**

```bash
git add src/ui/picker.ts src/ui/picker.test.ts src/ui/Overlays.tsx e2e/labels.spec.ts
git commit -m "Create a label from the Move and Label pickers"
```

---

### Task 8: Remove a label from the conversation header

**Files:**
- Modify: `src/ui/Conversation.tsx`, `src/ui/styles.css`, `e2e/labels.spec.ts`

**Interfaces:**
- Consumes: `actions.removeLabel(threadIds, label)` (Task 5); `isLabel` (Task 2).
- Produces: each label chip in `.conv-head` has a button named `Remove label <name>`.

- [ ] **Step 1: Write the failing e2e test**

Append to `e2e/labels.spec.ts`:

```ts
test('the "×" on a conversation chip removes the label, and Undo restores it', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(tag);
  const mail = await deliverToAlice({ from: 'Chip <chip@partner.test>', subject: `Label test ${tag} chip`, text: 'unlabel me' });
  created.push(mail.id);
  await updateEmails({ [mail.id]: { [`mailboxIds/${id}`]: true } });
  const inLabel = async () => (await threadEmails(mail.threadId))[0]?.mailboxIds[id] ?? false;

  await page.goto(`/inbox/t/${mail.threadId}`);
  const chip = page.locator('.conv-head .chip', { hasText: tag });
  await expect(chip).toBeVisible();
  await expect(page.locator('.conv-head .chip', { hasText: 'Inbox' }).getByRole('button')).toHaveCount(0);

  await page.getByRole('button', { name: `Remove label ${tag}` }).click();
  await expect(chip).toHaveCount(0);
  await expect(toast(page, `Removed '${tag}'.`)).toBeVisible();
  await expect.poll(inLabel).toBe(false);

  await toast(page, `Removed '${tag}'.`).getByRole('button', { name: 'Undo' }).click();
  await expect(chip).toBeVisible();
  await expect.poll(inLabel).toBe(true);
});

test('removing the label being viewed closes the conversation back to the label\'s list', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(tag);
  const mail = await deliverToAlice({ from: 'Chip <chip@partner.test>', subject: `Label test ${tag} viewed`, text: 'unlabel me here' });
  created.push(mail.id);
  await updateEmails({ [mail.id]: { [`mailboxIds/${id}`]: true } });

  await page.goto(`/label/${id}/t/${mail.threadId}`);
  await page.getByRole('button', { name: `Remove label ${tag}` }).click();
  await expect(page).toHaveURL(new RegExp(`/label/${id}$`));
  await expect(rows(page)).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test labels -g "chip|being viewed"`
Expected: FAIL, no button named `Remove label …`.

- [ ] **Step 3: Implement**

In `src/ui/Conversation.tsx`:

Change the selectors import to:

```ts
import { hiddenMailboxIds, isHidden, isLabel, type View } from '../sync/selectors';
```

and add `Mailbox` to the type import from `'../jmap/types'`.

Replace the `labels` memo with:

```ts
  const labels = createMemo(() => {
    const ids = new Set<Id>();
    for (const e of messages()) for (const id of Object.keys(e.mailboxIds ?? {})) ids.add(id);
    return [...ids]
      .map((id) => engine.state.mailboxes[id])
      .filter((m): m is Mailbox => !!m && (!m.role || m.role === 'inbox'))
      .map((m) => ({ id: m.id, name: m.role === 'inbox' ? 'Inbox' : m.name, removable: isLabel(m) }));
  });

  const removeLabel = (id: Id) => {
    void actions.removeLabel([props.threadId], id);
    // Without the label the conversation no longer belongs to this view.
    if (props.view.mailboxId === id) navigate(`/${props.view.slug}`);
  };
```

Replace the chips line in the header with:

```tsx
                <For each={labels()}>
                  {(l) => (
                    <span class="chip">
                      {l.name}
                      <Show when={l.removable}>
                        <button type="button" class="chip-x" aria-label={`Remove label ${l.name}`} title="Remove label" onClick={() => removeLabel(l.id)}>
                          ×
                        </button>
                      </Show>
                    </span>
                  )}
                </For>
```

In `src/ui/styles.css`, after the `.conv-head .chip` rule, add:

```css
.conv-head .chip-x { border: 0; background: none; color: inherit; cursor: pointer; padding: 0 0 0 4px; font: inherit; line-height: 1; }
.conv-head .chip-x:hover { color: var(--danger); }
```

- [ ] **Step 4: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test labels conversation`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Conversation.tsx src/ui/styles.css e2e/labels.spec.ts
git commit -m "Remove a label from a conversation with the chip's x"
```

---

### Task 9: Docs and the full run

**Files:**
- Modify: `e2e/README.md`, `docs/rozie-feedback.md`

- [ ] **Step 1: Add the coverage row**

In `e2e/README.md`, add to the coverage table after the `imap-sync.spec.ts` row:

```markdown
| `labels.spec.ts` | Label management: "+" creates a label (a double submit creates one); a path creates its parent; duplicates and empty segments are refused inline; rename keeps the URL and can move a label under another parent; delete keeps the mail (shared mail loses the label, mail only there goes to Archive) and returns to the Inbox; a label with sub-labels can't be deleted; the "⋯" menu works from the keyboard; a label deleted by another client sends its view to the Inbox; the pickers' "Create" row creates and applies a label; the chip "×" removes a label, with Undo. Labels it creates are named `e2e-…` and removed after each test. |
```

- [ ] **Step 2: Log the rozie gaps**

Append to `docs/rozie-feedback.md`:

```markdown
## CommandPalette 0.4.10 — a row pinned last needs the whole scorer replaced
Wanted: the Move/Label pickers show "Create '<typed text>'" as the last row, below every match.
`score` is the only way to order one row, and it replaces the default scorer for every row; the
default (`defaultScore` / `fuzzyMatch`) isn't exported, so we wrote our own ranking for all rows
(`src/ui/picker.ts`) to pin one. The docs suggest `return baseScore + bonus` inside `score`, which
also needs the base. Suggest exporting `defaultScore`, or passing it to `score` as a third
argument, or a first-class `creatable` row as Combobox has.
Worked well: the row is an ordinary item, so arrow keys, Enter and the group heading come free.

## Popover 0.2.4 — hosting a menu (the sidebar label "⋯")
Wanted: a menu button with Rename/Delete. There is no Menu component, so the roving focus, arrow
keys, focus-first-item and Escape-returns-focus are ours (`LabelMenu` in `src/ui/Shell.tsx`).
1. **`trigger="click"` puts `aria-haspopup="dialog"` and `aria-expanded` on the anchor wrapper
   `<div>`**, not on the consumer's button, and the value can't be `menu`. A menu button therefore
   needs `trigger="manual"` with its own ARIA, and loses the click trigger's focus return.
   Suggest passing the ARIA props through the anchor slot context, with a `popupRole` prop.
2. **The root is `display: contents`**, so a class on `<Popover>` can't place it; we wrap it in
   our own positioned `<span>`.
3. **Every panel has `id="rozie-popover-floating"`**: two open popovers would share an id.
4. The known "no external anchor" gap means one Popover instance per label row.

## Dialog 0.1.3 — fine for a form
The create/rename label dialog needed nothing extra. One note: Dialog calls `showModal()` in its
own `onMount`, which runs after the parent's, so a parent that wants to focus and select its input
has to wait a microtask. An `initialFocus` prop (element or selector) would make that explicit.
```

- [ ] **Step 3: Run the whole suite**

Run: `pnpm test && pnpm typecheck && pnpm build && pnpm e2e`
Expected: every unit test PASSES, typecheck clean, every e2e spec PASSES. Afterwards no `e2e-` label is left:

```bash
curl -s -u 'alice@example.test:oinbox-dev-pass' -H 'content-type: application/json' http://localhost:8080/jmap/ \
  -d '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Mailbox/get",{"accountId":"b","properties":["name"]},"m"]]}' | grep -c 'e2e-'
```

Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add e2e/README.md docs/rozie-feedback.md
git commit -m "Document the label tests and the rozie gaps they found"
```
