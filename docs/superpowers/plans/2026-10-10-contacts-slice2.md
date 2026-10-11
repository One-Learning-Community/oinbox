# Contacts, slice 2 (groups, import, export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contact groups that can be addressed as recipients (expanding into one chip per member), and vCard import and export.

**Architecture:** A group is a JSContact card of `kind: "group"` whose members are other cards' `uid`s; pure functions in `src/contacts/groups.ts` resolve and expand them, and the store gains group and bulk operations. Imported vCards are cut apart in the browser and parsed by the server (`Blob/upload` + `ContactCard/parse`); `src/contacts/vcard.ts` cuts, finds duplicates and writes the export. The contact list gains a checkbox column and a selection toolbar.

**Tech Stack:** as slice 1 (SolidJS 1.9, rozie Dialog / Popover / Switch, Vitest, Playwright, Stalwart 0.16.23).

**Spec:** `docs/superpowers/specs/2026-10-10-contacts-design.md`, "Slice 2". Built on the branch `contacts`, after slice 1.

## Decided on 2026-10-11: the server parses, and the limit is said

The **server** parses imported vCards, as the spec has it. Every card parsed is one inline blob, and those count against Stalwart's upload quota: **1,000 files and 50 MB an hour per account by default, the allowance attachments use**. The approved course is to keep Stalwart's parser and live with the limit. Probed the same day:

- Nothing announces the limit in advance: not the session, not `Quota/get`, not the headers of a successful upload. So the dialog's note names the usual figure and says an administrator may have changed it.
- At the limit `Blob/upload` answers `notCreated: { <key>: { type: "overQuota", description: "You have exceeded the blob upload quota of 1000 files or 50000000 bytes." } }`, and a `ContactCard/parse` naming that key fails whole (`invalidResultReference`).
- A plain upload then answers 429 with `retry-after: <seconds>`: the time until the allowance is back.
- `ContactCard/parse` takes at most **10 blob ids a call**; several calls fit in one request (16 calls at most). `parsed` is keyed by the real blob id.

So duplicates are found **before** anything is uploaded, from the `UID` and `EMAIL` lines of the file's text, and are not sent at all: importing the same file again after a stop costs only the cards still missing.

## Global Constraints

- Everything in slice 1's Global Constraints still holds (branch, no push, 500 per get and set, `uid` only at creation, changed properties only, the 524,288-byte card, plain table, rozie Dialog/Popover, no new dependencies, exact strings).
- A group card: `{ '@type': 'Card', version: '1.0', kind: 'group', uid, created, updated, name: { full }, members: { <uid>: true }, addressBookIds }`. Member keys are the members' `uid`s, exactly as stored on their cards.
- A group never contains a group here; a member key that names a group card, or no card, is ignored when expanding and kept when saving.
- A `mailto:` member key written by another client expands to that address and is shown in the group; it cannot be added or edited here.
- A recipient group always expands into one chip per member. No "group chip".
- Imported and exported files are vCard; export writes version 4.0, UTF-8, CRLF line ends, lines folded at 75 octets.
- Commit after every task, prefix `Contacts:`.

## Review Focus

1. **The upload allowance running out mid-import**, and files as real programs write them (Google, Apple, Outlook): what is saved stays, what is left is counted, and choosing the same files again imports only the rest. Pinned in Tasks 5 and 7.
2. **A group whose members have changed under it:** a member deleted, a member with no email, a member with two emails, the same address reached twice, a member that is itself a group. Pinned in Task 1.
3. **A large or partly bad import:** hundreds of cards with some the server refuses, cancelled half-way. What is saved stays, the count is true, the failures are named. Pinned in Tasks 5 and 7.
4. **Export then import is the same address book.** Pinned in Task 4 (round trip) and Task 7.
5. **A selection that outlives its rows:** selected people deleted by a push, hidden by a search, or left behind by a change of group. Pinned in Task 3.

---

### Task 1: Groups, pure (`src/contacts/groups.ts`)

**Files:** Create `src/contacts/groups.ts`, `src/contacts/groups.test.ts`.

**Interfaces — Produces:**

