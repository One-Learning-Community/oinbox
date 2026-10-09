# oinbox settings: signatures, identities, vacation responder

This slice adds a settings page where a user sets the signature of each identity they send from, adds, edits and deletes identities, and turns a vacation responder on and off with dates, a subject and a message.
It is slice 4 of the pilot-readiness work (a small team on its own Stalwart). Today there is no settings route. The composer reads identities with `Identity/get` and offers a From selector when there is more than one; signatures are fetched but never used.

## Goal

Alice clicks the gear in the top bar and opens Settings. She edits her identity, writes a signature with her name in bold and a link, and saves. Her next new message shows the signature under the text she types; in a reply it sits above the quoted message. She adds a second identity, "Alice (Support)", on the same address with a different signature; choosing it as From in the composer swaps the signature.
Before a week off she turns on the vacation responder for Monday to Friday with a subject and a short message. A banner reminds her it is on. A colleague who mails her that week gets one auto-reply. She turns it off from the banner when she is back.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Signature scope | Per identity, stored in the identity's `htmlSignature` and `textSignature`. | Decided with the user on 2026-10-02. It is the server's model, so other JMAP clients see the same signature, and a second identity can sign differently. |
| Placement in a reply or forward | Under the user's text, above the quoted message. | Decided with the user. The composer writes on top and collapses the quote behind "•••". |
| Signature format | Rich text, edited in rozie TipTap with the composer's toolbar. `textSignature` is derived from it on save. | Decided with the user. The server allows 2047 bytes of each, enough for formatting and links, not for images. |
| Vacation message format | Plain text (`textBody`); `htmlBody` is always sent as `null`. | Decided with the user. Plain text gets the full 2047 bytes; HTML plus the text copy the server derives from it share one 3504-byte budget. |
| Identity management | Create, edit and delete. Delete is unavailable on the last identity. | Decided with the user. Stalwart lets the last identity be destroyed and does not recreate it, which leaves the account unable to send. |
| How a signature lives in a draft | A field of its own (`signatureHtml`) beside `bodyHtml` and `quoteHtml`, shown under the editor, not inside it. | TipTap's StarterKit drops unknown `div`s and classes, so a signature typed into the editor could not be found again to swap or split out. |
| Vacation dates | Whole days in the browser's timezone. `fromDate` is local midnight of the first day; `toDate` is local midnight after the last day. Either may be open. | People think of time off in days. The server compares instants and stores them in UTC. |
| Mutations | Server-confirmed, no optimistic update. | As in the label slice: one fast request each, no rollback paths. |
| Save model | An explicit Save in the identity dialog and in the vacation form. The banner's "Turn off" saves at once. | A half-typed signature or message must not go live. |
| Reminder banner | Shown while the responder is on and not past its end date. | An auto-reply that is forgotten keeps answering for weeks. |
| rozie gaps | Logged in `docs/rozie-feedback.md`. A component that blocks the work pauses it for the user to fix upstream. | Project rule. |

## Server facts

Probed against Stalwart 0.16.23 on the dev stack on 2026-10-02, by writing probe identities and vacation settings (removed or reset afterwards) and by mailing Alice from Bob over SMTP. The fake must match these.

**Identity**

