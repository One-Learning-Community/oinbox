# Shared mailboxes

A team address such as `support@` is a mailbox several people work from. This slice lets a member of such a mailbox open it in oinbox, read and triage it, and answer from it, and shows at a glance when a mailbox they are not looking at has unread mail.

It is for our own use first: a small business on Stalwart where two or three people share `support@` and `sales@`.

Success: Alice, a member of `support@`, switches to Support, sees its Inbox live, replies as `support@`, and the reply is filed in Support's Sent for Bob to see. While she is in her own mailbox, a dot and a count tell her Support has unread mail.

## What Stalwart gives us

Probed on 0.16.23, 2026-10-08.

- A shared mailbox is an `Account` of type `Group`. A user is made a member through `memberGroupIds`.
- For each member, the group appears in the JMAP session as a second entry in `accounts`, with `isPersonal: false`, `isReadOnly: false`, and the same capabilities as a personal account. `primaryAccounts` still names the user's own account.
- The group account has its own Inbox, Drafts, Sent and so on, with full rights, and its own `Identity` for the group address. Mail to the group address is delivered to the group's Inbox only.
- The member's one push stream carries state changes keyed by each account id.
- A draft created in the group's Drafts and submitted with `accountId` set to the group and the group's identity is sent as the group.
- The member's personal account also gains an identity for the group address. oinbox already lists it, so "send as support@ from my own mailbox" works today and is not changed here.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Model | One sync engine per account, and an account switcher. One account is on screen at a time. | Agreed 2026-10-08. The engine stays as the beta audit left it; a merged view would thread an account through every query, action and cache entry. |
| Which accounts | Every account in the session that has the mail capability. The user's own comes first and is the default. | It is what the session says the user may open. |
| Address | The user's own account keeps today's URLs. A shared account lives under `/shared/<accountId>/…`, using the router's base path. | A reload, a second tab, the back button and a notification click all land in the right account, and no existing link changes. |
| Unread elsewhere | The switcher lists each account with its Inbox unread count; closed, it shows a dot when another account has unread mail. The tab title counts unread Inbox conversations across all accounts. | The request: know that the other boxes need attention without opening them. |
| Notifications | Desktop notifications cover every account. For a shared account the title leads with its name ("Support: Nora Notifier"). A click switches to that account and opens the conversation. | A shared inbox is where missed mail costs most. |
| Sending | In a shared account the composer offers that account's identities, and the message is submitted from that account, so the sent copy and the draft live in the shared mailbox. | Colleagues must see what was answered. |
| Calendar | Personal only. The Calendar link is not shown while a shared account is open. | Group calendars are a separate piece of work. |
| Settings | Identities, signatures and the vacation responder shown are those of the account that is open. The notifications switch is per browser and appears in both. | Each engine already loads its own account's settings; a signature for `support@` belongs to the team. |
| Rights | Not enforced in the interface. An action the server refuses is rolled back with the existing error toast. | Group members have full rights. Finer-grained shares are untested (see "Not in this slice"). |
| New memberships | Seen on the next load of the page. | The session is read once at start-up today; watching it for changes is not worth it for something that happens a few times a year. |

## How it fits together

```
JmapClient (one: session, token, transport)
   │
   ├─ AccountSpace "b"  alice@      engine, actions, labels, settings, composers, recipients
   ├─ AccountSpace "f"  support@    engine, actions, labels, settings, composers, recipients
   │
push stream (one) ── StateChange ──► every engine; each takes the entry for its own account id
```

### The client

`JmapClient` stays one per sign-in. Its `accountId` getter remains and means "the user's own account". Upload and download take the account id as an argument instead of assuming it.

### The engine

`MailEngine` takes an account id in its options; `engine.accountId` returns that, no longer the client's primary account. Nothing else in the engine changes: every call it makes already goes through `this.accountId`. `hasVacation()` and `labelLimits()` read the capabilities of the engine's own account.

### Account spaces

A new `src/app/accounts.ts` builds one **account space** per mail account in the session: the engine and everything that hangs off it today (`actions`, `labels`, `settings`, `composers`, `recipients`). It exposes:

- `list`: the spaces, the user's own first, the rest by name;
- `current()`: the space on screen;
- `unread(space)`: its Inbox's `unreadThreads`;
- `label(space)`: "You" plus the address for the personal account; for a shared one, the local part of its address, capitalised ("Support"), with the full address beside it in the switcher.

