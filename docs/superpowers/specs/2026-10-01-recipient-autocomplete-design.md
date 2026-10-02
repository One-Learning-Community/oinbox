# oinbox recipient autocomplete from mail history

This slice makes the To, Cc and Bcc fields suggest people as the user types.
It is slice 2 of the pilot-readiness work (a small team on its own Stalwart). Slice 1 added the composer end-to-end tests that guard this change.

## Goal

Alice starts a message, types "bo" in To, and sees "Bob Example · bob@example.test" in a list under the field. She presses Enter and Bob becomes a recipient.
The suggestions come from her own mail: people she has written to and people who have written to her. They work on the first day, with an empty address book and without signing in again.
Typing or pasting a full address keeps working exactly as it does today.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Source | Mail history only: recipients of Sent mail, senders of synced mail, recipients of messages sent in this session | Works on day one and needs no new OAuth scope. The Stalwart address book is empty for a new user and asking for the contacts scope signs everyone out once. |
| Address book (JMAP Contacts) | Not in this slice | Decided with the user on 2026-10-01: contacts become their own slice later. The index is built so that a second source can feed it. |
| Where the index lives | In the browser: memory, plus IndexedDB per user | No server component exists. The cache makes suggestions instant on the next visit. |
| Sent scan | One request per session, after the inbox has loaded: the newest 500 messages of the Sent mailbox, properties `to`, `cc`, `bcc`, `receivedAt` | 500 small records are cheap, and recent correspondents are the ones worth suggesting. |
| Senders | Taken from every email the engine merges, through a callback | These emails are already synced, so this costs no request. |
| Ranking | People Alice has written to come first; then the most recent contact; then the most frequent | "Sent to" is the strongest signal that an address is wanted again. The order is deterministic, so it can be tested. |
| Component | `@rozie-ui/combobox-solid` in `multiple` mode with `disableFilter`, replacing `@rozie-ui/tags-solid` in the recipient fields | Dogfooding: Combobox already has the popup, keyboard navigation and chips. Tags has no suggestion support and no way to clear its typed text from outside. See "Component check". |
| Fallback component | Keep Tags and add our own `role="listbox"` popup, positioned with `@floating-ui/dom` | The retreat if building the field shows a blocker that reading the Combobox source missed. Switching to it is a decision for the user, not the implementer. |
| rozie gaps | Logged in `docs/rozie-feedback.md`, whichever component wins | Project rule. |

## Architecture

```
src/
  mail/recipients.ts       new. Pure: the index type, add(), suggest(). No Solid, no JMAP.
  sync/engine.ts           + sentRecipients(limit): the Sent scan
                           + onEmails callback: reports merged emails (like onPersist)
  cache/persist.ts         + loadRecipients / saveRecipients; clearCache also deletes them
  app/recipients.ts        new. The store: builds, caches and queries the index.
  app/context.tsx          + recipients on App
  app/composer.ts          send() records the recipients of the message being sent
  ui/ComposerView.tsx      RecipientField gets suggestions
  index.tsx                creates the store and starts it after engine.start()
```

`ui/` reads the store and never calls `jmap/`, as before. The only new JMAP call lives in `sync/engine.ts`.

## The index (`src/mail/recipients.ts`)

One entry per address, keyed by the lower-cased address:

```ts
interface Recipient {
  email: string;      // as first seen, original case
  name: string;       // the most recent non-empty display name, else ''
  sent: number;       // messages Alice sent to this address
  received: number;   // messages received from this address
  last: string;       // ISO time of the most recent contact in either direction
}
type RecipientIndex = Record<string, Recipient>;
```

- `add(index, addresses, kind: 'sent' | 'received', at: string): RecipientIndex` counts one contact for each address and updates `name` and `last` when `at` is newer.
- Counting must not double count. The store remembers which email ids it has already counted (see "The store").
- `suggest(index, query, opts: { exclude: Set<string>; limit: number }): Recipient[]`.

### Matching

The query is trimmed, lower-cased and split on whitespace. An entry matches when **every** query word is a prefix of at least one of the entry's tokens. The tokens are:

- the words of `name`, split on whitespace and punctuation;
- the mailbox part of the address, whole and split on `.`, `_`, `-` and `+`;
- the domain, whole and each label after the first dot (`mail.example.test` gives `mail.example.test`, `example.test`, `test`);
- the whole address.

An empty query returns nothing, so the list never opens on focus alone.

### Ranking

Sorted by, in order: `sent > 0` before `sent === 0`; newer `last` first; higher `sent + received` first; then `email` ascending as the tie-breaker.

### Exclusions

- addresses in `opts.exclude`: Alice's own addresses (`engine.myAddresses()`) and every address already in To, Cc or Bcc of this draft;
- robots, never added to the index: a mailbox part matching `no-reply`, `noreply`, `do-not-reply`, `donotreply`, `mailer-daemon`, `postmaster`, `bounce` or `bounces`, alone or followed by `+`, `-` or `.` and more text.

## The store (`src/app/recipients.ts`)

`createRecipients(engine)` returns `{ suggest(query, exclude), recordSent(emailId, addresses), start(username), scanSent() }`. It is created right after the engine, before the warm-start snapshot is applied, so it sees every email.

