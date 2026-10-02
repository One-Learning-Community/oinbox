# oinbox label management

This slice lets a user create, rename and delete labels from the app, and remove a label from a conversation.
It is slice 3 of the pilot-readiness work (a small team on its own Stalwart). A label is a JMAP mailbox without a role. Today the only mailbox the app ever creates is Archive, automatically, and there is no UI to manage labels at all.

## Goal

Alice clicks "+" next to "Labels" in the sidebar, types `Clients/Acme` and presses Enter. "Clients" and "Clients/Acme" appear in the sidebar. Later she opens the label's "⋯" menu, renames it to `Customers/Acme`, and it moves. When she deletes it, its conversations stay in her mail: those that were only in the label are now in Archive.
While labelling a conversation with `l`, she types a name that doesn't exist and picks "Create 'Receipts'"; the label is created and applied in one step.
When a colleague's other mail client renames or deletes a label she is looking at, the app follows without a reload.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Nesting | Nested labels are created by typing a path: `Clients/Acme` creates Acme under Clients, creating Clients if needed. The sidebar stays a flat list of paths. | Decided with the user on 2026-10-01. Nested mailboxes from other clients already display as paths, so the model is not new; a tree UI is. |
| Rename | The rename field edits the whole path. Changing the parent part moves the label. | One mental model for create and rename. A mistyped parent can be fixed without delete and recreate. |
| Deleting a label with mail | The mail is kept. Mail also in another mailbox loses the label; mail only in this label moves to Archive first. | Gmail's rule: deleting a label never deletes mail. "Move to" takes mail out of the Inbox, so mail that lives only in a label is common. |
| How delete keeps that promise | The client strips the label from every email, then destroys the mailbox with `onDestroyRemoveEmails: false`. `onDestroyRemoveEmails: true` is never sent. | Letting the server strip the label is faster, but a message delivered into the label alone between the two steps would be destroyed. |
| Deleting a label with sub-labels | Refused until the sub-labels are gone. | One mailbox per delete keeps the non-atomic sweep small and its failure case simple. |
| Mutations | Server-confirmed: the store changes when the server answers. No optimistic update. | Create and rename are one fast request. Optimistic updates would need temporary ids in `/label/<id>` routes and the pickers, plus three rollback paths. |
| Where the UI lives | Sidebar ("+" on the Labels heading, "⋯" menu per label) and the Move/Label pickers (a "Create …" row). | Managing belongs where labels are listed; creating belongs where a label is wanted. |
| Removing a label from a conversation | Included in a minimal form: an "×" on the label chips of the conversation header. | Nothing in the UI removes a label today, and deleting labels makes that gap obvious. |
| What counts as a label | A mailbox with `role === null`. | Stalwart 0.16.23 reports `mayDelete` and `mayRename` as true for Inbox and Trash too, so `myRights` cannot be the guard. |
| Duplicates | Sibling names are compared case-insensitively. | Stricter than IMAP, but two labels differing only in case are a trap in a picker. |
| Labels under system mailboxes | Not creatable: `Inbox/Foo` is rejected. Existing ones still display and can be renamed out or deleted. | Keeps "label" and "system mailbox" separate. |
| rozie gaps | Logged in `docs/rozie-feedback.md`. A component that blocks the work pauses it for the user to fix upstream. | Project rule. |

## Architecture

```
src/
  mail/labels.ts          new. Pure: parse and validate a path, produce a plan. No Solid, no JMAP.
  sync/engine.ts          + createLabel, updateLabel, countOrphans, destroyLabel
                          + drops live queries of a destroyed mailbox
  sync/selectors.ts       + isLabel, subLabelCount
  sync/patch.ts           + unlabelPatch
  sync/fake-jmap.ts       + Mailbox/set, a real Mailbox/changes log, filter operators
  app/labels.ts           new. create / rename / remove with confirm, toasts, navigation
  app/actions.ts          + removeLabel
  app/context.tsx         + labels on App
  ui/nav.ts               + labelDialog state
  ui/LabelDialog.tsx      new. One dialog for create and rename (rozie Dialog)
  ui/Shell.tsx            Labels heading "+", row "⋯" menu (rozie Popover), dead-label redirect
  ui/Overlays.tsx         "Create …" row in the Move and Label pickers
  ui/Conversation.tsx     "×" on label chips
  ui/ConfirmDialog.tsx    optional async action, so the button can show "Deleting…"
```

