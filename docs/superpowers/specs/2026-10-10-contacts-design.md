# Contacts

An address book in oinbox: the people you deal with, kept on the mail server where your phone and other clients see the same cards, and offered when you address a message.

It is for our own use first, and for other Stalwart operators: a mail client without an address book is not an alternative to a commercial one.

Success: Alice opens Contacts, finds a supplier by typing part of the name or company, reads the phone number, and corrects the email address. She opens a message from someone new and saves them from the sender's name. Next time she writes, typing "acme" offers the people at Acme, saved names first. A card edited on her phone changes on screen without a reload.

Built in two slices on one branch, `contacts`, stacked on `org-recipients`:

1. Viewing, editing and suggestions.
2. Groups, vCard import and export.

## What Stalwart gives us

Probed on 0.16.23, 2026-10-10, with throwaway accounts. The full notes are in the memory file `stalwart-contacts-quirks`; what shapes the design:

- **Cards are JSContact** (`ContactCard`), stored much as sent. Names, several emails and phones with contexts, organisations with units, titles, addresses, notes, anniversaries, links, keywords and media all round-trip.
- **Almost nothing is validated.** A malformed email, a nameless card and duplicate addresses are accepted. Unknown properties and a card in no address book are refused.
- **The server writes no `uid`, `created` or `updated`.** A `uid` can be given only at creation, and is unique in the account. `name.full` is derived from the components once, at creation, and not again.
- **A patch below a missing parent fails** (`notes/n9` on a card with no `notes`).
- **A photo is a `data:` URI inside the card** (or an http URL). `blobId` is refused. A card is at most 524,288 bytes.
- **Query cannot carry the page.** There is no sort by name; `OR` returns nothing and `NOT` returns the wrong set; text search depends on the search store (prefixes on Meilisearch, most likely whole words on OpenSearch); names are indexed from components only; a new card is searchable about 250 ms late.
- **Change tracking works.** `ContactCard/changes`, `AddressBook/changes`, and `ContactCard` / `AddressBook` on the event stream, including for a card written over CardDAV.
- **Limits:** 500 objects per get and per set. `ContactCard/get` with `ids: null` returns the first 500 without saying so.
- **Groups:** a card of `kind: "group"` with `members: {<uid>: true}`. Keys are not checked; a phone may write `mailto:` keys.
- **Parse:** `ContactCard/parse` reads vCard 2.1, 3.0 and 4.0 from a blob, but only the first card in it. `Blob/upload` and a parse of `"#key"` work in one request. There is no export.
- **Sharing a book** puts the owner's whole account in the other person's session, mail capability included, though mail there is forbidden.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Place | A page of its own at `/contacts`, with `/contacts/:id` for an open card. A Contacts link sits beside Calendar. | Agreed 2026-10-10. |
| Whose | The user's own contacts account only. The link is not shown while a shared mailbox is open, as with Calendar. Suggestions and the person popover use the user's contacts in every mailbox. | Agreed. The address book is the person's, whichever mailbox they write from. |
| Loading | The whole address book is held in the browser, sorted and searched there, kept current by `/changes` and push, and stored in IndexedDB for the next start. | The server cannot sort by name or search reliably. The directory already works this way. |
| Layout | List on the left, the open card read-only on the right. On a phone the list fills the screen and a card replaces it, with a back button. | The shape Mail has. |
| List | A plain HTML table with virtual rows (the adapter the thread list uses): Name, Email, Phone, Organisation. Sorted by name. Email alone accompanies the name on a phone. | Agreed 2026-10-10: rozie DataTable is a spreadsheet-grade grid, and nothing here needs one. |
| Editing | One rozie Dialog for new, edit and add-from-mail. Full-screen on a phone. | Agreed. One form serves all three; cancel is unambiguous. |
| Fields edited | Given name, surname, photo; emails; phones; organisation, department, job title; postal addresses; birthday; notes. | Agreed. |
| Other data | Nicknames, links, online services, keywords and anything else on a card are shown read-only and survive a save untouched. | A phone's or an import's data must not be lost by editing a phone number here. |
| Writes | A save sends only the properties the user changed, each as a whole map. New cards get a `uid`, `kind`, `created`; every save sets `updated`, and `name.full` when the name was changed. | Edits made elsewhere to other fields survive. The server does none of this itself. |
| Add from mail | A person popover on names in a message and on recipient chips: Add to contacts, or Open and Edit when already saved. | Agreed. |
| Suggestions | Written-to first; then saved contacts; then the organisation; then strangers. The saved name wins. One row per address. | Agreed. |
| Groups | Standard group cards. In the composer a group expands into one chip per member. | Agreed: who receives a message must be visible. |
| Import | The browser splits the file; the server parses each card. Preview, duplicates skipped by default. | Agreed. Stalwart parses one card per blob, and parses vCard better than we would. |
| Export | vCard 4.0 written in the browser. | JMAP has no export. |
| Address books | No management. New cards go to the default book. Cards in any other book of the user's are shown and edited where they are. | One book is what people have; a second made by another client must not hide its cards. |