```ts
export function groupName(group: ContactCard): string;                       // displayName, 'Untitled group' when empty
export function sortGroups(cards: ContactCard[]): ContactCard[];              // kind group only, by name then id
export interface GroupMembers { people: ContactCard[]; addresses: string[]; unknown: number }
/** `people` in list order; `addresses` from mailto: keys; `unknown` = keys naming no card, or a group. */
export function membersOf(group: ContactCard, people: ContactCard[]): GroupMembers;
export function memberCount(group: ContactCard, people: ContactCard[]): number; // people + addresses
/** One recipient per member by preferred email, then the bare addresses; an address appears once. */
export function expandGroup(group: ContactCard, people: ContactCard[]): { recipients: EmailAddress[]; withoutEmail: number };
export function groupsHolding(card: ContactCard, groups: ContactCard[]): ContactCard[]; // [] for a card with no uid
/** The whole `members` map after the change, or null when it would be empty. Keys not touched are kept. */
export function membersWith(group: ContactCard, uids: string[]): Record<string, boolean>;
export function membersWithout(group: ContactCard, uids: string[]): Record<string, boolean> | null;
export function newGroup(name: string, bookId: string, now: string, uid: string): Partial<ContactCard>;
export function checkGroupName(name: string, groups: ContactCard[], renaming?: Id): string | null; // error text or null
```

Rules: `people` passed in are `Contacts.people()` (no groups). A member matches a person when the key equals the person's `uid` exactly. `expandGroup` names each recipient with the card's display name unless that is the address itself (then `name: null`); a person with no non-blank email counts in `withoutEmail`; addresses are compared without case and the first occurrence wins. `checkGroupName`: trimmed empty → `'Give the group a name.'`; over 100 characters → `'A group name can have at most 100 characters.'`; the same name (case and accents ignored) as another group → `'There is already a group called “<that name>”.'`.

- [ ] **Step 1: failing tests** covering, each as its own `it`: members resolved in list order; a deleted member and a group-kind member counted as `unknown`; `mailto:X@y` (any case of the scheme) listed in `addresses`; expansion uses the preferred email, skips and counts a member without one, lists a person once even if also reached by a `mailto:` key, and gives `name: null` for a card known only by its address; `groupsHolding` for a card in two groups and for one with no `uid`; `membersWith` keeps unknown keys and adds new ones; `membersWithout` returns `null` when the last goes; `newGroup` shape; the three name errors and a rename to its own name being allowed.
- [ ] **Step 2:** `pnpm vitest run src/contacts/groups.test.ts` — FAIL (no module).
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run again, and `pnpm typecheck` — PASS.
- [ ] **Step 5:** commit `Contacts: groups, and who a group expands to`.

### Task 2: The store learns groups and bulk work

**Files:** Modify `src/app/contacts.ts`, `src/app/contacts.test.ts`, `src/sync/fake-jmap.ts` (+ test).

**Interfaces — Produces (added to `Contacts`):**

```ts
groups: Accessor<ContactCard[]>;                                   // sortGroups(all cards)
createGroup(name: string): Promise<ContactWrite>;
renameGroup(id: Id, name: string): Promise<ContactWrite>;
/** Deletes the group card only. Asks nothing: the caller confirms. */
removeGroup(id: Id): Promise<ContactWrite>;
/** Add people to a group. A person's card with no uid is first replaced by a copy that has one. */
addToGroup(groupId: Id, cardIds: Id[]): Promise<ContactWrite>;
removeFromGroup(groupId: Id, cardIds: Id[]): Promise<ContactWrite>;
/** Delete several people in one go. No undo: the caller confirms first. Returns how many went. */
removeMany(ids: Id[]): Promise<{ removed: number; error?: string }>;
```