`ui/` never calls `jmap/`, as before. Every new JMAP call lives in `sync/engine.ts`.

## Label paths (`src/mail/labels.ts`)

Everything that accepts a typed label (the create dialog, the rename dialog, the pickers' "Create" row) goes through this module, so the rules are the same everywhere.

```ts
interface LabelLimits { maxDepth: number; maxNameBytes: number }

interface LabelPlan {
  parentId: Id | null;   // the deepest existing ancestor, or null for the top level
  ancestors: string[];   // names of missing ancestors to create, outermost first
  name: string;          // the leaf name
}

type PlanResult = { ok: true; plan: LabelPlan; path: string } | { ok: false; error: string };

function planLabel(
  path: string,
  mailboxes: Record<Id, Mailbox>,
  limits: LabelLimits,
  renaming?: Id,          // the label being renamed, if any
): PlanResult;

function labelLimits(session: Session): LabelLimits;
```

`labelLimits` reads `maxMailboxDepth` and `maxSizeMailboxName` from the account's `urn:ietf:params:jmap:mail` capability and falls back to 10 and 255 when either is missing or null.

### Parsing

1. Split the text on `/`. Trim each segment and collapse inner runs of whitespace to one space.
2. Resolve each segment but the last against the existing children of the parent found so far, comparing names case-insensitively. `clients/New` reuses an existing `Clients`.
3. From the first segment that does not exist, the remaining non-leaf segments become `ancestors`.
4. `path` in the result is the normalized path with the existing ancestors in their stored case. It is what toasts and the picker show.

### Errors

The first failing rule gives the message, in this order:

| Input | Message |
|---|---|
| Empty text, or an empty segment (`a//b`, `/a`, `a/`) | "A label name can't be empty." |
| A control character (U+0000 to U+001F, U+007F) in a segment | "Label names can't contain control characters." |
| A segment longer than `maxNameBytes` bytes in UTF-8 | "'<segment>' is too long." (the segment cut to 30 characters) |
| Any segment resolves to a mailbox with a role, including the leaf (`Inbox/Foo`, or a top-level `Sent Items`) | "'<name>' is a system mailbox." |
| The full path resolves to an existing mailbox other than `renaming` | "A label named '<path>' already exists." |
| More segments than `maxDepth` | "Labels can be nested at most <maxDepth> deep." |
| Rename: the new parent is `renaming` or one of its descendants | "A label can't be moved inside itself." |
| Rename: the new depth plus the height of the label's own subtree exceeds `maxDepth` | The depth message. |

Rename details:

- The path resolving to `renaming` itself is not a duplicate. A change of case only (`receipts` to `Receipts`) is a real rename.
- A rename whose plan equals the label's current parent and exact name is a no-op: the caller closes the dialog without a request.

Anything the server refuses that these rules missed is shown in the same place, using the server's description.

### Known wrinkle

A mailbox whose name already contains `/` (possible from another JMAP client) displays the same as a nested one. It can be deleted normally. Renaming it reads the slash as nesting, so `a/b` becomes `b` under `a`. No escaping is built for this.

## Selectors (`src/sync/selectors.ts`)

- `isLabel(mb)`: `mb.role === null`. Only these get Rename, Delete and the chip "×".
- `subLabelCount(id, mailboxes)`: the number of descendants of a mailbox, to a depth of 10.
- `sidebarMailboxes` is unchanged: mailboxes with a role the sidebar doesn't know (`important`, `all`) keep showing under Labels, without the menu.

## Engine (`src/sync/engine.ts`)

Each method throws an `Error` carrying the server's description, as `ensureMailbox` does. `ensureMailbox` itself is unchanged.

| Method | Request | On success |
|---|---|---|
| `createLabel(plan): Promise<Id>` | One `Mailbox/set` creating the missing ancestors and the leaf. Each created mailbox points at its parent, with `parentId: "#<creation id>"` when the parent is created in the same call. Every create sets `isSubscribed: true`, so IMAP clients show the label. | Merges the created mailboxes into the store and returns the leaf's id. |
| `updateLabel(id, plan): Promise<void>` | One `Mailbox/set`: `create` for missing ancestors, `update` of the label's `name` and `parentId`. | Merges the created mailboxes and the changed label. |
| `countOrphans(id): Promise<number>` | `Email/query` with filter `{ operator: 'AND', conditions: [{ inMailbox: id }, { operator: 'NOT', conditions: [{ inMailboxOtherThan: [id] }] }] }`, `limit: 1`, `calculateTotal: true`. | Returns `total`. |
| `destroyLabel(id): Promise<void>` | The sweep below. | Removes the mailbox from the store, drops its live queries, then runs `catchUp()`. |

Server facts, checked read-only against Stalwart 0.16.23 on 2026-10-01:

- The orphan filter works as written.
- `limit: 0` means "no limit" (it returned every id), so a count query must use `limit: 1`.
- `maxObjectsInGet` and `maxObjectsInSet` are 500; `maxCallsInRequest` is 16.

**Creation references.** Not yet checked, because checking writes: whether Stalwart accepts a parent and its child created in one `Mailbox/set`. The first build step checks it against the dev stack. If Stalwart refuses, `createLabel` and `updateLabel` send one call per level instead. A failure partway then leaves the already-created ancestors in place, which is harmless: a retry reuses them.

### The delete sweep (`destroyLabel`)

1. One batch: `Email/query` with `{ inMailbox: id }`, `collapseThreads: false`, `limit: 500`; then `Email/get` of those ids by back-reference, property `mailboxIds`.
2. If the query returned nothing, go to step 5.
3. If any email of the page has no other mailbox, `ensureMailbox('archive', 'Archive')`.
4. `Email/set` update for the page: `mailboxIds/<id>: null` for each email, plus `mailboxIds/<archive>: true` for each email that had no other mailbox. The same patches are applied to the emails held in the store. An entry in `notUpdated` stops the sweep with an error. Go to step 1.
5. `Mailbox/set` with `destroy: [id]` and `onDestroyRemoveEmails: false`.
6. If the server answers `mailboxHasEmail` (mail arrived during the sweep), run steps 1 to 5 once more. A second `mailboxHasEmail` is an error.

Guarantees and failure:

- No path sends `onDestroyRemoveEmails: true`, so no path destroys mail.
- A failure midway leaves the label in place with less mail in it. Nothing is lost and a retry finishes the job.
- A sub-label that appears from another client after the app's own check makes the server answer `mailboxHasChild`, which is thrown like any other refusal.
- There is no Undo. The confirm dialog is the safety net, as for Trash.

### Changes from another client

`Mailbox/changes` handling already merges created and updated mailboxes and deletes destroyed ones. One addition: when a mailbox leaves the store, through push or a local delete, the engine drops every live query whose filter is exactly `{ inMailbox: <that id> }`, and its remembered range. A dead query is then neither refetched nor written to the snapshot.

`labelPath` is derived from the store, so a rename or move made elsewhere re-renders the sidebar, pickers and chips with no extra work.

## App layer (`src/app/labels.ts`)

`createLabels(engine, toast, confirm, navigate)` returns the operations the UI calls. It owns confirmation, toasts and navigation, like `actions.ts`.

- `validate(path, renaming?)`: `planLabel` with the engine's mailboxes and the session's limits.
- `create(path, opts?: { quiet?: boolean }): Promise<Id>`: validates, calls `engine.createLabel`, toasts "Created '<path>'." unless `quiet`, and returns the id. Throws the validation or server message for the dialog to show inline. The pickers pass `quiet`, so the only toast there is the "Labeled" or "moved" one.
- `rename(id, path): Promise<void>`: validates, returns at once for a no-op, otherwise calls `engine.updateLabel` and toasts "Renamed to '<path>'.".
- `remove(id): Promise<void>`: see below.

### Delete

1. If `subLabelCount(id) > 0`, return. The menu item is already disabled; this is the guard.
2. Call `countOrphans(id)`. A failure is swallowed and changes only the wording.
3. Confirm, titled "Delete '<path>'?", confirm button "Delete", with the message:

| Case | Message |
|---|---|
| `totalEmails === 0` | "This label is empty." |
| Count known | "Its <n> conversation(s) stay in your mail. <m> that are only in this label move to Archive." With `m === 0`: "Its <n> conversation(s) stay in your mail." |
| Count failed | "Its <n> conversation(s) stay in your mail. Any that are only in this label move to Archive." |

   `<n>` is the mailbox's `totalThreads`; `<m>` is the orphan count, which counts messages.
4. On confirm, the dialog stays open with its button reading "Deleting…" while `engine.destroyLabel(id)` runs.
5. On success: if the current route is that label, navigate to `/inbox`; toast "Deleted '<path>'.".
6. On failure: an error toast, "Couldn't finish deleting '<path>'. Some conversations may already have been removed from it; try again. (<server message>)".

## UI

### Sidebar (`src/ui/Shell.tsx`)

- The "Labels" heading is always shown, even with no labels, and carries a "+" button with the accessible name "New label". It opens the create dialog.
- Each row for which `isLabel` is true gets a "⋯" button, accessible name "Options for <path>". It is a sibling of the row's link, not inside it. It is visible on hover and on keyboard focus within the row, and always visible on touch screens (`@media (hover: none)`).
- The button opens a rozie Popover holding a `role="menu"` with two `menuitem` buttons: "Rename" and "Delete".
- With sub-labels, Delete is disabled (`aria-disabled`) and reads "Delete (has <k> sub-label(s))".
- Menu keyboard: opening focuses the first item; ArrowDown and ArrowUp move between items; Escape closes and returns focus to the "⋯" button; choosing an item closes the menu.

### Create and rename dialog (`src/ui/LabelDialog.tsx`)

Opened through `nav.labelDialog()`, which is `{ kind: 'create' } | { kind: 'rename', id } | null`.

- Title "New label" or "Rename label". One text field with the accessible name "Label name", the inline error, Cancel, and a primary button "Create" or "Save".
- The field has focus when the dialog opens. Rename pre-fills the label's full path, selected.
- A hint under the field: "Use / to nest, e.g. Clients/Acme".
- Validation runs on submit, and then on every change once an error is showing, so the user isn't corrected mid-typing.
- Enter or the primary button submits. While the request runs the button is disabled and reads "Creating…" or "Saving…". A server refusal appears as the inline error and the dialog stays open.
- The error is linked to the field with `aria-describedby` and announced with `role="alert"`.
- After a create from the sidebar the dialog closes and the view does not change.
- If the label being renamed disappears while the dialog is open, the dialog closes.

### Confirm dialog (`src/ui/ConfirmDialog.tsx`)

`ConfirmOptions` gains two optional fields: `run?: () => Promise<void>` and `pendingLabel?: string`. With `run`, confirming disables both buttons, shows `pendingLabel` on the confirm button, awaits `run`, then closes and resolves `true`. A rejection of `run` closes the dialog and rejects the `confirm()` promise, so the caller reports it. Existing callers pass neither field and behave as before.

### Pickers (`src/ui/Overlays.tsx`)

For both Move (`v`) and Label (`l`):

- When the typed text is non-empty, passes `validate`, and matches no existing mailbox path exactly (case-insensitively), one more row appears: "Create '<path>'", in its own group "New", below every match.
- Selecting it calls `labels.create(path, { quiet: true })`, then applies the new label as the picker would have: `actions.addLabel` for Label, `actions.moveTo` for Move. The usual Undo toast follows; Undo does not delete the new label.
- If the create fails, an error toast shows the message and the conversations are untouched.
- Text that fails validation gets no Create row; the list shows its matches or "No matching mailboxes".

### Removing a label from a conversation

- In the conversation header, each chip for a mailbox where `isLabel` is true gets an "×" button with the accessible name "Remove label <name>". The Inbox chip does not.
- `actions.removeLabel(threadIds, labelId)` builds `unlabelPatch(emails, labelId, archiveId)`: for each email of the threads that is in the label, `mailboxIds/<label>: null`, plus `mailboxIds/<archive>: true` when the email would otherwise be in no mailbox. Archive is created with `ensureMailbox` only when such an email exists.
- It runs through the existing `moveWithUndo`, with the toast "Removed '<name>'." and Undo.
- When the view is that label, the conversation no longer belongs to it and closes back to the list, as Archive does today.

### Viewing a label that changes

| Event | Result |
|---|---|
| The label is renamed or moved, here or elsewhere | The view stays. Title and sidebar update. The URL holds the id, so it doesn't change. |
| The label is deleted here | Navigate to `/inbox`; toast "Deleted '<path>'.". |
| The label is deleted elsewhere, or a link points at a label that no longer exists | `MailView` replaces the route with `/inbox` and toasts "That label no longer exists.". An open conversation closes with it. |

The redirect applies only to `label/<id>` slugs, and only once the engine is ready. Other unknown slugs keep today's "Mailbox not found.".

### Component check

To be done by reading the rozie sources while writing the plan, as in slice 2. If a row turns out to block the work, the work pauses and the user decides.

| Need | Component | To check |
|---|---|---|
| A dialog with a form and a focused text field | Dialog 0.1.3 | Whether initial focus can be directed at the input. |
| The row menu | Popover 0.2.4 | It anchors to its own trigger, which fits. Menu keyboard behaviour is ours to add. "No Menu component" is logged as a gap. |
| The "Create" row always last | CommandPalette 0.4.10 | The `score` prop replaces the default scorer. Real items must keep fuzzy ranking, so the default scorer has to be reachable, or the row needs another way in (the `empty` or `footer` slot). |

## Fake JMAP (`src/sync/fake-jmap.ts`)

- `Mailbox/set`: `create` with creation references between creates of the same call, `update` of `name` and `parentId`, `destroy`. Refusals: a duplicate sibling name (`invalidProperties`), `mailboxHasChild`, and `mailboxHasEmail` unless `onDestroyRemoveEmails` is true. A switch makes the fake refuse creation references, for the fallback path.
- `Mailbox/changes` and `Mailbox/get`: a real state counter and change log, in place of today's fixed `m1` and empty answer.
- `Email/query`: the `AND` and `NOT` operators and `inMailboxOtherThan`.

## Testing

**Unit (Vitest)**

- `mail/labels.test.ts`: parsing, trimming and whitespace collapsing; case-insensitive reuse of existing parents; every row of the error table; the no-op rename and the case-only rename; the move-inside-itself and subtree-depth checks; limits read from the capability and the fallbacks.
- `sync/patch.test.ts`: `unlabelPatch` removes the label, and adds Archive only to emails with no other mailbox.
- `sync/selectors.test.ts`: `isLabel` and `subLabelCount`.
- `sync/engine.test.ts`, against the fake:
  - `createLabel` sends one `Mailbox/set` with creation references and merges every created mailbox; with references refused it sends one call per level;
  - `updateLabel` renames, moves, and creates missing ancestors;
  - `countOrphans` sends the filter with `limit: 1` and returns the total;
  - `destroyLabel` strips the label page by page, archives only orphans, never sends `onDestroyRemoveEmails: true`, sweeps again after `mailboxHasEmail`, and leaves the label in place when a page fails;
  - a mailbox destroyed through `Mailbox/changes` leaves the store and takes its live queries with it.
- `app/labels.test.ts`: delete does nothing when sub-labels exist; the confirm message in each of its cases; a failed delete reports the half-done message; a no-op rename sends no request.

**End to end (Playwright, new `e2e/labels.spec.ts`)**

1. "+" creates a label, and it appears in the sidebar.
2. Creating `<parent>/<child>` creates the parent too. A duplicate name and an empty segment show their inline errors.
3. The Label picker's Create row creates a label and applies it to the conversation.
4. Renaming a label while viewing it changes the title and the sidebar, and not the URL.
5. Renaming to another parent moves the label.
6. Deleting a label that holds one message also in the Inbox and one message only in the label: the first stays in the Inbox, the second is in Archive, the label is gone, and the view returns to the Inbox.
7. Delete is disabled for a label with a sub-label.
8. A label destroyed through JMAP directly while it is being viewed sends the view to the Inbox with the toast.
9. The "×" on a conversation chip removes the label, and Undo restores it.

**Cleanup**

- Every label the suite creates has a name starting with `e2e-`.
- An `afterEach` destroys them through JMAP, deepest first, with `onDestroyRemoveEmails: true` (test mail only).
- `e2e/cleanup.ts`, which global setup already runs, gains the same sweep for labels left by aborted runs.
- Mail is delivered with unique subjects and deleted afterwards, as the other specs do. The Archive mailbox is left in place if a test causes it to be created, since the app creates it for real users too.

**Docs**

- `e2e/README.md` gets a row for `labels.spec.ts` in its coverage table.
- `docs/rozie-feedback.md` gets the gaps found.

## Out of scope

- Deleting a whole subtree, or moving sub-labels up on delete.
- Removing labels from the thread list's chips, or in bulk from a selection.
- A keyboard shortcut for creating a label.
- A progress count during a large delete.
- Label colours, reordering (`sortOrder`) and subscription toggles.
- A collapsible tree in the sidebar.
- Shared mailboxes and per-mailbox rights.
- Escaping `/` inside a name.
- The deferred minors from the slice 2 branch review.