All engines are started at sign-in. Starting one costs a `Mailbox/get` and an `Identity/get`; mail lists are read only when an account is opened. So unread counts for every account are live from the start, at the cost of two small calls per account.

`App` (the context) keeps its fields. `engine`, `actions`, `labels`, `settings`, `composers` and `recipients` become those of the current space. Components capture them once when they mount, so **switching account re-mounts the shell**: the router is keyed on the current account and given its base path. Nothing is reloaded from the network on switching back, since each engine keeps its own cache.

### Push, catch-up and connection

The one push stream hands each `StateChange` to every engine, and each ignores entries for other accounts (it does already). On connect and on retry, every engine catches up. The connection banner and status dot are unchanged: they describe the server, not an account.

### Warm start and other browser storage

- The start-up snapshot is stored per account (`snap:<username>:<accountId>`). An old snapshot under the previous key is ignored and removed.
- Recipient suggestions are stored per account in the same way.
- Draft rescue is already keyed by account id; every space's composers are saved and restored.
- Signing out clears all of them.

## What the user sees

### The switcher

At the top of the sidebar, above Compose, when the session has more than one mail account (with one account, nothing changes):

- a button showing the current account's label, and a dot when any other account has unread Inbox mail;
- opening it lists the accounts, each with its address and unread count; choosing one switches.

It is a menu button, operable from the keyboard, and each entry's accessible name includes its count ("Support, 3 unread"). On a phone it sits at the top of the drawer.

### Working in a shared account

Everything in the mail view works as it does in the user's own mailbox: list, conversation, search, labels, triage, compose, reply. Differences:

- the top bar's search searches the open account only;
- the composer's From offers the shared account's identities;
- there is no Calendar link;
- the sign-out button and the theme are unchanged.

### Composers across a switch

A composer belongs to the account it was opened in. Switching away hides it; nothing is discarded, autosave goes on, and it is there on switching back. The switcher marks an account that has a composer open ("draft open"), so text is not forgotten.

### Tab title and notifications

- Title: `(5) Inbox – Acme Mail`, where 5 is the unread Inbox conversations of all accounts together.
- A notification for a shared account reads "Support: Nora Notifier" with the subject as its body; several at once from one account read "Support: 3 new messages"; arrivals in two accounts at once raise one notification each.

## Development and test fixtures

- `deploy/stalwart/accounts.ndjson` and `seed.sh` gain a `support` group with Alice and Bob as members, and the seed delivers three messages to `support@example.test`. Membership is applied with an update that does not touch credentials, so open sessions survive.
- Alice's own account then has a `support@` identity it did not have before. Existing tests that count Alice's identities are updated.
- `FakeJmap` learns to hold more than one account.

## Testing

- **Unit**: an engine bound to a non-primary account reads, changes and catches up only that account; a state change for one account does not disturb the other's engine; account spaces list, label and count correctly; the title and notification text for one, several and mixed accounts; snapshots are kept apart per account.
- **End to end** (`e2e/shared.spec.ts`): the switcher appears and lists Support with its unread count; a message delivered to `support@` raises the dot while in the personal mailbox, without a reload; switching shows it; a reply from Support arrives at Bob from `support@` and its copy is in Support's Sent, not Alice's; a reload on a `/shared/…` address stays in Support; a composer left open in one account is there on return; with a single-account user (Carol) no switcher is shown.
- The existing suite must pass unchanged apart from the identity counts.

## Not in this slice

- Folders another user shared one at a time (JMAP sharing with limited rights), and read-only accounts. They will appear in the switcher if Stalwart lists them in the session, but nothing here was tested against them.
- Group calendars and contacts.
- A combined inbox across accounts.
- Assigning conversations to a person, or showing who is replying.
- Noticing a new membership without a reload.
- Creating groups or managing members: that is done in Stalwart.

## Risks

- **The router's base path** has to cope with being changed by re-mounting. If it does not, the fallback is to keep the account in the tab's session storage and leave the URLs alone, at the cost of reloads and new tabs opening in the personal account.
- **Two people answering the same message.** Nothing prevents it. Both see the other's reply arrive in the thread by push, which is the same protection a shared Gmail inbox gives.
- **Start-up cost** grows by two small calls per account. With a handful of accounts this is not measurable; it is not designed for dozens.