- `Identity/set` create, update and destroy all work. The response carries `newState` but no `oldState`. A `created` entry carries only `id`.
- Writable on update: `name`, `textSignature`, `htmlSignature`, `replyTo`, `bcc`. Updating `email` is refused with `invalidProperties` ("Field could not be set.", `properties: ["email"]`). A JSON-pointer patch inside `replyTo` is refused.
- Create accepts only an address configured for the account. Another user's address and a `+tag` address are refused with `invalidProperties` "E-mail address not configured for this account."; a foreign domain or malformed address with "Invalid e-mail address."; a missing one with "Missing e-mail address.". The stored address is lowercased. Several identities may share an address.
- Limits, in UTF-8 bytes: `name` at most 254; `textSignature` and `htmlSignature` at most 2047 each. Over a limit: `invalidProperties` naming the field.
- At most 20 identities per account. The 21st create is refused with `overQuota` ("There are too many identities, please delete some before adding a new one.").
- `htmlSignature` is stored verbatim: a `<script>` came back untouched. `textSignature: null` is stored as `""`. An empty `name` is accepted.
- `mayDelete` is true for every identity and the last one can be destroyed. `Identity/get` then returns an empty list; nothing recreates a default. (A fresh account does get one: `deploy/seed/seed_mail.py` reads Alice's first identity on an empty stack.)
- `Identity/changes` works. Push reports changes as type `Identity`.

**VacationResponse**

- `urn:ietf:params:jmap:vacationresponse` is in the session and in the account's capabilities (an empty object) and must be in `using`.
- `VacationResponse/get` always returns the `singleton`. On a new account it is all `null` with `isEnabled: false`.
- `VacationResponse/set` takes partial updates and returns `oldState` and `newState`. Create and destroy are refused with `singleton`. An unknown id is `notFound`. `VacationResponse/changes` is `unknownMethod`.
- Dates must be full UTC date-times. A date-only string is refused with `invalidProperties` on the field. An offset (`+02:00`) is accepted and stored converted to `Z`. `toDate` before `fromDate` is accepted.
- Limits, in UTF-8 bytes: `subject` 511, `textBody` 2047, `htmlBody` 2047, and `textBody` + `htmlBody` together 3504. With `textBody` null the server derives a text part from the HTML, and that copy counts.
- Empty strings are stored as empty strings. Enabling with no subject and no body is accepted.
- It is implemented as a Sieve script named `vacation`, made active when enabled. Push reports changes as type `SieveScript`, not `VacationResponse`.
- Replies observed: `Auto-Submitted: auto-replied` and `In-Reply-To` set; From is the account's name (`Alice Example`), not the identity's; `subject: null` becomes "Auto: <original subject>"; a text-only response is `text/plain`. One reply per sender while the response is unchanged: changing the subject or the body makes the same sender eligible again. No reply before `fromDate`, after `toDate`, or when disabled.

Not probed: whether the server applies an identity's `replyTo` or `bcc` at submission, and identities for alias or group addresses (the dev accounts have none).

## Architecture

```
src/
  mail/settings.ts        new. Pure: byte limits, identity and vacation validation, signature
                          conversion, vacation day <-> UTC conversion. No Solid, no JMAP.
  mail/compose.ts         Draft.signatureHtml; buildEmailCreate places it; splitDraftHtml
  jmap/types.ts           + VACATION capability, VacationResponse, Identity/set, VacationResponse/get|set
  sync/engine.ts          + createIdentity, updateIdentity, destroyIdentity, loadVacation,
                          updateVacation; state.vacation; Identity and SieveScript pushes
  sync/fake-jmap.ts       + Identity/get|set|changes from a real map, VacationResponse/get|set
  app/settings.ts         new. Identity and vacation operations with confirm, toasts, error text
  app/composer.ts         signature per composer: default, swap on From change, remove, inline
  app/context.tsx         + settings on App
  ui/SettingsView.tsx     new. The /settings page: identities section and vacation section
  ui/IdentityDialog.tsx   new. Add and edit dialog (rozie Dialog + TipTap)
  ui/VacationForm.tsx     new. The vacation section (rozie Switch, Popover, DatePicker)
  ui/VacationBanner.tsx   new. The reminder above the mail views
  ui/ComposerView.tsx     signature block under the editor
  ui/Shell.tsx            gear button; banner
  index.tsx               /settings route
```

`ui/` never calls `jmap/`, as before. Every new JMAP call lives in `sync/engine.ts`.

## Rules (`src/mail/settings.ts`)

Everything that writes a signature, an identity or the vacation response goes through this module, so the dialog, the form and the fake agree.

```ts
const LIMITS = { name: 254, signature: 2047, vacationSubject: 511, vacationBody: 2047 }; // UTF-8 bytes

function utf8Length(s: string): number;

interface IdentityInput { name: string; email: string; signatureHtml: string }
type IdentityCheck = { ok: true; value: { name: string; email: string; htmlSignature: string; textSignature: string } } | { ok: false; field: 'name' | 'email' | 'signature'; error: string };
function checkIdentity(input: IdentityInput, creating: boolean): IdentityCheck;

function signatureText(html: string): string;            // htmlToText, trailing newlines trimmed
function signatureForCompose(i: Identity): string;       // sanitized HTML, '' when none

interface VacationInput { enabled: boolean; firstDay: string | null; lastDay: string | null; subject: string; message: string } // days as YYYY-MM-DD
type VacationCheck = { ok: true; patch: Omit<VacationResponse, 'id'> } | { ok: false; field: 'dates' | 'subject' | 'message'; error: string };
function checkVacation(input: VacationInput, tz?: string): VacationCheck;
function vacationInput(v: VacationResponse, tz?: string): VacationInput;  // the reverse, for the form
type VacationStatus = { kind: 'off' } | { kind: 'scheduled'; from: Date; until: Date | null } | { kind: 'on'; until: Date | null } | { kind: 'ended' };
function vacationStatus(v: VacationResponse | null, now: Date): VacationStatus;
```

### Identity checks

- `name` is trimmed, with inner runs of whitespace collapsed to one space. An empty name is allowed (the server accepts it; the address then shows alone).
- On create, `email` is trimmed and must look like `local@domain` with no spaces; whether the account owns it is the server's call.
- An empty editor (`''` or `<p></p>`) is an empty signature: both fields are sent as `""`.
- `htmlSignature` is the editor's HTML run through `sanitizeEmailHtml` (remote images allowed: it is the user's own content).
- `textSignature` is `signatureText(htmlSignature)`.

