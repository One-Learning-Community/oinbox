# Label Management Deferred Minors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seventeen minor findings deferred from the label-management branch review.

**Architecture:** No new subsystem. The fixes land where the code already lives: path rules in `src/mail/labels.ts`, the sweep and query bookkeeping in `src/sync/engine.ts`, wording and guards in `src/app/`, and focus and keyboard handling in `src/ui/`. Two small files are new: `src/ui/focus.ts` (give focus back when a dialog goes away) and `src/ui/LabelMenu.tsx` (the "⋯" menu, moved out of `Shell.tsx` so it can be tested on its own).

**Tech Stack:** TypeScript strict, SolidJS 1.9, Vitest (jsdom) with `@solidjs/testing-library`, Playwright, rozie Dialog 0.1.3, Popover 0.2.4, CommandPalette 0.4.10.

**Spec:** `docs/superpowers/specs/2026-10-01-label-management-design.md` (amended in Task 9).

## The seventeen items and where they are fixed

| # | Finding | Task |
|---|---|---|
| 1 | Shortcuts (r, s, e…) fire while the "⋯" menu has focus | 6 |
| 2 | Delete confirm mixes units (conversations kept, messages archived) | 4 |
| 3 | "Mailbox not found." flashes for a new label during warm start | 7 |
| 4 | Menu: Tab leaves it open, no Home/End, focus lost after a dialog, 28px target | 5, 6 |
| 5 | Delete waits for the orphan count before the confirm opens | 4 |
| 6 | A failed sweep leaves the store stale until the next push | 2 |
| 7 | An email deleted elsewhere mid-sweep aborts the delete | 2 |
| 8 | Rename, unlabel and the engine's delete don't check for system mailboxes | 2, 4 |
| 9 | A label under a system mailbox fails validation unchanged | 1 |
| 10 | "Can't be moved inside itself" is reported before duplicate and depth | 1 |
| 11 | The too-long message can cut an emoji in half | 1 |
| 12 | Cancel in the label dialog is ignored, not disabled, while saving | 5 |
| 13 | A full cache reset keeps the queries of labels that vanished | 3 |
| 14 | Two older error paths can write to a dropped query | 3 |
| 15 | The two new dropped-query guards have no test | 3 |
| 16 | Picker scorer has an unreachable branch; Create row highlight lands on "Create" | 8 |
| 17 | The redirect's re-run could be stopped with untrack | 7 |

## Global Constraints

- No new dependencies.
- `ui/` never calls `jmap/`. JMAP calls live in `src/sync/engine.ts`.
- `onDestroyRemoveEmails: true` is never sent by the app.
- User-facing strings use straight single quotes around names: `Deleted 'Receipts'.`
- rozie gaps go in `docs/rozie-feedback.md`.
- Match the surrounding code: 2-space indent, single quotes, comments only where the code can't say it.
- Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01UMoXfxooT3CRtWKGxJtpLC`
- Commands: `pnpm test`, `pnpm typecheck`, `pnpm build`, `E2E_SKIP_SEED=1 pnpm exec playwright test labels` (needs the Docker stack in `deploy/` and a fresh `pnpm build`).

## Decisions made while planning

- **Item 2:** both numbers in the delete confirm become messages ("Its 14 messages stay in your mail. 5 that are only in this label move to Archive."). The sweep works per message, and "a conversation only in this label" has no clean meaning when a thread is split across mailboxes.
- **Item 5:** the confirm opens at once with the general wording and fills in the count when it arrives. Once the delete has started the text is frozen.
- **Item 9:** a label under a system mailbox can be renamed where it is (`Inbox/Sub` to `Inbox/Sub 2`), as well as renamed out. Nothing new can be put under a system mailbox.
- **Item 4, touch target:** on coarse pointers the sidebar rows and their buttons become 44px.
- **Item 15:** the guard in `resetQuery` gets a test that fails without it. The guard in the `queryChanges` loop cannot be told apart from its absence by any test, because Solid's store setter is a no-op for a missing key at that depth; its behaviour is pinned, not the line.

## Review Focus

1. **The rename dialog submitted unchanged for `Inbox/Sub`:** closes as a no-op. Task 1.
2. **A name of joined emoji (family, flags) over the byte limit:** the message shows whole emoji. Task 1.
3. **An email destroyed by another client between the sweep's query and its update:** the delete carries on. Task 2.
4. **A list closed while its request is in flight:** the request's failure is reported as itself, not as a `TypeError`. Task 3.
5. **Confirming the delete before the count arrives:** the confirm text does not change under the "Deleting…" button. Task 4.

---

### Task 1: Path rules (items 9, 10, 11)

**Files:**
- Modify: `src/mail/labels.ts`
- Test: `src/mail/labels.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/mail/labels.test.ts`, replace the emoji line of `'measures the name limit in UTF-8 bytes'`:

```ts
    expect(error('😀'.repeat(64))).toBe(`'${'😀'.repeat(30)}…' is too long.`);
```

Add after that test:

```ts
  it('never cuts the too-long name inside an emoji', () => {
    expect(error(`a${'😀'.repeat(64)}`)).toBe(`'a${'😀'.repeat(29)}…' is too long.`);
    const family = '👨‍👩‍👧';
    expect(error(family.repeat(31))).toBe(`'${family.repeat(30)}…' is too long.`);
  });
```

Add inside `describe('renaming', …)`:

```ts
    it('lets a label under a system mailbox be renamed where it is or moved out, but nothing be moved in', () => {
      expect(plan('Inbox/Sub', 'X')).toMatchObject({ ok: true, noop: true });
      expect(plan('inbox/Sub 2', 'X')).toEqual({ ok: true, plan: { parentId: 'I', ancestors: [], name: 'Sub 2' }, path: 'Inbox/Sub 2', noop: false });
      expect(error('Inbox/New/Sub', 'X')).toBe("'Inbox' is a system mailbox.");
      expect(error('Inbox/Receipts', 'R')).toBe("'Inbox' is a system mailbox.");
    });

    it('reports a duplicate and the depth limit before a move inside itself', () => {
      expect(error('Clients/Acme', 'C')).toBe("A label named 'Clients/Acme' already exists.");
      expect(error('Clients/x/y', 'C', { maxDepth: 2, maxNameBytes: 255 })).toBe('Labels can be nested at most 2 deep.');
    });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run src/mail/labels.test.ts`
Expected: 4 failures (emoji count, the cut emoji, `Inbox/Sub`, the order).

- [ ] **Step 3: Implement**

In `src/mail/labels.ts`, after `const encoder = new TextEncoder();`:

```ts
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The first `max` characters as a reader counts them, so the cut never lands inside an emoji. */
function clip(text: string, max: number): string {
  const parts = [...graphemes.segment(text)];
  return parts.length > max ? `${parts.slice(0, max).map((p) => p.segment).join('')}…` : text;
}
```

Replace the too-long line:

```ts
  if (long) return fail(`'${clip(long, 30)}' is too long.`);