## How it fits together

```
src/jmap/types.ts        ContactCard, AddressBook, method signatures, CONTACTS, CONTACTS_PARSE
src/contacts/card.ts     pure: reading a card (display name, emails, phones…), the form model, the patch a save sends
src/contacts/search.ts   pure: sort order and the type-ahead filter
src/contacts/photo.ts    downscale a picked image to a data: URI
src/contacts/groups.ts   pure (slice 2): members of a group, who a group expands to
src/contacts/vcard.ts    pure (slice 2): split a .vcf, write vCard 4.0, find duplicates
src/app/contacts.ts      the store: load, changes, push, cache, create / update / delete, dialog state
src/mail/recipients.ts   suggest() takes saved contacts (and, in slice 2, groups) beside the directory
src/ui/ContactsView.tsx  the page: list, search, card
src/ui/ContactCard.tsx   the read-only card
src/ui/ContactDialog.tsx the form
src/ui/PersonPopover.tsx the popover for a name in a message or a chip
src/ui/ImportDialog.tsx  (slice 2)
```

### The store (`src/app/contacts.ts`)

One store for the app, built beside `calendar` and `directory`, on the account `primaryAccounts[CONTACTS]` names. `hasContacts()` is false when the server has no such capability; nothing of this feature is shown then.

- **State:** `cards` by id, `books` by id, `loaded`, and the card and book state strings.
- **Start:** read the IndexedDB copy (`contacts:<key>`, dropped on sign-out with the rest), show it, then catch up with `/changes` from its state. With no copy, or on `cannotCalculateChanges`, load everything: `ContactCard/query` in pages of 500 with a back-referenced `ContactCard/get` in the same request, until a page comes back short.
- **Changes:** on a push naming `ContactCard` or `AddressBook` with a state not yet seen, and on every reconnect, `/changes` is read until `hasMoreChanges` is false; created and updated cards are fetched in chunks of 500.
- **Writes:** `create`, `update`, `remove` return `{ok}` or `{ok: false, error}` as the calendar store's do. The store applies the server's answer and fetches the saved card; nothing is shown as saved before the server has it.
- **Delete** asks nothing and offers Undo in the toast. Undo creates the card again with the same content and `uid`, so its group memberships hold. The id is new.
- **A failed load** is one error toast and an empty state with Retry on the page; suggestions simply go without contacts.

### Reading and writing a card (`src/contacts/card.ts`)

- **Display name:** given name and surname from the components, found by `kind` and never by position; else `name.full`; else the organisation; else the first email; else "No name". Two given names or two surnames stored as separate components are shown joined, and a rename replaces only the part that was changed. Other name components (a title, a middle name) are kept and shown but not edited.
- **Labels:** an email is Work, Personal or Other from its contexts. A phone is Mobile, Work, Home or Other from its features and contexts, Mobile winning. Contexts and features are rewritten only when the user changes the label.
- **Preferred email:** the lowest `pref`; else the first. Marking one preferred sets `pref: 1` on it and clears the others.
- **Organisation:** the first organisation's name and its first unit; the job title is the first title of kind `title`.
- **Address:** one text block, `full`. An address with components and no `full` is shown joined. Editing the text writes `full` and drops the components, which would otherwise contradict it.
- **Birthday:** day and month, year optional, as a `PartialDate` anniversary of kind `birth`.
- **The patch:** for each property the form changed, the whole map, built from the stored entries so that keys and unedited sub-fields are kept. Unchanged properties are not sent.
- **Checks before sending,** since the server makes none: something to call the card by (a name, an organisation or an email); each email a valid address; the card within 524,288 bytes. Messages appear by the field.

### Photo (`src/contacts/photo.ts`)