| Input | Field | Message |
|---|---|---|
| Name over 254 bytes | name | "The name is too long." |
| Create with an empty address | email | "Enter the address to send from." |
| Create with an address that isn't `local@domain` | email | "'<text>' isn't an email address." |
| `htmlSignature` or `textSignature` over 2047 bytes | signature | "The signature is too long (<n> of 2047 bytes). Shorten it or remove some formatting." `<n>` is the larger of the two. |

### Signature in the composer

`signatureForCompose(identity)`:

- `htmlSignature` when it isn't blank, run through `sanitizeEmailHtml` with remote images allowed. Another client may have stored anything there.
- Otherwise `textSignature` turned into HTML with `plainTextToHtml`, so a signature set elsewhere as plain text still appears.
- Otherwise `''`.

### Vacation checks and dates

- `firstDay` `null` means "starting now" (`fromDate: null`); `lastDay` `null` means "no end date" (`toDate: null`).
- `fromDate` is the UTC instant of 00:00 on `firstDay` in `tz` (default: the browser's). `toDate` is the instant of 00:00 on the day after `lastDay`. Both are written as `YYYY-MM-DDTHH:MM:SSZ`.
- `vacationInput` turns them back: `firstDay` is the local date of `fromDate`; `lastDay` is the local date of `toDate` minus one millisecond. A `toDate` set by another client to a time other than local midnight therefore shows as the day it falls in, and saving rounds it to the end of that day.
- The subject is trimmed; an empty subject is sent as `null`, which makes the server use "Auto: <original subject>".
- The message is sent as `textBody` with trailing whitespace trimmed; `htmlBody` is always `null`.
- `isEnabled` is `enabled`. A disabled response keeps its dates, subject and message, so turning it back on later restores them.

| Input | Field | Message |
|---|---|---|
| Both days set and `lastDay` before `firstDay` | dates | "The last day is before the first day." |
| Enabled, `lastDay` set and already past | dates | "The last day has already passed." |
| Subject over 511 bytes | subject | "The subject is too long." |
| Enabled with an empty message | message | "Write a message for the auto-reply." |
| Message over 2047 bytes | message | "The message is too long (<n> of 2047 bytes)." |

`vacationStatus`: `off` when disabled or not loaded; `ended` when `toDate <= now`; `scheduled` when `fromDate > now`; otherwise `on`.

## Composer (`src/mail/compose.ts`, `src/app/composer.ts`)

`Draft` gains `signatureHtml: string`. `initialDraft` leaves it `''`; the composer fills it.

- **Default.** A new composer of any mode (new, reply, reply all, forward) sets `signatureHtml` to `signatureForCompose` of its default identity. A composer restored after Undo send keeps the draft it had.
- **From changes.** `setIdentityId` replaces `signatureHtml` with the new identity's signature, unless the user removed the signature or moved it into the text in this composer (a per-composer `signatureMode: 'auto' | 'removed' | 'inline'`; both of the latter stop swapping).
- **Remove.** Clears `signatureHtml` and sets the mode to `removed`.
- **Edit in this message.** Appends `signatureHtml` to `bodyHtml`, clears it, sets the mode to `inline`, and puts it in the editor. The same move as expanding the quote.
- Each of these schedules an autosave, as any draft change does.

`buildEmailCreate`:

- HTML part: `bodyHtml`, then `<div class="oinbox-signature">signatureHtml</div>` when the signature isn't empty, then `quoteHtml`.
- Text part: the text of `bodyHtml`, then `-- ` on a line of its own and the signature's text, then the text of `quoteHtml`. The `-- ` line is the usual delimiter that mail clients use to recognise a signature. The HTML part has no delimiter line.

`splitDraftHtml(html)`, used by `openDraft` for a draft reopened from Drafts:

- Parses the HTML.
- If a top-level `div.oinbox-signature` exists, its contents become `signatureHtml`, everything before it `bodyHtml`, and everything after it `quoteHtml`. A reopened reply keeps its signature above its quote, and From can still swap the signature.
- Without the block (a draft from another client or from before this slice), the whole HTML stays the body, as today.
- The composer's mode is `auto` when a signature was split out, otherwise `removed`, so no signature is added to a draft that had none.

## Engine (`src/sync/engine.ts`)

Each method throws an `Error` carrying the server's description, as the label methods do, with the server's `type` and `properties` attached (`SetFailure`) so the app layer can map them.

| Method | Request | On success |
|---|---|---|
| `createIdentity(value): Promise<Id>` | `Identity/set` create with `name`, `email`, `htmlSignature`, `textSignature`. | Merges the identity (the sent values, with the returned id and `mayDelete: true`) into `state.identities`, at the end. |
| `updateIdentity(id, patch)` | `Identity/set` update with `name`, `htmlSignature`, `textSignature` only. | Merges the patch. |
| `destroyIdentity(id)` | `Identity/set` destroy. `notFound` counts as success. Refused locally, before any request, when `id` is the only identity in the store. | Removes it from `state.identities`. |
| `loadVacation()` | `VacationResponse/get` with `ids: ["singleton"]`, `using` including the vacation capability. | Sets `state.vacation`. |
| `updateVacation(patch)` | `VacationResponse/set` update of `singleton`, same `using`. | Merges the patch into `state.vacation`. |

- `state.vacation` is `VacationResponse | null`; `null` means not loaded or not supported.
- `start()` calls `loadVacation()` after its first batch when the account's capabilities include the vacation capability. A failure leaves `state.vacation` `null` and is not reported: the settings section then says the responder couldn't be loaded and offers Retry.
- `state.vacation` is not written to the warm-start snapshot. It loads on every start, so a stale "on" banner never shows.

Changes from elsewhere:

- `onStateChange` refetches all identities (`Identity/get`, `ids: null`) when the `Identity` state differs from the last one seen.
- It calls `loadVacation()` when a `SieveScript` state arrives that differs from the last one seen.
- `catchUp()` after a reconnect does both.

## App layer (`src/app/settings.ts`)

`createSettings(engine, toast, confirm, accountEmail)` returns the operations the UI calls. It owns confirmation, toasts and the wording of errors, like `labels.ts`.

- `saveIdentity(id | null, input): Promise<Id>`: runs `checkIdentity`, then `engine.createIdentity` or `engine.updateIdentity`. Toasts "Identity added." or "Identity saved.". Throws `{ field, message }` for the dialog to show inline.
- `removeIdentity(id): Promise<boolean>`: returns `false` at once for the last identity. Otherwise it confirms, titled "Delete identity?", with the message "'<Name <address>>' will no longer be offered as From. Sent mail and drafts are not changed." and the button "Delete" ("Deleting…" while running), then toasts "Identity deleted.".
- `saveVacation(input): Promise<void>`: runs `checkVacation`, then `engine.updateVacation`. Toasts "Vacation responder on.", "Vacation responder scheduled.", or "Vacation responder off.", according to the resulting status.
- `turnOffVacation(): Promise<void>`: `engine.updateVacation({ isEnabled: false })` and the "off" toast.

Server refusals the local checks missed, mapped to a field and a message:

| Server answer | Field | Message |
|---|---|---|
| `invalidProperties` on `email`, "not configured" | email | "This account can't send as <address>. Ask your administrator to add it as an alias." |
| `invalidProperties` on `email`, other descriptions | email | "'<address>' isn't an email address." |
| `invalidProperties` on `name`, a signature field, `subject` or `textBody` | that field | The matching "too long" message from the rules. |
| `overQuota` on create | form | "You can have at most 20 identities. Delete one first." |
| `notFound` on update | form | "This identity no longer exists." |
| Anything else | form | The server's description. |

## UI

### Entry point and route

- The top bar gets a gear button, accessible name "Settings", before the theme toggle. It links to `/settings`.
- The route `/settings` is declared before `/:slug` in `index.tsx`. No Caddy-proxied prefix clashes with it.
- The page fills the main area. The sidebar stays, so the folders and Compose remain one click away, and `g` shortcuts and `c` work as everywhere else. No mailbox is shown as active.
- The page has an `h1` "Settings" and one `h2` per section: "Identities and signatures" and "Vacation responder".

### Identities and signatures section

- One row per identity, in server order: `Name <address>` (or the address alone), a preview of the signature (sanitized, muted, clipped to four lines), and two buttons, "Edit" and "Delete", with accessible names "Edit <Name <address>>" and "Delete <Name <address>>".
- With one identity, its Delete button is disabled (`aria-disabled`, still focusable) and reads "Delete (your only identity)".
- A note under the list: "New messages are sent from the first identity unless you choose another." Choosing the default is out of scope; the composer's rule is unchanged.
- An "Add identity" button below the list.
- With no identities at all (deleted elsewhere), the section says "This account has no identity, so it can't send mail. Add one to send." with the Add button.
- The list follows changes from other clients through the engine's store.

### Identity dialog (`src/ui/IdentityDialog.tsx`)

Opened by Add and Edit; closed by Cancel, Escape or a successful save.

- Title "Add identity" or "Edit identity".
- Fields:
  - Name: text, accessible name "Name".
  - Address: a text input on create, prefilled with the account's address and selected; read-only text on edit, with the hint "The address can't be changed."
  - Signature: rozie TipTap with the composer's formatting toolbar (bold, italic, underline, lists, link) and the accessible name "Signature".
- Focus: Name has focus when the dialog opens.
- Submitting: Ctrl/Cmd+Enter or the primary button ("Add" or "Save") submits. Enter in the Name or Address field submits too; Enter in the editor makes a new line. While the request runs both buttons are disabled and the primary one reads "Adding…" or "Saving…".
- Errors:
  - Each error appears under its field, linked with `aria-describedby` and announced with `role="alert"`. A form-level error appears above the buttons.
  - Validation runs on submit, then on every change once an error is showing.
  - A server refusal keeps the dialog open.
- If the identity being edited disappears while the dialog is open (deleted elsewhere), the dialog closes and toasts "This identity was deleted elsewhere.".
- When the dialog goes away, focus returns to the button that opened it (rozie Dialog does this).
- The app's single-key shortcuts are off while the dialog is open.

### Vacation responder section (`src/ui/VacationForm.tsx`)

- A status line at the top, from `vacationStatus`:
  - "Off."
  - "On. Replying until Fri 9 Oct." (or "until you turn it off.")
  - "Scheduled from Mon 5 Oct to Fri 9 Oct." (or "from Mon 5 Oct.")
  - "Ended on Fri 9 Oct." Dates are formatted in the browser's locale.
- The form, initialised from `vacationInput(state.vacation)`:
  - **Switch** (rozie Switch), labelled "Send automatic replies".
  - **First day**: a button showing the date, or "Starting now", that opens a rozie Popover holding a rozie DatePicker (single mode, footer on). Picking a day sets it and closes the popover; the footer's Clear sets "Starting now".
  - **Last day**: the same, showing "No end date" when unset. Its DatePicker has `min` set to the first day (or today).
  - **Subject**: text, accessible name "Subject", placeholder "Auto: (their subject)".
  - **Message**: a textarea, accessible name "Message". A byte count ("1,850 of 2,047") appears under it once the message passes 80% of the limit.
  - **Buttons**: "Save", and "Revert", which restores the form from the server state.
- **Before Save:** changes in the form do nothing until saved; the status line keeps describing the server state.
- **Saving:** Save shows "Saving…" while the request runs. Errors use the same inline pattern as the identity dialog, on the dates, subject or message.
- **Changes from elsewhere:** when `state.vacation` changes from another client while the form has no unsaved edits, the form reloads. With unsaved edits it keeps them and shows "Changed on another device. Revert to see the new settings."
- **Not available:** with `state.vacation` `null` after start, the section reads "The vacation responder couldn't be loaded." with a Retry button. When the account lacks the capability it reads "This server doesn't offer a vacation responder." instead.
- **Popover keyboard:** opening focuses the DatePicker grid; Escape closes it and returns focus to its button.
- **Known limitation:** a note under the section says "Turning this on replaces any mail filter (Sieve script) set up elsewhere.", because Stalwart activates its own `vacation` script and only one script is active at a time. (Not checked against an account with an existing active script; see "Out of scope".)

### Reminder banner (`src/ui/VacationBanner.tsx`)

- **When:** while `vacationStatus` is `on`, a one-line banner sits above the mail views (thread list and conversation), not on `/settings` or `/calendar`.
- **Content:** "Your vacation responder is on until Fri 9 Oct." (or "is on."), with two buttons: "Settings" (to `/settings`) and "Turn off".
- **Role:** `role="status"`, so it is announced once when it appears and not on every route change.
- **Turn off:** "Turn off" calls `turnOffVacation`; the banner goes away when the store updates.

### Composer signature block (`src/ui/ComposerView.tsx`)

- **What shows:** under the editor and above the "•••" quote toggle, when `signatureHtml` isn't empty, the signature renders read-only (sanitized, muted). Next to it are two buttons: "Edit signature in this message" (pencil icon) and "Remove signature" (× icon).
- **Keyboard and touch:** both buttons are in the tab order after the editor and are 44px on coarse pointers.
- **From changes:** changing From updates the block in place.

### Touch and keyboard

- Every control on the page, the dialog, the banner and the composer block is a native button, input or rozie control in the tab order.
- On coarse pointers (`@media (pointer: coarse)`) buttons and the switch are at least 44px tall.
- The page works at phone width: identity rows stack, and the two day buttons wrap.

### Component check

To be confirmed while writing the plan by reading the rozie sources, as in the label slice. Any finding goes to `docs/rozie-feedback.md`; anything that blocks pauses the work.

| Need | Component | To check |
|---|---|---|
| Add and edit dialog with a form and a rich-text field | Dialog 0.2.0 + TipTap 0.5.1 | TipTap inside a Dialog: initial focus on Name, Escape closing the dialog without being swallowed by TipTap's link editor. |
| On/off control | Switch 0.1.4 (new dependency) | A visible label associated with the control (`ariaLabel` or an external `<label>`); theming against our tokens. |
| Day picker | DatePicker 0.1.14 (new dependency) inside Popover 0.3.0 | Focus moving into the grid on open; the footer's Clear for "Starting now" / "No end date"; `min`; `locale` from the browser (the week starts on Sunday, as FullCalendar's default does here). |