```

Replace everything from `let parentId: Id | null = null;` down to the depth check with:

```ts
  let parentId: Id | null = null;
  const shown: string[] = [];
  let system: string | undefined;
  let insideSelf = false;
  let i = 0;
  for (; i < segments.length - 1; i++) {
    const hit = childOf(parentId, segments[i]!);
    if (!hit) break;
    if (hit.id === renaming) insideSelf = true;
    if (hit.role) system ??= hit.name;
    parentId = hit.id;
    shown.push(hit.name);
  }
  const ancestors = segments.slice(i, -1);
  const name = segments[segments.length - 1]!;
  const existing = ancestors.length ? undefined : childOf(parentId, name);

  // A label another client put under a system mailbox may be renamed where it is: nothing new goes there.
  const current = renaming ? mailboxes[renaming] : undefined;
  const inPlace = !!current && !ancestors.length && (current.parentId ?? null) === parentId;
  if (system && !inPlace) return fail(`'${system}' is a system mailbox.`);
  if (existing?.role) return fail(`'${existing.name}' is a system mailbox.`);
  if (existing && existing.id !== renaming) return fail(`A label named '${[...shown, existing.name].join('/')}' already exists.`);
  const tooDeep = `Labels can be nested at most ${limits.maxDepth} deep.`;
  if (segments.length > limits.maxDepth) return fail(tooDeep);
  if (insideSelf) return fail("A label can't be moved inside itself.");
  const below = renaming ? subtreeHeight(renaming, all) : 0;
  if (segments.length + below > limits.maxDepth) return fail(tooDeep);
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run src/mail/labels.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mail/labels.ts src/mail/labels.test.ts
git commit -m "Label paths: rename in place under a system mailbox; errors in the spec's order; whole emoji in the too-long message"
```

---

### Task 2: The delete sweep and system mailboxes in the engine (items 6, 7, 8)

**Files:**
- Modify: `src/sync/engine.ts` (`updateLabel`, `destroyLabel`, `sweepLabel`)
- Modify: `src/sync/fake-jmap.ts` (`Email/set`)
- Test: `src/sync/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `describe('MailEngine labels: delete', …)`:

```ts
  it('brings the store in line with the server when the sweep stops halfway', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    server.rejectUpdates.add('x1');
    await expect(engine.destroyLabel('W')).rejects.toThrow('forbidden');
    // x2 did lose the label on the server: the store must not wait for a push to say so.
    expect(server.emails.get('x2')?.mailboxIds).toEqual({ I: true });
    expect(engine.state.emails.x2?.mailboxIds).toEqual({ I: true });
    expect(engine.state.queries[key]!.slots).toEqual(['x1']);
  });

  it('carries on when an email of the page was deleted elsewhere in the meantime', async () => {
    server.onCall = (name) => {
      if (name === 'Email/set' && server.emails.delete('x1')) server.bump({ destroyed: ['x1'] });
    };
    await engine.destroyLabel('W');
    expect(server.mailboxes.has('W')).toBe(false);
    expect(server.emails.get('x2')?.mailboxIds).toEqual({ I: true });
  });

  it('refuses to rename or delete a system mailbox, sending nothing', async () => {
    server.calls = [];
    await expect(engine.updateLabel('I', { parentId: null, ancestors: [], name: 'Mine' })).rejects.toThrow("'Inbox' is a system mailbox.");
    await expect(engine.destroyLabel('I')).rejects.toThrow("'Inbox' is a system mailbox.");
    expect(server.calls).toEqual([]);
  });

  it('refuses to delete a mailbox the server has since given a role, before touching its mail', async () => {
    server.mailboxes.get('W')!.role = 'junk';
    server.calls = [];
    await expect(engine.destroyLabel('W')).rejects.toThrow("'Work' is a system mailbox.");
    expect(server.calls).not.toContain('Email/set');
    expect(server.emails.get('x1')?.mailboxIds).toEqual({ W: true });
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run src/sync/engine.test.ts -t "labels: delete"`
Expected: the four new tests fail.

- [ ] **Step 3: Make the fake answer `notFound` for an email that is gone**

In `src/sync/fake-jmap.ts`, `case 'Email/set'`, replace the `if (!e || this.rejectUpdates.has(id))` block:

```ts
          if (!e || this.rejectUpdates.has(id)) {
            notUpdated[id] = { type: e ? 'forbidden' : 'notFound' };
            continue;
          }
```

- [ ] **Step 4: Implement in the engine**

Add this private method above `forgetMailboxes`:

```ts
  /** A label is a mailbox without a role. The UI checks too; this is the check that can't be skipped. */
  private assertLabel(id: Id): void {
    const mb = this.state.mailboxes[id];
    if (mb?.role) throw new Error(`'${mb.name}' is a system mailbox.`);
  }
```

`updateLabel`: make `this.assertLabel(id);` its first statement.

`destroyLabel`: replace the body up to and including the `try … finally` with:

```ts
    this.assertLabel(id);
    // The store can lag the server. A sub-label it hasn't seen would block the destroy after
    // the label was already taken off all its mail, so ask the server first.
    const b = this.client.batch();
    const all = b.call('Mailbox/get', { accountId: this.accountId, ids: null, properties: ['name', 'parentId', 'role'] });
    const onServer = (await this.client.send(b)).get(all).list;
    const self = onServer.find((m) => m.id === id);
    if (self?.role) throw new Error(`'${self.name}' is a system mailbox.`);
    if (onServer.some((m) => m.parentId === id)) {
      void this.catchUp().catch(() => undefined);
      throw new LabelHasSubLabelsError();
    }
    try {
      await this.sweepLabel(id);
      if (await this.destroyEmptyMailbox(id)) {
        // Mail arrived during the sweep.
        await this.sweepLabel(id);
        if (await this.destroyEmptyMailbox(id)) throw new Error('New mail keeps arriving in this label');
      }
    } catch (e) {
      // What was swept before the failure is changed on the server: don't leave the store waiting for a push.
      await this.catchUp().catch(() => undefined);
      throw e;
    } finally {
      this.persistSoon();
    }
```

