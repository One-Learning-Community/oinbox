# Contacts, slice 2 (groups, import, export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contact groups that can be addressed as recipients (expanding into one chip per member), and vCard import and export.

**Architecture:** A group is a JSContact card of `kind: "group"` whose members are other cards' `uid`s; pure functions in `src/contacts/groups.ts` resolve and expand them, and the store gains group and bulk operations. vCard reading and writing is a pure module, `src/contacts/vcard.ts`, used by an import dialog (preview, duplicates, batches) and an export action. The contact list gains a checkbox column and a selection toolbar.

**Tech Stack:** as slice 1 (SolidJS 1.9, rozie Dialog / Popover / Switch, Vitest, Playwright, Stalwart 0.16.23).

**Spec:** `docs/superpowers/specs/2026-10-10-contacts-design.md`, "Slice 2". Built on the branch `contacts`, after slice 1.

## One decision this plan changes, for approval

The spec has the **server** parse imported vCards. Probed on 2026-10-10 after the spec was written: every card parsed that way is one blob, and inline blobs count against Stalwart's upload quota, **1,000 files an hour per account, the same allowance attachments use**. An import of 800 cards would leave the person unable to attach a file for the rest of the hour, and a file of more than about 1,000 cards could not be imported in one go.

This plan therefore parses vCards **in the browser** (Task 4). The cost is a parser of our own (about 250 lines with its tests) that will know fewer oddities than Stalwart's; the gain is no limit, no effect on attachments, and an import that works the same on every Stalwart configuration. The alternative, keeping the server's parser and stopping at the quota with a message, is a change to Task 4 and Task 5 only. **The spec's Import section is updated in Task 7 to whichever is approved.**

## Global Constraints

- Everything in slice 1's Global Constraints still holds (branch, no push, 500 per get and set, `uid` only at creation, changed properties only, the 524,288-byte card, plain table, rozie Dialog/Popover, no new dependencies, exact strings).
- A group card: `{ '@type': 'Card', version: '1.0', kind: 'group', uid, created, updated, name: { full }, members: { <uid>: true }, addressBookIds }`. Member keys are the members' `uid`s, exactly as stored on their cards.
- A group never contains a group here; a member key that names a group card, or no card, is ignored when expanding and kept when saving.
- A `mailto:` member key written by another client expands to that address and is shown in the group; it cannot be added or edited here.
- A recipient group always expands into one chip per member. No "group chip".
- Imported and exported files are vCard; export writes version 4.0, UTF-8, CRLF line ends, lines folded at 75 octets.
- Commit after every task, prefix `Contacts:`.

## Review Focus