## Fake JMAP (`src/sync/fake-jmap.ts`)

- **Identities:** a map with one identity (`id1`, "Alice", `alice@example.test`), served by `Identity/get` with `ids` honoured and a state counter.
- **`Identity/set`:**
  - Applies create, update and destroy, with the probed refusals: changing `email`; an address outside `ownAddresses` (default `['alice@example.test']`, settable by tests); a malformed or missing address; the byte limits on `name`, `htmlSignature` and `textSignature`; a 21st identity (`overQuota`); destroying an unknown id (`notFound`).
  - Lowercases the address and stores `textSignature: null` as `""`.
  - Responds without `oldState`.
- **`Identity/changes`:** answers from a change log, as `Mailbox/changes` does.
- **Vacation:** a `vacation` singleton, all null and disabled. `VacationResponse/get` serves it; `VacationResponse/set` applies partial updates, with the probed refusals:
  - create and destroy (`singleton`) and an unknown id (`notFound`);
  - a date that isn't a full date-time;
  - the byte limits, including the shared 3504-byte budget with a text part derived from the HTML when `textBody` is null.

  It accepts `toDate` before `fromDate`, as the server does.
- **`using`:** the fake records each request's `using`, and refuses vacation methods without the vacation capability (`unknownMethod`), as Stalwart does.