`sweepLabel`: replace the `failed` line:

```ts
      // notFound: deleted elsewhere since the query, so it no longer carries the label.
      const failed = Object.values((await this.client.send(sb)).get(call).notUpdated ?? {}).find((e) => e.type !== 'notFound');
```

- [ ] **Step 5: Run to see them pass**

Run: `pnpm vitest run src/sync && pnpm typecheck`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/sync/engine.ts src/sync/fake-jmap.ts src/sync/engine.test.ts
git commit -m "Label delete: reconcile after a failed sweep, skip mail deleted elsewhere, refuse system mailboxes in the engine"
```

---

### Task 3: Queries that go away (items 13, 14, 15)

**Files:**
- Modify: `src/sync/engine.ts` (`doFetchPage`, `updateEmails`, `forgetMailboxes`, `resetAll`)
- Test: `src/sync/engine.test.ts`

- [ ] **Step 1: Write the tests**

Change the patch import at the top of `src/sync/engine.test.ts`:

```ts
import { archivePatch, keywordPatch, unlabelPatch } from './patch';
```

Add below `inboxSpec`:

```ts
/** The engine's remembered viewport ranges: private, but the only trace a revived dead query leaves. */
const rangesOf = (e: MailEngine) => (e as unknown as { ranges: Map<string, unknown> }).ranges;
```

Add to `describe('MailEngine labels: delete', …)`:

```ts
  const destroyWorkElsewhere = () => {
    for (const e of server.emails.values()) delete e.mailboxIds!.W;
    server.emails.get('x1')!.mailboxIds = { A: true };
    server.mailboxes.delete('W');
  };

  it('drops the query of a label that vanished while the change cursor was stale', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    const inboxKey = engine.openQuery(inboxSpec);
    await engine.ensureRange(inboxKey, 0, 10);
    destroyWorkElsewhere();
    server.changesUnsupported = true;
    await engine.catchUp();
    expect(engine.state.mailboxes.W).toBeUndefined();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(rangesOf(engine).has(key)).toBe(false);
    expect(engine.state.queries[inboxKey]!.slots).toEqual(['x3', 'x2']);
  });

  it('reports a failed page load as itself when the list was closed meanwhile', async () => {
    const key = engine.openQuery(workSpec);
    server.onCall = (name) => {
      if (name !== 'Email/query') return;
      engine.closeQuery(key, () => false);
      throw new Error('boom');
    };
    await expect(engine.ensureRange(key, 0, 10)).rejects.toThrow('boom');
  });

  it('rolls back a refused update when a list it had changed was closed meanwhile', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    server.rejectUpdates.add('x2');
    server.onCall = (name) => {
      if (name === 'Email/set') engine.closeQuery(key, () => false);
    };
    await expect(engine.updateEmails(unlabelPatch(engine.threadEmails(['t2']), 'W', 'A'))).rejects.toThrow('forbidden');
    expect(engine.state.emails.x2?.mailboxIds).toEqual({ W: true, I: true });
  });

  it('leaves alone the query changes of a label destroyed in the same round', async () => {
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0, collapsedQueryChanges: true }));
    await engine.start();
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    destroyWorkElsewhere();
    server.bumpMailbox({ destroyed: ['W'] });
    server.queryChangesUnsupported = true;
    server.calls = [];
    await engine.catchUp();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(rangesOf(engine).has(key)).toBe(false);
    expect(server.calls).not.toContain('Email/query');
  });

  it('does not revive a list closed while another one was being reloaded', async () => {
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0, collapsedQueryChanges: true }));
    await engine.start();
    const inboxKey = engine.openQuery(inboxSpec);
    await engine.ensureRange(inboxKey, 0, 10);
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    server.queryChangesUnsupported = true;
    // Both lists must be reloaded. The first reload's request closes the second list.
    server.onCall = (name) => {
      if (name === 'Email/query') engine.closeQuery(key, () => false);
    };
    await engine.catchUp();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(rangesOf(engine).has(key)).toBe(false);
    expect(engine.state.queries[inboxKey]!.queryState).toBeTruthy();
  });
```

- [ ] **Step 2: Run them**

Run: `pnpm vitest run src/sync/engine.test.ts -t "labels: delete"`
Expected: the first three fail (the vanished label's query survives; `TypeError` in place of `boom`; `TypeError` in place of `forbidden`). The last two pass: they pin guards that already exist.

- [ ] **Step 3: Check the guard test is real**

Temporarily delete the first line of `resetQuery` (`if (!this.state.queries[key]) return;`), run `pnpm vitest run src/sync/engine.test.ts -t "does not revive"`, and see it fail on `rangesOf(engine).has(key)`. Restore the line.

- [ ] **Step 4: Implement**

`doFetchPage`, in the `catch`:

```ts
    } catch (e) {
      if (this.state.queries[key]) this.set('queries', key, 'error', String(e));
      throw e;
    }