Behaviour:
- `createGroup` / `renameGroup` set `name: { full }` and `updated`; both reuse `createCard` and the update path. `renameGroup` of a group that is gone → `'This group no longer exists.'`.
- `addToGroup`: for each card with no `uid`: create a copy (all properties, a new `uid`, `created` kept, `updated: now`) and, **only after that create succeeded**, destroy the original; then one `ContactCard/set` updating the group with `members: membersWith(...)` and `updated`. If nothing would change, no request.
- `removeFromGroup`: `members: membersWithout(...)` (`null` clears it).
- `removeMany`: `destroy` in chunks of 500; `notFound` counts as removed; the first other refusal is reported and the rest of that chunk's successes still count.
- The fake: `ContactCard/set` already refuses a second card with a `uid`; add `rejectCardCreates: Set<string>` (creation keys or uids the fake refuses with `invalidProperties` "Invalid property.") for the partial-failure test.

- [ ] **Step 1: failing tests:** group created with kind and uid and listed in `groups()` but not in `people()`; rename; delete leaves members; add two people, one without a uid (the fake then holds a copy with a uid and not the original, and the group names both uids); adding someone already in changes nothing and sends nothing; remove the last member clears `members`; `removeMany` of 3 with one already gone reports 3.
- [ ] **Step 2–4:** fail, implement, pass (`pnpm vitest run src/app src/sync && pnpm typecheck`).
- [ ] **Step 5:** commit `Contacts: the store makes and fills groups and deletes several people`.

### Task 3: Groups on the Contacts page, and a selection

**Files:** Modify `src/ui/ContactsView.tsx`, `src/ui/ContactCard.tsx`, `src/ui/Shell.tsx`, `src/index.tsx`, `src/ui/styles.css`; create `src/ui/GroupDialog.tsx`, `src/ui/GroupMenu.tsx`, `src/ui/GroupPicker.tsx`; tests beside each.

**Interfaces — Produces:** routes `/contacts/group/:gid` and `/contacts/group/:gid/:id` (declared before `/contacts/:id`); `contacts.groupDialog()` / `openGroupDialog({ kind: 'create', then?: Id[] } | { kind: 'rename', id })` / `closeGroupDialog()` on the store; `GroupPicker(props: { label: string; exclude?: Id[]; onPick: (groupId: Id) => void; onNew: () => void })` (a rozie Popover menu of the groups with a last row `New group…`).

Behaviour:
- **Sidebar**, while a contacts path is on screen: under the Contacts link a `nav-section` "Groups" with a "+" (`aria-label="New group"`), then each group as a `nav-row` linking to `/contacts/group/<id>` with its member count and a `GroupMenu` "⋯" (`Options for <name>`: Rename, Delete), built as `LabelMenu` is (same keys, same focus rules).
- **GroupDialog**: one field, `Group name`, checked with `checkGroupName`; `New group` / `Rename group`; Create / Save. A group created with `then` ids adds those people to it and toasts `Added <n> to <name>.`
- **Delete group** confirms: title `Delete “<name>”?`, message `The <n> people in it stay in your contacts.` (`The group is empty.` for none), `confirmLabel: 'Delete group'`. Deleting the group on screen goes to `/contacts`. A group deleted elsewhere while on screen goes to `/contacts` with `That group was deleted.`
- **Group view**: the list holds `membersOf(group).people`; a heading row above the table shows the group's name and count; `mailto:` members are listed after the people as rows with the address and "Address only" in place of a link, and no checkbox; `unknown > 0` shows `<n> member(s) of this group are not in your contacts.` Search filters within the group. A card opened from a group keeps the group in the address (`/contacts/group/<gid>/<id>`) and "Back to contacts" returns to the group.
- **Selection**: a first column of checkboxes (`aria-label="Select <name>"`), a header checkbox `Select all` that selects every shown person and is indeterminate when some are; Space on a focused row link toggles its box. The selection is a set of ids held in the view, **intersected with the people shown** whenever those change, and cleared on a change of group. With a selection, the tools row is replaced by `<n> selected` and the buttons `Add to group` (GroupPicker), `Remove from group` (group view only), `Export`, `Delete`, and `Clear selection`. `Delete` confirms: `Delete <n> contacts?` / `This cannot be undone.` / `Delete`; then toast `Deleted <n> contacts.`
- **Card**: a "Groups" line with one chip per group (`Remove from <group>` on its ×) and an `Add to group` GroupPicker excluding those it is in.
- At 800px and under the checkbox column stays (44px targets) and the toolbar's buttons wrap.