## Testing

**Unit (Vitest)**

- `mail/settings.test.ts`:
  - byte counting with multi-byte text;
  - every row of the identity and vacation error tables;
  - empty-editor handling;
  - signature text derivation;
  - `signatureForCompose` choosing HTML, falling back to text, and stripping a `<script>`;
  - day ↔ UTC in `Europe/London` across the October DST change and in a zone east of UTC;
  - `vacationInput` of a `toDate` that isn't midnight;
  - each `vacationStatus` case.
- `mail/compose.test.ts`:
  - `buildEmailCreate` places the signature between body and quote, adds the `-- ` text delimiter, and leaves both out with no signature;
  - `splitDraftHtml` with and without a signature block.
- `app/composer.test.ts` (new):
  - the default signature for each mode;
  - From change swaps it;
  - Remove and Edit in this message both stop swapping;
  - a reopened draft keeps its signature and its quote order;
  - Undo send restores the signature.
- `sync/engine.test.ts`, against the fake:
  - the three identity methods and their store updates;
  - `destroyIdentity` refused locally for the last identity;
  - `loadVacation` and `updateVacation` send the vacation capability;
  - an `Identity` push refetches identities;
  - a `SieveScript` push reloads the vacation response;
  - no vacation in the snapshot.
- `app/settings.test.ts`:
  - each row of the server-refusal table;
  - remove does nothing for the last identity;
  - the confirm text;
  - the vacation toast for each resulting status.