A picked image is drawn to a canvas, cropped square, scaled to 256 px and stored as a JPEG `data:` URI (about 20 kB). Without a photo, a card shows an initial on a colour derived from the name. A photo that another client stored as an http URL is not fetched, since loading it would tell a third party the card was opened; the initial is shown instead.

### Suggestions (`src/mail/recipients.ts`, `src/app/recipients.ts`)

`suggest()` gains `contacts`: one entry per email of each saved person, with the card's display name, whether it is the preferred address, and the organisation and nicknames as extra words to match.

- Rank: written to (most recent first); saved and not yet written to (by name, a person's preferred address first); the organisation (by name); the rest.
- The saved name replaces the directory's and the mail history's. A row from the directory that is also saved keeps its Group mark if it is one.
- A saved address is offered even when its mailbox name looks like a robot's.
- A saved row carries a small "Contact" mark, as groups carry "Group".
- The limit stays at six rows.

### The page (`src/ui/ContactsView.tsx`)

- **Navigation:** "Contacts" under Calendar, shown when `hasContacts()` and the user's own mailbox is open. "New contact" takes the place of Compose on this page.
- **List:** a `<table>` whose body renders only the rows in view, through `src/ui/virtual.ts`, with spacer rows keeping the scroll height. Each name is a link to its card, so a row is opened by click or Enter and the arrow keys move between rows. The open card's row is marked. A count ("212 contacts") sits above.
- **Search:** a box above the list, filtering as you type. Every word typed must begin a word of the name, nickname, organisation or an email, or occur in a phone number's digits. Diacritics and case are ignored.
- **Card:** photo or initial, name, organisation and title; emails (each a link that opens the composer addressed to it); phones (`tel:` links); addresses; birthday; notes; then the read-only extras. Edit and Delete at the top.
- **Empty states:** no contacts yet (with New contact, and Import in slice 2); nothing matches the search; no card chosen.
- **A card deleted elsewhere while open** returns to the list with a toast.

### The dialog (`src/ui/ContactDialog.tsx`)

Sections in the order of "Fields edited". Emails, phones and addresses are rows with a label picker (a native `<select>`: rozie has no Select) and a remove button, and an "Add" button under each. Save is disabled while saving; an error from the server appears in the dialog and nothing closes. Closing with unsaved changes asks first, through the existing confirm dialog. If the card is deleted elsewhere while it is being edited, the save reports that it no longer exists.

### The person popover (`src/ui/PersonPopover.tsx`)

Opened from the sender's name and the To/Cc names of an expanded message, and from the label of a recipient chip. It shows the name and address; for a saved person also phone, organisation and photo; for someone in the directory, that they are in the organisation.

- Not saved: **Add to contacts**, which opens the dialog with the display name split at its last space into given name and surname, and the address as the first email.
- Saved: **Edit**, and **Open in Contacts** (not offered inside a shared mailbox, where there is no Contacts page).
- In a message, also **New message** to that address.

Clicking a message header still expands and collapses it; the name becomes a button within it.

### Shared address books and the account list

An account that appears in the session because someone shared an address book lists the mail capability but refuses mail. Today it would be offered in the account switcher and fail with an error toast at every start. `startAll` will treat a shared account whose mail is `forbidden` as not a mailbox: no toast, and it is left out of the switcher.

## Slice 2

### Groups (`src/contacts/groups.ts`)

- A group is a card of `kind: "group"`. Its members are the `uid`s of people's cards. Stalwart lets a `uid` be set only when a card is created, so a person's card that has none (one made by another JMAP client) is replaced by a copy with a `uid` when first added to a group. A `mailto:` member written by another client counts as a bare address when expanding, and is shown in the group but cannot be added here.
- A group inside a group is ignored. A member `uid` matching no card is ignored and kept.
- **Navigation:** on the Contacts page the groups are listed under the Contacts link, with "+" to create one; `/contacts/group/:id` shows its members in the same list. Rename and Delete are in a "⋯" menu as for labels. Deleting a group keeps its people.
- **Membership:** the table gains a checkbox column, with a select-all box in its header; a selection offers "Add to group", "Remove from group" (inside one), Export and Delete. A card shows its groups as chips, with a picker to add or remove.
- **Group cards are not listed among people** and are not offered by the person popover.

### Groups as recipients

A group matches as a suggestion by its name and is marked "List · 5 people". Picking it adds one chip per member, by preferred email, skipping addresses the draft already has. Members with no email are skipped and a toast says how many. A group with nobody to add is offered but adds nothing, and says so.

### Import (`src/ui/ImportDialog.tsx`, `src/contacts/vcard.ts`)

1. The user picks one or more `.vcf` files (25 MB in all at most).
2. The browser cuts them into cards at `BEGIN:VCARD` / `END:VCARD`.
3. Cards are parsed by the server in batches: `Blob/upload` for a batch, then `ContactCard/parse` of those blobs, in one request.
4. A preview: cards read, cards that could not be read, and likely duplicates. A duplicate has the `uid` of an existing card, or failing that an email address an existing person has. "Skip duplicates" is on by default.
5. Import saves in batches (at most 100 cards and 5 MB a request), showing progress. Cancel stops after the batch in flight; what is saved stays. A photo that puts a card over the size limit is downscaled as a picked photo is.
6. The result: imported, skipped, failed (with the names of those that failed).

Imported cards go to the default book, get a `uid` if they have none, and keep whatever the parser produced. Group cards are imported as groups.

### Export

"Export" in the list's toolbar: all contacts, the group on screen, or the selection. One `contacts-YYYY-MM-DD.vcf`, vCard 4.0: `UID`, `KIND`, `FN`, `N`, `NICKNAME`, `EMAIL`, `TEL`, `ORG`, `TITLE`, `ADR`, `BDAY`, `NOTE`, `URL`, `CATEGORIES`, `PHOTO`, `MEMBER`. Properties outside that list are not exported.

## Fake server and fixtures

`src/sync/fake-jmap.ts` gains `AddressBook/get`, `AddressBook/changes`, `ContactCard/get`, `/set`, `/changes`, `/query` (paging only), and for slice 2 `Blob/upload` and `ContactCard/parse`, with the probed behaviour: no `uid` or dates added; `name.full` derived at creation only; unknown properties and a missing book refused; a patch below a missing parent refused; 500 per get and set; `ids: null` cut at 500; the 524,288-byte limit.

The dev stack needs no new fixture: every account has an empty default book.

## Testing

- **Unit:** `card.ts` (reading cards made here, by CardDAV and by the parser; the patch, including preserved entries and the missing-parent rule), `search.ts`, `groups.ts`, `vcard.ts`, `recipients.ts` ranking with contacts, the store against the fake (paged load past 500, changes, push, cache, undo), and the dialog, card and popover components.
- **Browser** (`e2e/contacts.spec.ts`, slice 2 in `e2e/contacts-groups.spec.ts` and `e2e/contacts-import.spec.ts`), on all four projects: create, find, edit and delete with undo; a card changed over JMAP by the test appears without a reload; add from a message's sender and from a chip; a saved contact is suggested under its saved name and by organisation; phone layout; axe on the page, the open card, the dialog and the popover. Slice 2: a group made, filled and expanded into chips; a multi-card file imported with a duplicate skipped; an export read back.
- The specs run as **a user of their own**, created and removed with Stalwart's CLI as `password.spec.ts` does, so that alice's suggestions in the other specs do not change.

## Documents

`CHANGELOG.md` ("Unreleased"), `README.md` (features and known limits), `e2e/README.md` (the new specs), `docs/operating.md` (contacts count against nothing but the request limits; CardDAV is not proxied by the bundled Caddy), and `docs/rozie-feedback.md` for whatever Dialog or Popover turn out to lack.

## Not in this version

- The shared mailbox's address book as a team book, and sharing a book with someone.
- Creating, renaming or deleting address books; moving a card between books.
- Adding an address from a message to an existing contact; merging duplicates.
- CSV. Groups inside groups. A bare address as a group member.
- Editing nicknames, links, online services, keywords, name prefixes and suffixes.
- Proxying CardDAV through oinbox's Caddy, so a phone can sync through the same origin.
- A Stalwart search of contacts: everything is searched in the browser.

## Risks

- **A very large address book.** Everything is in memory and in IndexedDB. Ten thousand cards with photos is about 200 MB; without photos, a few MB. If that proves real, the cache can drop photos first.
- **Import and the upload quota.** Whether `Blob/upload` counts against Stalwart's 1,000 uploads an hour is not known; it is measured when import is built, and an import that would exceed it says so.
- **Addresses lose their components when edited here.** A phone then shows the address as one label. Accepted for a free-text field.
- **Undo of a delete makes a new id.** A CardDAV client sees a delete and a create.