- [ ] **Step 1: failing component tests:** groups listed in the sidebar with counts only on a contacts path; group view lists its members, the address-only row and the not-in-contacts note; select two, add to a group through the picker, the fake's group card names both; `New group…` from the picker with a selection creates and fills it; select all then search narrows the selection to the shown; a selected person deleted by a push leaves the selection (and the count shown) without them; Space toggles; remove from group; bulk delete after confirm; rename and delete from the menu with their confirm text; the card's chips and their removal; a group deleted elsewhere returns to `/contacts`.
- [ ] **Step 2–4:** fail, implement, `pnpm vitest run src/ui && pnpm typecheck` pass.
- [ ] **Step 5:** commit `Contacts: groups in the sidebar, a selection in the list, and membership from the card`.

### Task 4: vCard text: cut, peeked at, and written (`src/contacts/vcard.ts`)

**Files:** Create `src/contacts/vcard.ts`, `src/contacts/vcard.test.ts`.

**Interfaces — Produces:**

```ts
/** The cards of a file's text, each from BEGIN:VCARD to END:VCARD, and how many started and never ended. */
export function splitVcards(text: string): { blocks: string[]; unreadable: number };
/** What can be told of a card without parsing it: enough to name it and to know a duplicate. */
export interface VcardPeek { uid: string; emails: string[]; name: string; group: boolean }
export function peekVcard(block: string): VcardPeek;
export interface DuplicateCheck { fresh: number[]; duplicates: number[] }   // indexes into the blocks
/** A duplicate has the uid of an existing card or of an earlier block, or, failing a uid, an email an existing person has. Groups are matched by uid only. */
export function findDuplicates(peeks: VcardPeek[], existing: ContactCard[]): DuplicateCheck;
/** vCard 4.0, CRLF, folded at 75 octets. */
export function toVcard(card: ContactCard): string;
export function toVcards(cards: ContactCard[]): string;
```

Reading is the server's work: this module only cuts and peeks.
- `splitVcards`: a leading byte-order mark is dropped; line ends may be CRLF or LF; `BEGIN:VCARD` and `END:VCARD` in any case, with spaces allowed after the colon; text between cards is ignored; a `BEGIN` with no `END` counts as `unreadable`. Each block is returned with CRLF line ends, as it was otherwise.
- `peekVcard`: lines are unfolded (a line starting with a space or tab continues the one before); a `item1.` group prefix is dropped; names are case-insensitive. `uid` from `UID`; `emails` from every `EMAIL` value, trimmed and lower-cased, those without `@` left out; `name` from `FN`, else from `N` as "given surname", else the first email, else `'No name'` (text escapes `\,` `\;` `\\` `\n` undone; a quoted-printable value is left as it is); `group` when `KIND` or `X-ADDRESSBOOKSERVER-KIND` is `group`.