**End to end (Playwright, new `e2e/settings.spec.ts`)**

Every test passes on a fresh stack (CI): it relies only on Alice's default identity, which the seed's first `Identity/get` creates, and on Bob's account.

1. The gear opens Settings. Setting a signature on Alice's identity shows it in a new message. After sending, the message stored in Sent contains it in both parts (checked through JMAP).
2. A reply shows the signature block, and the saved draft has the signature before the quote.
3. Adding an identity named `e2e-<run>` on Alice's address lists it. In a new message, choosing it as From swaps the signature. Deleting it removes it from the list and from the From menu.
4. With one identity, Delete is disabled.
5. "Remove signature" in a message: the saved draft has no signature block.
6. Turning the responder on with today as the first day, a unique subject and a unique message shows the banner. A message from Bob (SMTP, `localhost:2525`) to Alice brings Bob an auto-reply with that subject, checked through JMAP as Bob. The unique text is needed because Stalwart answers each sender once per response.
7. The banner's "Turn off" hides the banner, and Settings then shows "Off.".
8. A last day before the first day shows the inline error and sends nothing.

**Cleanup**

- An `afterEach` and `e2e/cleanup.ts` (run by global setup):
  - destroy identities whose name starts with `e2e-`;
  - clear the signatures of Alice's other identities;
  - set the vacation response to `isEnabled: false` with every other field `null`.