1. **vCards as real programs write them** (Google, Apple, Outlook, Thunderbird): folded lines, `item1.EMAIL` property groups, `ENCODING=QUOTED-PRINTABLE` with `CHARSET`, bare LF line ends, a byte-order mark, escaped commas and semicolons, `TYPE=INTERNET,HOME` and `TYPE=HOME;TYPE=PREF`, `PHOTO;ENCODING=b`, Apple's `X-ADDRESSBOOKSERVER-KIND:group`. Pinned in Task 4.
2. **A group whose members have changed under it:** a member deleted, a member with no email, a member with two emails, the same address reached twice, a member that is itself a group. Pinned in Task 1.
3. **A large or partly bad import:** 1,500 cards with some the server refuses, cancelled half-way. What is saved stays, the count is true, the failures are named. Pinned in Tasks 5 and 7.
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
/** Create cards in batches. Never throws for one bad card. */
importCards(cards: Partial<ContactCard>[], opts?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<{ imported: number; failed: { name: string; error: string }[]; cancelled: boolean }>;
```

Behaviour:
- `createGroup` / `renameGroup` set `name: { full }` and `updated`; both reuse `createCard` and the update path. `renameGroup` of a group that is gone → `'This group no longer exists.'`.
- `addToGroup`: for each card with no `uid`: create a copy (all properties, a new `uid`, `created` kept, `updated: now`) and, **only after that create succeeded**, destroy the original; then one `ContactCard/set` updating the group with `members: membersWith(...)` and `updated`. If nothing would change, no request.
- `removeFromGroup`: `members: membersWithout(...)` (`null` clears it).
- `removeMany`: `destroy` in chunks of 500; `notFound` counts as removed; the first other refusal is reported and the rest of that chunk's successes still count.
- `importCards`: each card gets `addressBookIds` of the default book, `'@type'`, `version`, a `uid` if it has none, `created`/`updated` if missing; batches of at most 100 cards and 5,000,000 bytes of JSON (a single card over the batch size goes alone); `notCreated` entries are collected with `displayName` of the card and the server's description; a batch that fails as a whole (network) marks all its cards failed with the error message and the import stops; `signal.aborted` is checked before each batch; after the last batch one `catchUp` brings the new cards into the store (cards are not fetched one by one).
- The fake: `ContactCard/set` already refuses a second card with a `uid`; add `rejectCardCreates: Set<string>` (creation keys or uids the fake refuses with `invalidProperties` "Invalid property.") for the partial-failure test.

- [ ] **Step 1: failing tests:** group created with kind and uid and listed in `groups()` but not in `people()`; rename; delete leaves members; add two people, one without a uid (the fake then holds a copy with a uid and not the original, and the group names both uids); adding someone already in changes nothing and sends nothing; remove the last member clears `members`; `removeMany` of 3 with one already gone reports 3; import of 250 cards makes three sets, reports progress `[100, 250]`, `[200, 250]`, `[250, 250]` and the store holds 250; import with two refused cards reports them by name and imports the rest; an aborted signal after the first batch leaves 100 imported and `cancelled: true`; a card of 3 MB travels in a batch of its own.
- [ ] **Step 2–4:** fail, implement, pass (`pnpm vitest run src/app src/sync && pnpm typecheck`).
- [ ] **Step 5:** commit `Contacts: the store makes and fills groups, deletes several people, and imports in batches`.

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

### Task 4: vCard, read and written (`src/contacts/vcard.ts`)

**Files:** Create `src/contacts/vcard.ts`, `src/contacts/vcard.test.ts`.

**Interfaces — Produces:**

```ts
/** The cards of a file's text, each from BEGIN:VCARD to END:VCARD. */
export function splitVcards(text: string): string[];
/** One vCard (2.1, 3.0 or 4.0) as a card to create, or null when it holds nothing usable. No id, no addressBookIds. */
export function parseVcard(vcard: string): Partial<ContactCard> | null;
export function parseVcards(text: string): { cards: Partial<ContactCard>[]; unreadable: number };
/** vCard 4.0, CRLF, folded at 75 octets. */
export function toVcard(card: ContactCard): string;
export function toVcards(cards: ContactCard[]): string;
export interface DuplicateCheck { fresh: Partial<ContactCard>[]; duplicates: Partial<ContactCard>[] }
/** A duplicate has the uid of an existing card or of an earlier card in the file, or, failing a uid match, an email an existing person has. Groups are matched by uid only. */
export function findDuplicates(parsed: Partial<ContactCard>[], existing: ContactCard[]): DuplicateCheck;
```

Reading:
- A leading byte-order mark is dropped; line ends may be CRLF or LF; a line starting with a space or tab continues the one before (and, in 2.1 quoted-printable, a line ending in `=` continues on the next).
- A line is `[group.]NAME[;PARAM[=value[,value]]…]:value`; the group prefix (`item1.`) is dropped; names and parameter names are case-insensitive; a 2.1 bare parameter (`TEL;HOME;VOICE`) is a `TYPE`; a parameter value may be quoted.
- `ENCODING=QUOTED-PRINTABLE` is decoded to bytes and read in `CHARSET` (default UTF-8) with `TextDecoder`; an unknown charset falls back to UTF-8.
- Text values unescape `\n`, `\N`, `\,`, `\;`, `\\`. Structured values (`N`, `ADR`, `ORG`) are split on unescaped `;`.
- Mapping: `FN` → `name.full`; `N` → components surname, given, given2 (additional), title (prefix), credential (suffix), in that order, `isOrdered` not set; with `N` and no `FN`, `full` is "given surname"; `NICKNAME` (comma list) → `nicknames`; `EMAIL` → `emails` (`TYPE` work → `contexts.work`, home → `contexts.private`; `PREF` as a 4.0 parameter, a 3.0 `TYPE=PREF` or a 2.1 bare `PREF` → `pref: 1`, or the 4.0 number); `TEL` → `phones` (cell or mobile → `features.mobile`; fax → `features.fax`; work, home as contexts; a `tel:` value kept as it is); `ORG` → one organisation with units; `TITLE` → `titles` kind `title`; `ADR` → `addresses` with `full` built from the non-empty parts on separate lines (street, then "locality region postcode", then country) and no components; `BDAY` → a birth anniversary from `YYYY-MM-DD`, `YYYYMMDD` or `--MM-DD` (anything else is dropped); `NOTE` → `notes`; `URL` → `links`; `CATEGORIES` → `keywords`; `PHOTO` → a `data:` URI (a 4.0 `data:` value as it is; `ENCODING=b`/`BASE64` with `TYPE=JPEG` → `data:image/jpeg;base64,…`); an http photo is dropped; `UID` → `uid`; `KIND` or `X-ADDRESSBOOKSERVER-KIND` → `kind` (`group`, else `individual`); `MEMBER` or `X-ADDRESSBOOKSERVER-MEMBER` → `members` (the value as it is, so `urn:uuid:…` and `mailto:…` both survive). Everything else is ignored.
- Keys are `e1…`, `p1…`, `a1…`, `n1`, `o1`, `t1`, `b1`, `m1`, `l1…`, `k1…` (nicknames) in file order.
- A card with no name, organisation, email or phone, and not a group, is `null`. A block that is not `BEGIN:VCARD … END:VCARD`, or has no parsable line, counts as `unreadable`.

Writing: `VERSION:4.0`, then `UID` (when present), `KIND`, `FN` (the display name), `N` (surname;given;given2;title;credential from the components by kind), `NICKNAME`, `EMAIL` (`TYPE=work|home`, `PREF=1`), `TEL` (`TYPE=cell|work|home|fax`), `ORG`, `TITLE`, `ADR` (`;;<full with \n escaped>;;;;` with `TYPE`, since slice 1 keeps addresses as text), `BDAY` (`YYYYMMDD` or `--MMDD`), `NOTE`, `URL`, `CATEGORIES`, `PHOTO` (the `data:` URI), `MEMBER`. Values escape `\`, `,`, `;` and newlines. Lines are folded so that no line exceeds 75 octets of UTF-8, never inside a multi-byte character.

- [ ] **Step 1: failing tests**, with fixtures written inline as the programs write them: a Google export card (3.0, `item1.EMAIL;TYPE=INTERNET`, `item1.X-ABLabel`), an Apple card (3.0, `X-ABUID`, `PHOTO;ENCODING=b;TYPE=JPEG` folded over lines, `X-ADDRESSBOOKSERVER-KIND:group` with members), an Outlook 2.1 card (`N;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:M=FCller;J=F6rg`, soft line breaks, `TEL;WORK;VOICE`, `EMAIL;PREF;INTERNET`), a 4.0 card with `PREF=1`, `--0314`, `KIND:group`, `MEMBER:urn:uuid:…`; LF-only line ends and a BOM; escaped commas and semicolons in `NOTE` and `ORG`; three cards in one text with junk between them (`unreadable: 0`, junk ignored) and a truncated last card (`unreadable: 1`); an empty card is `null`; `toVcard` of the slice 1 test card matches a fixture line for line; a folded line of accented text never splits a character and unfolds to the original; **round trip**: for a set of cards covering every written property, `parseVcards(toVcards(cards))` gives cards whose readers (`displayName`, `emailsOf`, `phonesOf`, `organizationOf`, `addressesOf`, `birthdayOf`, `notesOf`, `photoOf`, `uid`, `kind`, `members`) agree with the originals; `findDuplicates` by uid, by email (case ignored), a card repeated inside the file, and a group matched only by uid.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `Contacts: vCards read and written in the browser`.

### Task 5: Import and export on the page

**Files:** Create `src/ui/ImportDialog.tsx` (+ test), `src/contacts/download.ts`; modify `src/ui/ContactsView.tsx`, `src/app/contacts.ts` (dialog state `importOpen`), `src/ui/Shell.tsx`, `src/ui/styles.css`.

Behaviour:
- The tools row gains a "⋯" menu (`More contact actions`): `Import…`, `Export all` (or `Export this group` in a group view; a group export includes the group's card). The empty state also offers `Import…`. The selection toolbar's `Export` exports the selected people.
- **Export** builds `toVcards(...)` and downloads `contacts-YYYY-MM-DD.vcf` (`text/vcard;charset=utf-8`) through a temporary object URL (`download.ts`: `downloadText(name, type, text)`), then toasts `Exported <n> contacts.`
- **ImportDialog** (rozie Dialog, title `Import contacts`), in steps:
  1. A file input (`.vcf,text/vcard,text/x-vcard`, multiple) labelled `vCard files`. More than 25 MB in all: `These files are too large to import at once (25 MB at most).` Files are read with `File.text()`.
  2. Preview, from `parseVcards` and `findDuplicates` against the store: `<n> contacts found` (and `, <g> of them groups`), `<d> already in your contacts` with a rozie Switch `Skip duplicates` (on), `<u> could not be read` when any. Nothing found: `No contacts were found in these files.` Buttons `Cancel`, `Import <n>` (the number follows the switch).
  3. Importing: a `<progress>` with `Imported <done> of <total>` (`role="status"`), and `Stop`. A card over the size limit with a photo has the photo re-encoded through `photoDataUri` first; if still over, it is sent without the photo.
  4. Result: `Imported <n> contacts.`, `Skipped <d> already in your contacts.`, `Stopped: <r> were not imported.` after Stop, and `<f> could not be saved:` with their names and reasons (the first 20, then `and <x> more`). Button `Done`.
  With duplicates not skipped, a card whose `uid` exists is imported under a new `uid` (the server refuses a second card with one), and group cards have that member's key rewritten to match.
- Closing during an import asks nothing and does not stop it silently: the close button is `Stop` until it ends.

- [ ] **Step 1: failing tests** (component, over the fake): preview counts for a three-card text with one duplicate; the switch changes `Import 2` to `Import 3`; importing shows the result and the store holds the cards; a refused card is named in the result; Stop after the first batch (use 250 cards and a held response) reports what was not imported; the oversize message; nothing found; export calls `downloadText` with a name of today's date and a text that parses back to the same people (mock `download.ts`).
- [ ] **Step 2–4:** fail, implement, pass; by eye on the dev stack at desktop and 390px.
- [ ] **Step 5:** commit `Contacts: import with a preview, and export`.

### Task 6: Groups as recipients

**Files:** Modify `src/mail/recipients.ts`, `src/app/recipients.ts`, `src/ui/RecipientField.tsx`, `src/index.tsx`; tests in the existing files.

**Interfaces:** `suggest()` opts gain `lists?: { id: Id; name: string; count: number }[]`; a `Recipient` for a list has `email: ''`, `name`, `list: { id, count }` and ranks in the saved tier by name; `createRecipients` opts' `contacts` gains `groups: () => ContactCard[]`; `App.contacts` is used by `RecipientField` to expand.

Behaviour: a list matches when every word typed begins a word of its name (accents ignored); it is always offered, and picking one that adds nobody toasts `Everyone in <name> is already on this message.` or `Nobody in <name> has an email address.` The option shows the name and `List · <n> people` (`1 person`). Its Combobox value is `list:<id>`, which is never an address. Picking it (click, Enter, Tab, or Ctrl/Cmd+Enter with it highlighted, which must then hold the send exactly as a picked person does) calls `expandGroup`, adds the recipients not already in To, Cc or Bcc as chips in this field, and toasts `<m> of <n> in <name> have no email address.` when some were skipped. `offer()`'s typed-address row still leads. `limit` counts lists like any row.

- [ ] **Step 1: failing tests:** `suggest` offers a list by a prefix of any word of its name, between written-to people and the organisation, with its count; a list never appears for an address-shaped query that matches nothing of its name; `RecipientField` (new `RecipientField.test.tsx`, with the Combobox real) picking a list adds one chip per member and none for those already on the draft, and shows the toast for members without email; the existing recipient tests pass unchanged.
- [ ] **Step 2–4:** fail, implement, pass, then `pnpm exec playwright test e2e/compose.spec.ts --project=chromium`.
- [ ] **Step 5:** commit `Recipients: a contact group is offered by name and expands into its people`.

### Task 7: Browser tests, accessibility, phone, documents

**Files:** Create `e2e/contacts-groups.spec.ts`, `e2e/contacts-import.spec.ts`; modify `e2e/a11y.spec.ts`, `e2e/README.md`, `CHANGELOG.md`, `README.md`, `docs/operating.md`, the spec (Import section, per the decision above), `docs/rozie-feedback.md` if anything was found.

Both specs run as a user of their own, as `contacts.spec.ts` does.

- **Groups:** create a group from the sidebar; select two people and add them through the picker; the group view lists them; the card shows the chip and removing it empties the group view of that person; rename and delete with their confirms (the people remain); over JMAP the group card has `kind: group` and the members' uids. A person made over JMAP **without a uid** is added to a group: afterwards a card with the same data and a uid exists, the old id is gone, and the group names it. In the composer, typing the group's name offers `List · 2 people`; picking it gives two chips with the members' preferred addresses; a member with no email raises the toast; the message is sent and arrives addressed to both. `@phone`: select, add to group and the toolbar fit the screen.
- **Import:** a file of three cards in three vCard versions with one already present → preview counts → two imported, one skipped, and they read correctly on the page (name, both emails with their types, phone, organisation, birthday, note, photo). 1,200 generated cards import in full and the list counts them (this is the case the server's parser could not do). A file with a group imports the group with its members linked. A text file that is no vCard says nothing was found. **Export** all, read the download back in the test, and compare names, emails and phones with JMAP; then destroy every card and import that file: the page shows the same people and the same group.
- **Axe:** the group view with a selection toolbar, the group dialog, the picker open, the import dialog at preview and at result; light and dark.
- Documents: CHANGELOG (groups, groups as recipients, import, export); README (features; remove groups and import/export from "Not in v1"; limits: no groups inside groups, no CSV, duplicates are skipped not merged); e2e/README rows; operating guide (import is done in the browser and uses no upload quota; export is a file the browser makes); spec Import section rewritten to match.
- [ ] Full verification: `pnpm typecheck && pnpm test && pnpm build && pnpm e2e:all`, known noise excepted and rerun alone.
- [ ] Commit `Contacts: browser tests for groups, import and export, and the documents`.