```

`updateEmails`, in `rollback`, make the loop start:

```ts
        for (const r of removedRows) {
          // The list may have been closed since its row was removed.
          if (!this.state.queries[r.key] || !failedThreads.has(this.state.emails[r.id]?.threadId)) continue;
```

Replace `forgetMailboxes` with:

```ts
  /** Drop mailboxes from the store, and with them the live queries that list them. */
  private forgetMailboxes(ids: Id[]): void {
    if (!ids.length) return;
    const gone = new Set(ids);
    solidBatch(() => {
      this.set('mailboxes', produce((m) => ids.forEach((id) => delete m[id])));
      this.dropMailboxQueries((id) => gone.has(id));
    });
  }

  /** Drop every live query, and its remembered range, that lists exactly one mailbox which `gone` says is gone. */
  private dropMailboxQueries(gone: (mailboxId: Id) => boolean): void {
    for (const q of Object.values(this.state.queries)) {
      const f = q.filter as Record<string, unknown> | null;
      if (!f || Object.keys(f).length !== 1 || typeof f.inMailbox !== 'string' || !gone(f.inMailbox)) continue;
      this.ranges.delete(q.key);
      this.set('queries', produce((all) => void delete all[q.key]));
    }
  }
```

Replace `resetAll` with:

```ts
  private async resetAll(): Promise<void> {
    this.states = {};
    this.set({ emails: {}, threads: {}, bodies: {}, mailboxes: {}, synced: false });
    this.set('queries', produce((all) => {
      for (const q of Object.values(all)) {
        q.slots = [];
        q.total = null;
        q.queryState = null;
      }
    }));
    await this.start();
    // A label may have been deleted while the cursor was stale.
    this.dropMailboxQueries((id) => !this.state.mailboxes[id]);
    await Promise.all(Object.keys(this.state.queries).map((k) => this.resetQuery(k)));
  }
```

- [ ] **Step 5: Run to see them pass**

Run: `pnpm vitest run src/sync && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/sync/engine.ts src/sync/engine.test.ts
git commit -m "Engine: drop a vanished label's query on a full reset; never write to a dropped query; pin the dropped-query guards"
```

---

### Task 4: Delete confirm wording and timing; app-layer guards (items 2, 5, 8)

**Files:**
- Modify: `src/ui/ConfirmDialog.tsx` (`ConfirmOptions.message`, the `<p>`)
- Modify: `src/app/labels.ts`, `src/app/actions.ts`
- Test: `src/app/labels.test.ts`, `src/app/actions.test.ts`

**Interfaces:**
- Produces: `ConfirmOptions.message: string | (() => string)`; `deleteMessage(total: number, orphans: number | null): string`.

- [ ] **Step 1: Write the failing tests**

In `src/app/labels.test.ts`, replace `describe('deleteMessage', …)`:

```ts
describe('deleteMessage', () => {
  it('says an empty label is empty', () => {
    expect(deleteMessage(0, 0)).toBe('This label is empty.');
  });

  it('counts messages on both sides', () => {
    expect(deleteMessage(14, 5)).toBe('Its 14 messages stay in your mail. 5 that are only in this label move to Archive.');
    expect(deleteMessage(1, 1)).toBe('Its 1 message stays in your mail. 1 that is only in this label moves to Archive.');
  });

  it('leaves the Archive sentence out when nothing is only in the label', () => {
    expect(deleteMessage(3, 0)).toBe('Its 3 messages stay in your mail.');
  });

  it('stays general while the count is unknown', () => {
    expect(deleteMessage(3, null)).toBe('Its 3 messages stay in your mail. Any that are only in this label move to Archive.');
  });
});
```

In `describe('createLabels', …)`, add after the `let labels` line:

```ts
  const message = () => {
    const m = asked!.message;
    return typeof m === 'function' ? m() : m;
  };
  const general = 'Its 2 messages stay in your mail. Any that are only in this label move to Archive.';
  const counted = 'Its 2 messages stay in your mail. 1 that is only in this label moves to Archive.';
  const holdNextRequest = () => {
    let release!: () => void;
    server.holds.push(new Promise<void>((r) => (release = r)));
    return release;
  };
```

Replace `'asks with the counts, deletes, and says so'`:

```ts
  it('asks with the counts, deletes, and says so', async () => {
    answer = false;
    expect(await labels.remove('W')).toBe(false);
    await vi.waitFor(() => expect(message()).toBe(counted));
    answer = true;
    expect(await labels.remove('W')).toBe(true);
    expect(asked).toMatchObject({ title: "Delete 'Work'?", confirmLabel: 'Delete', pendingLabel: 'Deleting…' });
    expect(server.mailboxes.has('W')).toBe(false);
    expect(server.emails.get('w1')?.mailboxIds).toEqual({ A: true });
    expect(labels.deletedHere('W')).toBe(true);
    expect(toast).toHaveBeenCalledWith("Deleted 'Work'.", 'success');
  });

  it('opens the confirm without waiting for the count, then fills it in', async () => {
    const release = holdNextRequest();
    answer = false;
    const done = labels.remove('W');
    expect(message()).toBe(general);
    release();
    await done;
    await vi.waitFor(() => expect(message()).toBe(counted));
  });

  it('stops filling in the count once the delete has started', async () => {
    const release = holdNextRequest();
    expect(await labels.remove('W')).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(message()).toBe(general);
  });
```

In `'keeps the wording general when the count fails'`, replace the message assertion:

```ts
    expect(message()).toBe(general);
```

Add:

```ts
  it('refuses to rename a system mailbox or a label that is gone, sending nothing', async () => {
    server.calls = [];
    await expect(labels.rename('I', 'Mine')).rejects.toThrow("'Inbox' is a system mailbox.");
    await expect(labels.rename('gone', 'Mine')).rejects.toThrow('That label no longer exists.');
    expect(server.calls).toEqual([]);
  });
```

In `src/app/actions.test.ts`, add:

```ts
  it('does nothing for a system mailbox', async () => {
    server.calls = [];
    await actions.removeLabel(['t1'], 'I');
    expect(server.calls).toEqual([]);
    expect(server.emails.get('w2')?.mailboxIds).toEqual({ W: true, I: true });
    expect(toast).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run src/app`
Expected: failures in `deleteMessage`, the confirm tests, the "gone" rename and the system-mailbox unlabel. (The system-mailbox half of the rename test already holds through Task 2's engine guard; this pins the app layer's own answer.)

- [ ] **Step 3: Implement**

`src/ui/ConfirmDialog.tsx`: change the field and the paragraph.

```ts
  /** A function is read reactively, so the text can change while the dialog is open. */
  message: string | (() => string);
```

```tsx
          <p>{typeof p().opts.message === 'function' ? (p().opts.message as () => string)() : (p().opts.message as string)}</p>
```

`src/app/labels.ts`: add `import { createSignal } from 'solid-js';` as the first import, and replace `deleteMessage`:

```ts
/** The confirm text for deleting a label, counted in messages. `orphans` is null while the count isn't known. */
export function deleteMessage(total: number, orphans: number | null): string {
  if (total === 0) return 'This label is empty.';
  const kept = `Its ${total} message${total === 1 ? ' stays' : 's stay'} in your mail.`;
  if (orphans === null) return `${kept} Any that are only in this label move to Archive.`;
  if (orphans === 0) return kept;
  return `${kept} ${orphans} that ${orphans === 1 ? 'is' : 'are'} only in this label move${orphans === 1 ? 's' : ''} to Archive.`;
}
```

Replace `rename`:

```ts
    /** Throws the validation or server message. */
    async rename(id: Id, path: string): Promise<void> {
      const mb = engine.state.mailboxes[id];
      if (!mb) throw new Error('That label no longer exists.');
      if (mb.role) throw new Error(`'${mb.name}' is a system mailbox.`);
      const r = validate(path, id);
      if (!r.ok) throw new Error(r.error);
      if (r.noop) return;
      await engine.updateLabel(id, r.plan);
      toast(`Renamed to '${r.path}'.`, 'success');
    },
```

In `remove`, replace from `const path = …` through the `run:` block:

```ts
      const path = labelPath(mb, engine.state.mailboxes);
      const total = mb.totalEmails;
      // The count only improves the wording: the dialog opens without it and fills it in.
      const [orphans, setOrphans] = createSignal<number | null>(null);
      let started = false;
      void engine.countOrphans(id).then((n) => !started && setOrphans(n), () => undefined);
      try {
        const ok = await confirm({
          title: `Delete '${path}'?`,
          message: () => deleteMessage(total, orphans()),
          confirmLabel: 'Delete',
          pendingLabel: 'Deleting…',
          run: async () => {
            // From here the count would describe a label that is already being emptied.
            started = true;
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
```

`src/app/actions.ts`: import `isLabel` from `'../sync/selectors'` (change the type-only import to `import { isLabel, type View } from '../sync/selectors';`) and start `removeLabel` with:

```ts
      const mb = engine.state.mailboxes[label];
      if (!mb || !isLabel(mb)) return;
      const emails = engine.threadEmails(threadIds);
```

and use `mb.name` for the toast: `` `Removed '${mb.name}'.` `` (delete the `const name = …` line).

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run src/app && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app src/ui/ConfirmDialog.tsx
git commit -m "Label delete confirm: count messages on both sides, open before the count arrives; guard rename and unlabel against system mailboxes"
```

---

### Task 5: Dialogs give the focus back; Cancel is disabled while saving (items 4, 12)

**Files:**
- Create: `src/ui/focus.ts`, `src/ui/focus.test.ts`, `src/ui/ConfirmDialog.test.tsx`, `src/ui/LabelDialog.test.tsx`
- Modify: `src/test-setup.ts`, `src/ui/ConfirmDialog.tsx`, `src/ui/LabelDialog.tsx`

**Interfaces:**
- Produces: `restoreFocus(): void` from `src/ui/focus.ts`, called once in a component's body.

- [ ] **Step 1: Teach jsdom the two dialog calls rozie Dialog makes**

Append to `src/test-setup.ts`:

```ts
// jsdom has no modal dialogs. rozie Dialog needs the two calls to exist.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};
```

- [ ] **Step 2: Write the failing tests**

`src/ui/focus.test.ts`:

```ts
import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreFocus } from './focus';

const button = () => document.body.appendChild(document.createElement('button'));
const microtask = () => Promise.resolve();

afterEach(() => (document.body.innerHTML = ''));

describe('restoreFocus', () => {
  it('gives the focus back to where it was once the caller is gone', async () => {
    const before = button();
    const inside = button();
    before.focus();
    const dispose = createRoot((d) => (restoreFocus(), d));
    inside.focus();
    inside.remove();
    dispose();
    await microtask();
    expect(document.activeElement).toBe(before);
  });

  it('leaves the focus alone when something else has taken it', async () => {
    const before = button();
    const other = button();
    before.focus();
    const dispose = createRoot((d) => (restoreFocus(), d));
    other.focus();
    dispose();
    await microtask();
    expect(document.activeElement).toBe(other);
  });

  it('does nothing when the element it remembered is gone', async () => {
    const before = button();
    before.focus();
    const dispose = createRoot((d) => (restoreFocus(), d));
    before.remove();
    dispose();
    await microtask();
    expect(document.activeElement).toBe(document.body);
  });
});
```

`src/ui/ConfirmDialog.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('shows a message that changes while the dialog is open', async () => {
    const { confirm, Host } = createConfirmDialog();
    render(() => <Host />);
    const [n, setN] = createSignal(1);
    void confirm({ title: 'Sure?', message: () => `count ${n()}` });
    expect(await screen.findByText('count 1')).toBeInTheDocument();
    setN(2);
    expect(screen.getByText('count 2')).toBeInTheDocument();
  });

  it('gives the focus back to where it was when it goes away', async () => {
    const { confirm, Host } = createConfirmDialog();
    render(() => (
      <>
        <button>Outside</button>
        <Host />
      </>
    ));
    const outside = screen.getByText('Outside');
    outside.focus();
    const answer = confirm({ title: 'Sure?', message: 'Really?' });
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    expect(await answer).toBe(false);
    await Promise.resolve();
    expect(outside).toHaveFocus();
  });
});
```

`src/ui/LabelDialog.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import { LabelDialog } from './LabelDialog';
import { createNav } from './nav';

function setup(create: (path: string) => Promise<string>) {
  const nav = createNav();
  const labels = { create: vi.fn(create), rename: vi.fn(), validate: vi.fn(() => ({ ok: true })) };
  const app = { engine: { state: { mailboxes: {} } }, labels, nav } as unknown as App;
  render(() => (
    <AppContext.Provider value={app}>
      <button>Outside</button>
      <LabelDialog />
    </AppContext.Provider>
  ));
  return { nav, labels };
}

describe('LabelDialog', () => {
  it('disables Cancel while the label is being saved', async () => {
    let finish!: (id: string) => void;
    const { nav } = setup(() => new Promise<string>((r) => (finish = r)));
    nav.setLabelDialog({ kind: 'create' });
    const field = await screen.findByRole('textbox', { name: 'Label name' });
    fireEvent.input(field, { target: { value: 'Receipts' } });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.submit(field.closest('form')!);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    finish('new');
    await vi.waitFor(() => expect(nav.labelDialog()).toBeNull());
  });

  it('gives the focus back to where it was when it closes', async () => {
    const { nav } = setup(async () => 'new');
    const outside = screen.getByText('Outside');
    outside.focus();
    nav.setLabelDialog({ kind: 'create' });
    const field = await screen.findByRole('textbox', { name: 'Label name' });
    await vi.waitFor(() => expect(field).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(outside).toHaveFocus());
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `pnpm vitest run src/ui`
Expected: `focus.test.ts` fails to import `./focus`; the two focus-return tests and the Cancel test fail; "shows a message that changes" passes (Task 4 made it so).

- [ ] **Step 4: Implement**

`src/ui/focus.ts`:

```ts
import { onCleanup } from 'solid-js';

/**
 * When the calling component goes away, give the focus back to whatever had it when the
 * component was created. A <dialog> does this itself only when it is closed; ours are
 * removed from the page while open, which leaves the focus on the page body.
 */
export function restoreFocus(): void {
  const before = document.activeElement as HTMLElement | null;
  // A microtask later the dialog is out of the page; until then everything outside it is inert.
  onCleanup(() => queueMicrotask(() => {
    if (before?.isConnected && document.activeElement === document.body) before.focus({ preventScroll: true });
  }));
}
```

`src/ui/ConfirmDialog.tsx`: import `restoreFocus` from `'./focus'` and make the `Show` child a block that calls it:

```tsx
  const Host = () => (
    <Show when={pending()}>
      {(p) => {
        restoreFocus();
        return (
          <Dialog open onOpenChange={(open) => !open && finish(false)} ariaLabelledby="confirm-title">
            …unchanged…
          </Dialog>
        );
      }}
    </Show>
  );
```

`src/ui/LabelDialog.tsx`: import `restoreFocus` from `'./focus'`; call `restoreFocus();` as the first statement of `LabelForm`; and disable Cancel:

```tsx
          <button type="button" disabled={busy()} onClick={close}>Cancel</button>
```

- [ ] **Step 5: Run to see them pass**

Run: `pnpm vitest run src/ui && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/test-setup.ts src/ui/focus.ts src/ui/focus.test.ts src/ui/ConfirmDialog.tsx src/ui/ConfirmDialog.test.tsx src/ui/LabelDialog.tsx src/ui/LabelDialog.test.tsx
git commit -m "Dialogs give the focus back when they go away; the label dialog's Cancel is disabled while saving"
```

---

### Task 6: The "⋯" menu (items 1, 4)

**Files:**
- Create: `src/ui/LabelMenu.tsx` (moved from `Shell.tsx`), `src/ui/LabelMenu.test.tsx`, `src/ui/keyboard.test.ts`
- Modify: `src/ui/Shell.tsx`, `src/ui/keyboard.ts`, `src/ui/styles.css`

**Interfaces:**
- Produces: `LabelMenu(props: { mailbox: Mailbox })` from `src/ui/LabelMenu.tsx`; `shortcutsSuspended(el: Element | null): boolean` from `src/ui/keyboard.ts`.

- [ ] **Step 1: Write the failing tests**

`src/ui/keyboard.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { shortcutsSuspended } from './keyboard';

afterEach(() => (document.body.innerHTML = ''));

describe('shortcutsSuspended', () => {
  it('is true in a text field and in a menu, false elsewhere', () => {
    document.body.innerHTML =
      '<input id="field"><div role="menu"><button id="item" role="menuitem">Rename</button></div><button id="plain">x</button>';
    const el = (id: string) => document.getElementById(id);
    expect(shortcutsSuspended(el('field'))).toBe(true);
    expect(shortcutsSuspended(el('item'))).toBe(true);
    expect(shortcutsSuspended(el('plain'))).toBe(false);
    expect(shortcutsSuspended(null)).toBe(false);
  });
});
```

`src/ui/LabelMenu.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import type { Mailbox } from '../jmap/types';
import { LabelMenu } from './LabelMenu';
import { createNav } from './nav';

const work: Mailbox = {
  id: 'W', name: 'Work', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
};

async function openMenu() {
  const nav = createNav();
  const labels = { remove: vi.fn(async () => false) };
  const app = { engine: { state: { mailboxes: { W: work } } }, labels, nav } as unknown as App;
  render(() => (
    <AppContext.Provider value={app}>
      <LabelMenu mailbox={work} />
    </AppContext.Provider>
  ));
  const trigger = screen.getByRole('button', { name: 'Options for Work' });
  fireEvent.click(trigger);
  const [rename, del] = await screen.findAllByRole('menuitem');
  await vi.waitFor(() => expect(rename).toHaveFocus());
  return { nav, labels, trigger, rename: rename!, del: del! };
}

describe('LabelMenu', () => {
  it('moves to the ends with End and Home', async () => {
    const { rename, del } = await openMenu();
    fireEvent.keyDown(rename, { key: 'End' });
    expect(del).toHaveFocus();
    fireEvent.keyDown(del, { key: 'Home' });
    expect(rename).toHaveFocus();
  });

  it('still wraps with the arrow keys', async () => {
    const { rename, del } = await openMenu();
    fireEvent.keyDown(rename, { key: 'ArrowUp' });
    expect(del).toHaveFocus();
    fireEvent.keyDown(del, { key: 'ArrowDown' });
    expect(rename).toHaveFocus();
  });

  it('closes on Tab, leaving the focus on its button for the browser to move on from', async () => {
    const { rename, trigger } = await openMenu();
    fireEvent.keyDown(rename, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('puts the focus on its button before Rename opens the dialog, so the dialog can hand it back', async () => {
    const { rename, trigger, nav } = await openMenu();
    fireEvent.click(rename);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(nav.labelDialog()).toEqual({ kind: 'rename', id: 'W' });
  });

  it('does the same before Delete asks', async () => {
    const { del, trigger, labels } = await openMenu();
    fireEvent.click(del);
    expect(trigger).toHaveFocus();
    expect(labels.remove).toHaveBeenCalledWith('W');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run src/ui/keyboard.test.ts src/ui/LabelMenu.test.tsx`
Expected: both fail to import (`shortcutsSuspended`, `./LabelMenu`).

- [ ] **Step 3: Implement the shortcut guard**

`src/ui/keyboard.ts`: replace `isTyping` with

```ts
/** True while single-key shortcuts must stay quiet: the focus is in a text field, or in a menu with keys of its own. */
export function shortcutsSuspended(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable) return true;
  return !!el.closest('[role="menu"]');
}
```

and its one use: `if (shortcutsSuspended(document.activeElement)) return;`

- [ ] **Step 4: Move the menu to its own file, with the new keys**

`src/ui/LabelMenu.tsx`:

```tsx
import { Popover } from '@rozie-ui/popover-solid';
import { createEffect, createMemo, createSignal, on } from 'solid-js';
import { useApp } from '../app/context';
import type { Mailbox } from '../jmap/types';
import { labelPath, subLabelCount } from '../sync/selectors';
import { Icon } from './icons';

/** The "⋯" menu of a label row: Rename and Delete. */
export function LabelMenu(props: { mailbox: Mailbox }) {
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

  /** Close with the focus on the button: Escape stays there, Tab moves on from there, a dialog returns there. */
  const close = () => {
    setOpen(false);
    button?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Tab is not prevented: the browser carries it on from the button.
    if (e.key === 'Escape' || e.key === 'Tab') return close();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    list[(to + list.length) % list.length]?.focus();
  };

  const choose = (run: () => void) => {
    close();
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

`src/ui/Shell.tsx`: delete the `LabelMenu` function and its doc comment; delete the `Popover` import; drop `subLabelCount` from the selectors import; add `import { LabelMenu } from './LabelMenu';`.

- [ ] **Step 5: Touch targets**

`src/ui/styles.css`: after the `@media (hover: none) { .nav-more { opacity: 1; } }` line add

```css
/* Fingers need more than 28px: on touch screens the rows and their buttons are 44px. */
@media (pointer: coarse) {
  .nav-item { height: 44px; }
  .nav-add, .nav-more { width: 44px; height: 44px; }
  .nav-menu { top: 0; right: 0; }
  .nav-row .nav-item { padding-right: 48px; }
  .menu [role='menuitem'] { min-height: 44px; }
}
```

- [ ] **Step 6: Run to see them pass**

Run: `pnpm vitest run src/ui && pnpm typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/ui
git commit -m "Label menu: Tab closes it, Home and End, focus back on its button, no app shortcuts while it is open, 44px on touch"
```

---

### Task 7: The label route while it has no view (items 3, 17)

**Files:**
- Modify: `src/ui/nav.ts`, `src/ui/Shell.tsx` (`MailView`)
- Test: `src/ui/nav.test.ts`

**Interfaces:**
- Produces: `missingViewText(labelRoute: boolean, ready: boolean): string` from `src/ui/nav.ts`.

- [ ] **Step 1: Write the failing test**

In `src/ui/nav.test.ts`, change the import to `import { createNav, missingViewText, type ListHandle } from './nav';` and add:

```ts
describe('missingViewText', () => {
  it('says a mailbox is not found only for a name that can never appear', () => {
    expect(missingViewText(false, true)).toBe('Mailbox not found.');
    expect(missingViewText(false, false)).toBe('Loading…');
  });

  it('never says so for a label: it is still arriving, or the view is about to leave for the Inbox', () => {
    expect(missingViewText(true, true)).toBe('Loading…');
    expect(missingViewText(true, false)).toBe('Loading…');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run src/ui/nav.test.ts`
Expected: FAIL, `missingViewText` is not exported.

- [ ] **Step 3: Implement**

`src/ui/nav.ts`, before `createNav`:

```ts
/**
 * What a mail route shows while it has no view. A label route never says "not found": on a warm
 * start the label may be newer than the snapshot, and once synced a missing label redirects.
 */
export function missingViewText(labelRoute: boolean, ready: boolean): string {
  return ready && !labelRoute ? 'Mailbox not found.' : 'Loading…';
}
```

`src/ui/Shell.tsx`, `MailView`: import `missingViewText` from `'./nav'`; replace the `let left` block and its effect with

```tsx
  // A label that is gone (deleted here or elsewhere, or a stale link) has no view: go to the Inbox.
  // Only once the store has been reconciled; a warm-start snapshot may not know a new label yet.
  // `on` keeps the toast and the navigation from adding dependencies that would run this twice.
  createEffect(on([() => params.id, view, () => engine.state.synced], ([id, v, synced]) => {
    if (!id || v || !synced) return;
    if (!labels.deletedHere(id)) toast('That label no longer exists.', 'info');
    navigate('/inbox', { replace: true });
  }));
```

and the fallback with

```tsx
    <Show when={view()} fallback={<div class="list-empty">{missingViewText(!!params.id, engine.state.ready)}</div>} keyed>
```

- [ ] **Step 4: Run to see it pass**

Run: `pnpm vitest run src/ui && pnpm typecheck`
Expected: all pass. (The single toast is checked end to end in Task 9: Playwright's strict locator fails on two.)

- [ ] **Step 5: Commit**

```bash
git add src/ui/nav.ts src/ui/nav.test.ts src/ui/Shell.tsx
git commit -m "Label routes show Loading, not 'Mailbox not found', while they have no view; the redirect tracks only what it reads"
```

---

### Task 8: The pickers' scorer and Create row (item 16)

**Files:**
- Modify: `src/ui/picker.ts`, `src/ui/Overlays.tsx`, `src/ui/styles.css`
- Test: `e2e/labels.spec.ts` (run in Task 9)

- [ ] **Step 1: Write the failing e2e assertion**

In `e2e/labels.spec.ts`, test `'the Label picker creates a missing label and applies it'`, replace the `Create` row line with:

```ts
  const createRow = page.getByRole('option', { name: `Create '${tag}'` });
  await expect(createRow).toBeVisible();
  // The typed text is what stands out, never letters of the word "Create".
  await expect(createRow.locator('strong')).toHaveText(tag);
  await expect(createRow.locator('.rozie-command-palette-option-label-match')).toHaveCount(0);
```

- [ ] **Step 2: Implement**

`src/ui/picker.ts`: delete the line `if (!q) return 1;` and add to the doc comment: `The palette never scores an empty query, so there is no case for one.`

`src/ui/Overlays.tsx`: change `PickerItem.create` and the row that sets it.

```ts
  /** For the Create row: the text as typed (what is created) and its normalized path (what is shown). */
  create?: { typed: string; path: string };
```

```ts
    if (plan?.ok) list.push({ id: CREATE, label: `Create '${plan.path}'`, group: 'New', create: { typed, path: plan.path } });
```

Add the slot to `<CommandPalette>` after `score`:

```tsx
      // The default row highlights the typed letters where they first occur, which here can be inside "Create".
      optionSlot={(...args: unknown[]) => {
        const { option } = args[0] as { option: PickerItem };
        return option.create ? <span class="picker-create">Create '<strong>{option.create.path}</strong>'</span> : undefined;
      }}
```

and in `onSelect`:

```ts
        if (!item.create) apply(item.id);
        else labels.create(item.create.typed, { quiet: true }).then(apply, (e) => toast(`Couldn't create the label: ${(e as Error).message}`, 'error'));
```

`src/ui/styles.css`, next to the palette rules: `.picker-create strong { font-weight: 600; }`

- [ ] **Step 3: Run**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/ui/picker.ts src/ui/Overlays.tsx src/ui/styles.css e2e/labels.spec.ts
git commit -m "Pickers: emphasize the path in the Create row, not letters of 'Create'; drop the scorer's unreachable branch"
```

---

### Task 9: End to end, and the documents

**Files:**
- Modify: `e2e/labels.spec.ts`, `e2e/README.md`, `docs/superpowers/specs/2026-10-01-label-management-design.md`, `docs/rozie-feedback.md`

- [ ] **Step 1: Extend the e2e spec**

Add the import: `import { floatingComposer } from './support/compose';`

In the delete test, replace the dialog text assertion:

```ts
  await expect(dialog).toContainText('Its 2 messages stay in your mail. 1 that is only in this label moves to Archive.');
```

In `'a label with a sub-label cannot be deleted; the menu works from the keyboard'`, after `await expect(rename).toBeFocused();` add:

```ts
  // The app's single-key shortcuts stay quiet while the menu has the focus.
  await page.keyboard.press('c');
  await expect(floatingComposer(page)).toHaveCount(0);
  await page.keyboard.press('End');
  await expect(del).toBeFocused();
  await page.keyboard.press('Home');
  await expect(rename).toBeFocused();
```

Add two tests:

```ts
test('Tab closes the menu; a closed rename dialog and a cancelled delete give the focus back to "⋯"', async ({ page }) => {
  const tag = uniqueTag();
  await createLabel(tag);
  await openInbox(page);
  const more = page.getByRole('button', { name: `Options for ${tag}`, exact: true });

  await openMenu(page, tag);
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(more).not.toBeFocused();
  await expect(page.locator(':focus')).toHaveCount(1);

  await openMenu(page, tag);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await expect(nameField(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Rename label' })).toBeHidden();
  await expect(more).toBeFocused();

  await openMenu(page, tag);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: `Delete '${tag}'?` });
  await expect(confirm).toContainText('This label is empty.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(more).toBeFocused();
  expect(await labelByPath(tag)).toBeDefined();
});

test('on a touch screen the label buttons are at least 44px', async ({ browser }) => {
  const tag = uniqueTag();
  await createLabel(tag);
  const context = await browser.newContext({ ...devices['Pixel 7'], storageState: 'e2e/.auth/alice.json' });
  const page = await context.newPage();
  try {
    await openInbox(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    for (const name of ['New label', `Options for ${tag}`]) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await context.close();
  }
});
```

and add `devices` to the Playwright import: `import { devices, expect, test, type Page } from '@playwright/test';`

- [ ] **Step 2: Build and run the label spec, then the whole suite**

Run: `pnpm build && E2E_SKIP_SEED=1 pnpm exec playwright test labels`
Expected: all label tests pass.
Run: `E2E_SKIP_SEED=1 pnpm e2e`
Expected: the whole suite passes.

- [ ] **Step 3: Amend the spec**

In `docs/superpowers/specs/2026-10-01-label-management-design.md`:

- Decisions, "Labels under system mailboxes": `Not creatable: Inbox/Foo is rejected. Existing ones still display, and can be renamed where they are, renamed out, or deleted.`
- Errors table: the too-long row reads "(the segment cut to 30 characters, never inside an emoji)"; the system-mailbox row gains "Exception: renaming a label that is already under a system mailbox without changing its parent."
- Engine: the sweep's step 4 gains "A `notFound` entry (the email was deleted elsewhere meanwhile) is skipped."; "Guarantees and failure" gains "After a failure the engine runs `catchUp()` before reporting, so the store shows what was already swept."; `updateLabel` and `destroyLabel` refuse a mailbox with a role, `destroyLabel` also by the server's answer in step 0; "Changes from another client" gains "A full reset after `cannotCalculateChanges` drops the same queries for labels that are no longer there."
- App layer, Delete: step 2 becomes "Start `countOrphans(id)` without waiting for it."; the message table counts messages (`<n>` is `totalEmails`), the "count failed" row becomes "count unknown (not yet arrived, or failed)", and a line says the text stops changing once the delete has started. `rename` refuses a mailbox with a role or one that is gone; `actions.removeLabel` does nothing for a mailbox with a role.
- Sidebar: menu keyboard gains Home, End, and "Tab closes the menu and moves on from the '⋯' button"; "Closing the rename dialog or cancelling the delete returns focus to the '⋯' button"; "The app's single-key shortcuts are off while the menu has focus"; "On coarse pointers the rows and their buttons are 44px."
- Create and rename dialog: "While the request runs both buttons are disabled."
- Confirm dialog: `message` may be a function, read reactively.
- Pickers: "The row shows the path in bold; the typed letters are not highlighted inside the word 'Create'."
- Viewing a label that changes: "A `label/<id>` route with no view shows 'Loading…', never 'Mailbox not found.'"

- [ ] **Step 4: Update the e2e README and the rozie notes**

`e2e/README.md`, the `labels.spec.ts` row: add "the '⋯' menu … closes on Tab, supports Home/End, silences the app's shortcuts, and gets the focus back after its dialogs; the buttons are 44px on a touch screen; the Create row emphasizes the typed path".

`docs/rozie-feedback.md`: append to the Popover menu entry "5. Home/End and Tab-closes are ours too; a Menu component would cover all of it."; append to the CommandPalette entry "Highlighting: `labelHighlight` marks the first subsequence match in the label, so for `Create 'ea'` it marks letters of 'Create'. We render that row through `optionSlot`. A per-item `highlight: false`, or highlight ranges an item can supply, would do."; add an entry "Dialog 0.1.3 — focus is not returned when unmounted while open" describing `src/ui/focus.ts` and suggesting the component restore focus in `onCleanup`.

- [ ] **Step 5: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add e2e docs
git commit -m "Cover the label minors end to end; amend the spec, the e2e README and the rozie notes"
```