- Mail is delivered with unique subjects and deleted afterwards in both Alice's and Bob's accounts, as the other specs do.
- Playwright runs one worker, so tests that change Alice's identity never overlap.

**Docs**

- `e2e/README.md` gets a row for `settings.spec.ts` in its coverage table.
- `README.md` lists settings among the features.
- `docs/rozie-feedback.md` gets the gaps found.

## Password (added 2026-10-08)

A signed-in user changes their own password in a fourth section of the page, after Notifications. Recovering a forgotten password is not part of it: someone who can't sign in asks an administrator, and Stalwart offers no recovery endpoint.

**Stalwart facts** (probed on 0.16.23 with a throwaway account on 2026-10-08; the fake must match these)

- The password is the object `x:AccountPassword`, a `singleton` of the user's own account, under the capability `urn:stalwart:jmap`. That capability is in the account's capabilities, not the session's, and must be in `using`.
- `x:AccountPassword/set` updates it with `currentSecret` and `secret`, and answers `updated: {singleton: null}`. oinbox's OAuth token is enough; no extra scope is needed.
- Refusals, in the server's order: no `currentSecret` is `forbidden` ("Current secret must be provided to change the password or OTP auth."); a wrong one is `forbidden` ("Current secret is incorrect."); under 8 characters, over 128, or a password its strength check finds too common is `invalidProperties` on `secret`, with a description fit to show.
- A password equal to the current one is accepted.
- Once it is set, the access token answers 401 and the refresh token `invalid_grant`, at once and for every session of the account, because token keys derive from the password hash.
- A shared mailbox (a group) has no such object: `/set` answers `notFound`. A member can't change it.