Writing: `VERSION:4.0`, then `UID` (when present), `KIND`, `FN` (the display name), `N` (surname;given;given2;title;credential from the components by kind, several of a kind joined by a comma), `NICKNAME`, `EMAIL` (`TYPE=work|home`, `PREF=1`), `TEL` (`TYPE=cell|work|home|fax`), `ORG` (name;unit…), `TITLE`, `ADR` (`;;<full, or the components joined>;;;;` with `TYPE`, since slice 1 keeps addresses as text), `BDAY` (`YYYYMMDD` or `--MMDD`), `NOTE`, `URL`, `CATEGORIES`, `PHOTO` (the `data:` URI), `MEMBER`. Values escape `\`, `,`, `;` and newlines. Lines are folded so that no line exceeds 75 octets of UTF-8, never inside a multi-byte character.

- [ ] **Step 1: failing tests:** three cards in one text with junk between them and a truncated last one (`blocks` 3, `unreadable` 1); LF-only line ends and a BOM; lower-case `begin:vcard`; `peekVcard` on a Google card (`item1.EMAIL;TYPE=INTERNET:`), a folded `UID`, a card with only `N`, a card with only an email, an Apple group; `findDuplicates` by uid, by email (case ignored), a card repeated inside the file, a group matched only by uid, and a person with a uid that is new but an email that is known (duplicate); `toVcard` of a full card matches a fixture line for line; a folded line of accented text never splits a character and unfolds to the original; escapes in `NOTE` and `ORG`; a card with nothing but an id still writes `FN:No name`.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `Contacts: vCard files cut and written in the browser`.

### Task 5: Import through the server, and export, on the page

**Files:** Create `src/ui/ImportDialog.tsx` (+ test), `src/contacts/download.ts`; modify `src/app/contacts.ts` (+ test), `src/jmap/types.ts`, `src/jmap/client.ts` (+ test), `src/sync/fake-jmap.ts` (+ test), `src/ui/ContactsView.tsx`, `src/ui/Shell.tsx`, `src/ui/styles.css`.

**Interfaces — Produces:**

```ts
// src/jmap/types.ts
export const BLOB = 'urn:ietf:params:jmap:blob';
'Blob/upload': { args: { accountId: Id; create: Record<string, { data: { 'data:asText': string }[]; type?: string }> }; result: { accountId: Id; created: Record<string, { id: Id; type?: string; size: number }> | null; notCreated: Record<string, SetError> | null } };
'ContactCard/parse': { args: { accountId: Id; blobIds: string[] }; result: { accountId: Id; parsed: Record<string, Partial<ContactCard>> | null; notParsable: string[] | null; notFound: string[] | null } };
// src/jmap/client.ts
/** Seconds until the upload allowance is back, when the server refuses uploads now; else null. */
uploadRetryAfter(accountId?: Id): Promise<number | null>;
// src/app/contacts.ts — replaces Task 2's importCards
export interface ImportResult {
  imported: number;
  failed: { name: string; error: string }[];
  cancelled: boolean;
  /** Set when the server's upload allowance ran out: its own words, and the seconds until it is back if it said. */
  quota?: { message: string; retryAfter: number | null };
  /** Cards not sent at all: after a stop, or after the allowance ran out. */
  left: number;
}
importVcards(blocks: { text: string; name: string; uid: string }[], opts?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; freshUids?: boolean }): Promise<ImportResult>;
importOpen: Accessor<boolean>; openImport(): void; closeImport(): void;
```

`importVcards`, per batch of at most **100 blocks and 4,000,000 characters** (a block of more than 7,000,000 characters fails alone with `This card is too large to import.`):
1. One request: `Blob/upload` creating every block as `text/vcard`, then `ContactCard/parse` calls of 10 `#key`s each. A parse call that failed whole because a blob was refused is sent again, in a second request, with only the keys that were created (by their real ids).
2. A block the upload refused with `overQuota` ends the import after this batch's parsed cards are saved: `quota.message` is the server's description, `quota.retryAfter` comes from `client.uploadRetryAfter()`, and every block not uploaded counts in `left`. Any other upload refusal, and a `notParsable` blob, is a failure under the block's peeked name (`This card could not be read.` for notParsable).
3. Each parsed card: the `vCard` property dropped; `addressBookIds` of the default book; `uid` kept, or a new one when it has none or `freshUids` is set (then member keys of imported groups that named an old uid are rewritten to the new); `created`/`updated` if missing; `kind: 'individual'` if missing. A card over the size limit loses its `data:` photos and is tried so.
4. One `ContactCard/set` creating the batch; `notCreated` entries are failures under the card's display name with the server's description.
5. `onProgress(done, total)` after every batch, where done counts blocks dealt with. `signal.aborted` is checked before each batch. A batch that fails as a whole (network) fails its blocks with the error message and stops. After the last batch one catch-up brings the new cards into the store.