1. **Warm start.** `start(username)` loads `recipients:<username>` from IndexedDB into memory. The stored value holds the index and the set of counted email ids. Emails reported before `start()` has finished are held back and counted afterwards, so the loaded ids stop them being counted twice. A stored value of the wrong shape is ignored.
2. **Senders.** The engine calls `onEmails(emails)` whenever it merges emails or applies a snapshot. For each email with a `from` and a `receivedAt` that has not been counted, and that is not a draft and not from one of Alice's own addresses, the store adds `from` as `received`.
3. **Sent scan.** After `engine.start()` resolves, `index.tsx` calls `scanSent()` once, which calls `engine.sentRecipients(500)`. For each returned email not yet counted, it adds `to`, `cc` and `bcc` as `sent`. If there is no Sent mailbox, the scan is skipped.
4. **Sending.** `composer.send()` calls `recordSent()` with the sent email's id and its To, Cc and Bcc addresses when the send succeeds. The id is marked as counted, so the next Sent scan doesn't count it again.
5. **Saving.** Changes are written back to IndexedDB at most once every 5 seconds. Before saving, the index is cut to the 2,000 best-ranked entries and the counted-id set to the 5,000 most recently added ids, so neither grows without bound.
6. **Sign-out.** `clearCache()` deletes the stored value.

`sentRecipients(limit)` is one batch: `Email/query` with `{ inMailbox: <sent id> }`, sorted by `receivedAt` descending, `limit`; then `Email/get` of those ids through a back-reference, with properties `to`, `cc`, `bcc`, `receivedAt`.

### Failure handling

Suggestions are a convenience and never block writing mail.

- A failed cache read or write is swallowed.
- `scanSent()` rejects when the scan fails and leaves the store usable. `index.tsx` passes the error to the app's existing `onAuthError`, like the calendar load does, and otherwise drops it. The field then suggests from whatever the index holds, possibly nothing.

## The recipient field (`src/ui/ComposerView.tsx`)

Behaviour, the same for To, Cc and Bcc:

| Input | Result |
|---|---|
| Typing text that matches | A list of up to 6 suggestions opens under the field. Each row shows the name, then the address; a row with no name shows the address only. The first row is highlighted. |
| ArrowDown / ArrowUp | Moves the highlight. |
| Enter or Tab, list showing | Adds the highlighted suggestion and clears the typed text. |
| Enter, no list | Adds the typed text if it is a complete address, as today. |
| The field loses focus (Tab with no list, or a click elsewhere) | Adds the typed text if it is a complete address, as today. |
| `,` or `;` | Adds the typed text if it is a complete address, as today. Never picks a suggestion. |
| Click on a row | Adds that suggestion and keeps focus in the field. |
| Escape, list open | Closes the list and leaves the composer open. A second Escape closes a floating composer, as today. |
| Pasting `a@x.test, b@y.test` | Adds both, as today. |
| Backspace in an empty field | Removes the last recipient, as today. |
| Typing text that matches nothing | No list. |

Enter and Tab prefer the list over the typed text because the address parser accepts `bob@ex` as complete; a rule that preferred "complete" typed text would add that instead of the highlighted Bob. A full address of someone unknown matches nothing, so no list shows and the typed text is added.

The draft model does not change: each field still holds `EmailAddress[]`. A picked suggestion becomes `{ name: name || null, email }`.

Accessibility: the input is a `combobox` with `aria-expanded`, `aria-controls` and `aria-activedescendant`; the list is a `listbox` of `option`s. The accessible names stay "To", "Cc" and "Bcc".

### Component check

Done on 2026-10-01 by reading the Combobox 0.6.0 source while writing the plan. The field is built on Combobox (`multiple`, `disableFilter`; `creatable` is not needed).

| Behaviour | Combobox 0.6.0 | What the field does |
|---|---|---|
| Backspace in an empty input removes the last chip | Built in | Nothing. |
| `,` and `;` commit the typed text | Not supported | Handles the keys on a wrapper element and clears the input with the `seedQuery('')` handle method. |
| Pasting several addresses adds them all | Not supported | Handles `paste` on the wrapper. |
| Tab picks the highlighted option | Not supported, and the active option is not exposed | Reads the input's `aria-activedescendant`. |
| No list when nothing matches | The list opens on focus and shows "No results" | Hides a list that has no options with CSS. `aria-expanded` stays `true` while the field has focus. |
| Escape with no list showing | Always consumed while the field has focus | The field tells the composer whether a list was really showing. |

Each row that needs a workaround is written to `docs/rozie-feedback.md`. `@rozie-ui/tags-solid` is removed from `package.json`, since nothing else imports it.

## Testing

**Unit (Vitest)**

- `mail/recipients.test.ts`: `add` counts, keeps the newest name and time; matching by name word, mailbox part, mailbox token, domain and several query words; an empty query; ranking in each of its four steps; exclusion of listed addresses; robots never indexed.
- `app/recipients.test.ts`, against the in-memory JMAP fake: the Sent scan fills the index; merged emails add senders; an email is counted once across a scan, a merge and `recordSent`; own addresses and drafts are skipped; a failed scan leaves the store usable.
- `sync/engine.test.ts`: `sentRecipients` sends the batch described above and returns its emails; with no Sent mailbox it returns an empty list without a request.

**End to end (Playwright, `e2e/compose.spec.ts`)**

- Typing "bo" in To lists Bob (the seed has mail from Alice to Bob); Enter adds him as a recipient; the message sends and reaches Bob.
- ArrowDown then Enter picks the second suggestion.
- A suggestion already in To is not offered in Cc.
- Tab picks the highlighted suggestion; Escape closes the list and a second Escape closes the composer.
- A recipient of a message sent in this session is suggested straight away (a plus-address of Bob, which Stalwart delivers to Bob).
- Free text still works: `,` commits, pasting two addresses adds both, Backspace removes the last.
- The six existing composer tests pass unchanged. They enter addresses as free text, so they guard that path. Only the locators in `e2e/support/compose.ts` change: the input's role becomes `combobox` and the chips get Combobox's class.

## Out of scope

- The Stalwart address book and any contacts page (a later slice).
- The team directory (`urn:ietf:params:jmap:principals`).
- Removing or editing a suggestion.
- Suggestions in the search box.