**Code**

| File | What |
|---|---|
| `src/app/password.ts` | `createPassword(client, onChanged)`: `supported()`, and `change({current, next, confirm})`, which checks, sends and throws a `FieldError`. Also the one-time notice for the sign-in card. |
| `src/ui/PasswordSection.tsx` | The form: current, new, confirm. |
| `src/ui/SignIn.tsx` | An optional `notice`, shown as a status. |
| `src/index.tsx` | Builds it for the user's own account; on success rescues open drafts, leaves the notice and goes to the sign-in card. |
| `src/sync/fake-jmap.ts` | `x:AccountPassword/set` as probed; requests are refused with 401 once the password is set. |

**Rules**

- The call always names the user's own account, whichever mailbox is on screen.
- Checked before asking the server: a current password is given; the new one has 8 to 128 characters, differs from the current one (Stalwart would accept it and sign every device out for nothing), and matches its confirmation. Passwords are sent as typed, spaces included.
- The server's refusals go next to the field they concern. "Current secret is incorrect." is reworded to "Current password is incorrect."; the reasons for a weak password are shown in Stalwart's words.
- On success the form stays locked, oinbox drops its tokens and caches and loads the sign-in card with "Password changed. Sign in with your new password." Drafts the server doesn't have yet are rescued as for any lost session. Other tabs and devices find their session ended in the usual way.
- Where the account doesn't advertise `urn:stalwart:jmap`, the section says the password can't be changed here.

**Tests**: `src/app/password.test.ts`, `src/ui/PasswordSection.test.tsx`, `src/ui/SignIn.test.tsx`, and `e2e/password.spec.ts`, which creates and deletes a user of its own (`e2e/support/accounts.ts`) so that alice's stored sign-in survives.

## Out of scope

- Editing an identity's `replyTo` and `bcc`, and applying them when sending.
- Choosing which identity is the default for new messages.
- Images in signatures (2047 bytes leaves no room for an inline image).
- An HTML vacation message, replying only to contacts, and different responses per identity.
- Sieve filters in general, and preserving another active Sieve script when the responder is turned on.
- A keyboard shortcut for Settings, and settings other than these three (the theme stays in the top bar).
- Sending as addresses the account doesn't own; adding aliases is an administrator's job in Stalwart.
- Recovering a forgotten password, two-factor settings (`otpAuth`) and app passwords.