The fake gains `Blob/upload` (inline `data:asText` only; `uploadsLeft: number` counted down, then `overQuota` with Stalwart's words; blobs kept by id), `ContactCard/parse` (more than 10 ids is `requestTooLarge`; an unresolved `#key` is `invalidResultReference` for the whole call; the first card of each blob through a small reader of `FN`, `N`, `EMAIL`, `TEL`, `ORG`, `NOTE`, `UID`, `KIND`, `MEMBER`, `PHOTO`; text with no card is `notParsable`; every parsed card carries a `vCard` property), and `uploadRetryAfter` on its client (`retryAfter: number | null`). `ContactCard/set` accepts and drops `vCard`.

Page behaviour:
- The tools row gains a "⋯" menu (`More contact actions`): `Import…`, `Export all` (or `Export this group` in a group view; a group export includes the group's card). The empty state also offers `Import…`. The selection toolbar's `Export` exports the selected people.
- **Export** builds `toVcards(...)` and downloads `contacts-YYYY-MM-DD.vcf` (`text/vcard;charset=utf-8`) through a temporary object URL (`download.ts`: `downloadText(name, type, text)`), then toasts `Exported <n> contacts.`
- **ImportDialog** (rozie Dialog, title `Import contacts`), in steps:
  1. A file input (`.vcf,text/vcard,text/x-vcard`, multiple) labelled `vCard files`. More than 25 MB in all: `These files are too large to import at once (25 MB at most).` Files are read with `File.text()`.
  2. Preview, from `splitVcards`, `peekVcard` and `findDuplicates` against the store, with nothing sent yet: `<n> contacts found` (and `, <g> of them groups`), `<d> already in your contacts` with a rozie Switch `Skip duplicates` (on), `<u> could not be read` when any. Nothing found: `No contacts were found in these files.` Under them, always, the note: `The server reads each contact as an uploaded file, and counts it against the same hourly allowance as your attachments (usually 1,000 files an hour; your administrator may have set another).` When the number to import is over 1,000 it is followed, as a warning, by `This is more than the usual allowance. The import will stop when the server's limit is reached; import the same files again later and the contacts already here are skipped.` Buttons `Cancel`, `Import <n>` (the number follows the switch).
  3. Importing: a `<progress>` with `Imported <done> of <total>` (`role="status"`), and `Stop`.
  4. Result: `Imported <n> contacts.`, `Skipped <d> already in your contacts.`, `Stopped: <r> were not imported.` after Stop; after the allowance ran out `The server's upload limit was reached: <r> contacts were not imported.` then the server's message, then `You can import them in about <m> minutes: choose the same files again, and the contacts already here are skipped.` (`in about an hour` when the time is unknown; `1 minute` singular; minutes rounded up) and `Until then you may not be able to attach files to a message.`; and `<f> could not be saved:` with their names and reasons (the first 20, then `and <x> more`). Button `Done`.
  With duplicates not skipped, `freshUids` is passed for the blocks whose uid exists.
- Closing during an import asks nothing and does not stop it silently: the close button is `Stop` until it ends.

- [ ] **Step 1: failing tests.** Fake: upload then parse in one request; 11 ids refused; the quota running out mid-batch; parse of a bad key. Client: `uploadRetryAfter` reads `Retry-After` from a 429 and is null on success. Store: 25 blocks import in one upload and three parse calls and the store holds 25; 250 blocks report progress `[100, 250]`, `[200, 250]`, `[250, 250]`; a junk block and a card the server refuses are failures by name and the rest are saved; an allowance of 130 imports 130 of 250, reports `quota` with the server's words and the retry time, and `left: 120`; an aborted signal after the first batch leaves 100 imported, `cancelled: true`, `left: 150`; `freshUids` gives a new uid and rewrites a group's member key; a card with no uid gets one. Dialog (component, over the fake): preview counts for a three-card text with one duplicate; the note is shown; the switch changes `Import 2` to `Import 3`; 1,001 new cards show the warning; importing shows the result and the store holds the cards; a refused card is named; Stop after the first batch (250 cards and a held response) reports what was not imported; the allowance running out shows the limit text with `about 35 minutes`; the oversize message; nothing found; export calls `downloadText` with a name of today's date and a text whose blocks peek back to the same people (mock `download.ts`).
- [ ] **Step 2–4:** fail, implement, pass; by eye on the dev stack at desktop and 390px.
- [ ] **Step 5:** commit `Contacts: import through the server's parser, with its limit said, and export`.

### Task 6: Groups as recipients

**Files:** Modify `src/mail/recipients.ts`, `src/app/recipients.ts`, `src/ui/RecipientField.tsx`, `src/index.tsx`; tests in the existing files.

**Interfaces:** `suggest()` opts gain `lists?: { id: Id; name: string; count: number }[]`; a `Recipient` for a list has `email: ''`, `name`, `list: { id, count }` and ranks in the saved tier by name; `createRecipients` opts' `contacts` gains `groups: () => ContactCard[]`; `App.contacts` is used by `RecipientField` to expand.

Behaviour: a list matches when every word typed begins a word of its name (accents ignored); it is always offered, and picking one that adds nobody toasts `Everyone in <name> is already on this message.` or `Nobody in <name> has an email address.` The option shows the name and `List · <n> people` (`1 person`). Its Combobox value is `list:<id>`, which is never an address. Picking it (click, Enter, Tab, or Ctrl/Cmd+Enter with it highlighted, which must then hold the send exactly as a picked person does) calls `expandGroup`, adds the recipients not already in To, Cc or Bcc as chips in this field, and toasts `<m> of <n> in <name> have no email address.` when some were skipped. `offer()`'s typed-address row still leads. `limit` counts lists like any row.

- [ ] **Step 1: failing tests:** `suggest` offers a list by a prefix of any word of its name, between written-to people and the organisation, with its count; a list never appears for an address-shaped query that matches nothing of its name; `RecipientField` (new `RecipientField.test.tsx`, with the Combobox real) picking a list adds one chip per member and none for those already on the draft, and shows the toast for members without email; the existing recipient tests pass unchanged.
- [ ] **Step 2–4:** fail, implement, pass, then `pnpm exec playwright test e2e/compose.spec.ts --project=chromium`.
- [ ] **Step 5:** commit `Recipients: a contact group is offered by name and expands into its people`.

### Task 7: Browser tests, accessibility, phone, documents

**Files:** Create `e2e/contacts-groups.spec.ts`, `e2e/contacts-import.spec.ts`; modify `e2e/a11y.spec.ts`, `e2e/README.md`, `CHANGELOG.md`, `README.md`, `docs/operating.md`, the spec (Import section and Risks), `docs/rozie-feedback.md` if anything was found.

Both specs run as a user of their own, as `contacts.spec.ts` does.

- **Groups:** create a group from the sidebar; select two people and add them through the picker; the group view lists them; the card shows the chip and removing it empties the group view of that person; rename and delete with their confirms (the people remain); over JMAP the group card has `kind: group` and the members' uids. A person made over JMAP **without a uid** is added to a group: afterwards a card with the same data and a uid exists, the old id is gone, and the group names it. In the composer, typing the group's name offers `List · 2 people`; picking it gives two chips with the members' preferred addresses; a member with no email raises the toast; the message is sent and arrives addressed to both. `@phone`: select, add to group and the toolbar fit the screen.
- **Import:** a file of three cards in three vCard versions with one already present → preview counts → two imported, one skipped, and they read correctly on the page (name, both emails with their types, phone, organisation, birthday, note, photo). 300 generated cards import in full and the list counts them. **The allowance:** a user of the test's own imports until the server refuses (a file of 1,050 cards, tagged `@slow`, Chromium only): the result names the limit and the minutes, the list holds what was saved, and nothing is left half-made. A file with a group imports the group with its members linked. A text file that is no vCard says nothing was found. **Export** all, read the download back in the test, and compare names, emails and phones with JMAP; then destroy every card and import that file: the page shows the same people and the same group.
- **Axe:** the group view with a selection toolbar, the group dialog, the picker open, the import dialog at preview and at result; light and dark.
- Documents: CHANGELOG (groups, groups as recipients, import, export); README (features; remove groups and import/export from "Not in v1"; limits: no groups inside groups, no CSV, duplicates are skipped not merged); e2e/README rows; operating guide (import uses the upload quota, `Jmap.maxUploadCount` and `Jmap.uploadQuota`, and what raising them does; export is a file the browser makes); spec Import section and Risks updated to what was probed.
- [ ] Full verification: `pnpm typecheck && pnpm test && pnpm build && pnpm e2e:all`, known noise excepted and rerun alone.
- [ ] Commit `Contacts: browser tests for groups, import and export, and the documents`.
