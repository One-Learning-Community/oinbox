# oinbox

A Gmail-style webmail client for [Stalwart](https://stalw.art), speaking only JMAP.
It is a static SolidJS app served on the same origin as Stalwart: no server of its own, no database, no telemetry.
oinbox is free software (MIT). The aim is a solid everyday client that makes running your own Stalwart a real alternative to a commercial mail service.

**Status: beta (`0.1.0-beta.1`).** Tested against Stalwart 0.16.23 with Meilisearch.

## What it does

- **Conversations**: server threads with every message, including your own replies, oldest to newest. Read messages collapse; quoted text folds behind "•••".
- **Thread list**: one row per conversation, virtualized and paged from the server, kept live over push.
- **Search**: Gmail operators (`from: to: cc: bcc: subject: has:attachment is: in: label: before: after: older_than: newer_than: larger: smaller:`, `-`, `OR`, `{…}`, `(…)`) with highlighted snippets.
- **Compose**: inline reply, reply-all and forward; recipient suggestions from your mail history; identities and signatures; draft autosave; attachments; 10-second undo send.
- **Triage**: archive, delete, spam, read/unread, star, move, label; optimistic, with rollback and Undo.
- **Labels**: create, rename, nest and delete; label from the list or an open thread.
- **Keyboard**: Gmail's shortcuts (`j k o u x e # ! s I U v l c r a f / g+i ?`).
- **Settings**: identities and signatures, vacation responder, notifications.
- **Shared mailboxes**: a Stalwart group you belong to (`support@`, say) appears in a switcher above Compose. Work its inbox and send from it; unread counts for every mailbox are always in view.
- **Notifications**: the unread count in the tab title, and desktop notifications for new Inbox mail while oinbox is open in a tab you're not looking at (switched on in Settings).
- **Branding**: your own name and logo in place of "oinbox", set by the operator.
- **Calendar**: month, week and day views of your Stalwart calendars; create, move, resize, rename and delete single events; invitations shown in the message with Accept, Maybe and Decline, and updates and cancellations followed.
- **Safety**: message HTML is sanitized and shown in a sandboxed frame that runs no scripts, under its own Content-Security-Policy; remote images are blocked until you allow them, per message or per sender.
- **When things go wrong**: a banner when the server can't be reached, with automatic retry; a failed send or save keeps your text and offers Retry; a fault in one part of the screen is contained there; being signed out keeps the draft you were writing.

### Not in v1

Contacts and an address book, a filter (Sieve) editor, accounts on more than one server, a combined inbox across mailboxes, offline use, PGP and S/MIME, editing recurring events or answering one occurrence of a series, free/busy, an installable app, and translations.

## Install

See **[docs/operating.md](docs/operating.md)**: what oinbox needs from Stalwart and from the proxy in front of it, a Docker Compose template with automatic HTTPS (`deploy/production/`), installing behind an existing nginx or Caddy, upgrading, and troubleshooting.

Each release is published as a container image (`ghcr.io/one-learning-community/oinbox:<version>`, Caddy plus the app) and as a tarball of the static files.

## Browsers and accessibility

The whole end-to-end suite runs on Chromium, Firefox and WebKit, and a phone suite on WebKit at 390×844.

Accessibility was checked against WCAG 2.1 AA with axe on every main screen in both themes, and by a keyboard-only pass over the main flows; the results are in [docs/beta-audit.md](docs/beta-audit.md). A screen-reader pass with VoiceOver is scripted (`docs/a11y-script.md`) and still to be done; NVDA and JAWS have not been tried.

## Known limitations

From the beta audit ([docs/beta-audit.md](docs/beta-audit.md) has the detail and the finding numbers):

- **Large mailboxes are slow to page.** With 50,000 messages, each page of a list, and each search, takes one to three seconds: Stalwart needs about 1.4 s for every sorted query at that size (L2).
- **Safari: keyboard shortcuts stop working after you click inside a message** until you click outside it again (E5).
- **Events cannot be moved or resized from the keyboard.** They can be created with "New event" and renamed, re-filed and deleted from their card (A9).
- An event's card can cover a neighbouring event in Firefox and Safari until it is closed (E2). In Safari the label name is not pre-selected in the Rename dialog (E3). Closing the label picker with Escape leaves focus on the page (A10). In a long thread on a phone, Send can be below the fold while you type a reply (P1). At 360px the calendar toolbar wraps unevenly and message dates wrap onto three lines (P5, P6).
- Attachments are bounded by Stalwart's upload quota: 50 MB per account per hour by default.

## Develop

```sh
pnpm install
pnpm build                     # writes dist/, which Caddy serves
cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d && ./seed.sh
open http://localhost:8080     # alice@example.test / oinbox-dev-pass
```

[deploy/README.md](deploy/README.md) describes the development stack (Stalwart, Meilisearch and Caddy on plain HTTP) and its accounts.
For hot reload, keep the stack running and use `pnpm dev` (http://localhost:5173); Vite proxies JMAP and OAuth to `localhost:8080`.

### Test

```sh
pnpm test             # unit tests: JMAP client, sync engine against an in-memory JMAP fake, search parser, sanitizer, compose, calendar
pnpm e2e              # Playwright on Chromium against the Compose stack
pnpm e2e:all          # Chromium, Firefox, WebKit and the phone project, as CI runs them
pnpm e2e:perf         # hand-run measurements against a 50,000-message mailbox (deploy/README.md)
pnpm e2e:production   # the production template, once it is running with its test override
```

GitHub Actions runs the unit tests, the build, the four browser projects (each against its own fresh stack) and the production template on every push. See [e2e/README.md](e2e/README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

### Layout

| Path | What |
|---|---|
| `src/jmap/` | Typed JMAP client: batching with back-references, session, blobs, fetch-streamed push |
| `src/sync/` | Normalized cache and live query windows; `/changes` catch-up; optimistic mutations; connection status |
| `src/mail/` | Pure mail logic: search parser, sanitizer, quote folding, compose, participants |
| `src/calendar/` | Calendar store, recurrence expansion, invitations |
| `src/app/` | Actions, composers, labels, settings, error reporting, draft rescue |
| `src/cache/` | IndexedDB warm-start snapshot |
| `src/auth/` | OAuth 2 authorization code with PKCE (public client) |
| `src/ui/` | Solid components, built on [rozie.js](docs/rozie-feedback.md) (Toast, CommandPalette, TipTap, Combobox, Dialog, FullCalendar, Popover, DatePicker, Switch) |
| `e2e/` | Playwright specs and their helpers |
| `deploy/` | Development stack; `deploy/production/` the production template; `deploy/examples/` an nginx configuration |
| `docs/` | Operator guide, beta audit, design specs and plans, rozie.js feedback |

## Stalwart notes

Found while building against Stalwart 0.16.23 (more in the operator guide, under "Limits worth knowing"):

- `Email/queryChanges` with `collapseThreads: true` returns wrong results rather than
  `cannotCalculateChanges`, so collapsed lists re-read their visible window after changes
  (`MailEngine` option `collapsedQueryChanges` turns queryChanges back on).
- An unauthenticated `/jmap/session` returns 200 with no accounts; the client treats that as signed out.
- 401 responses carry `WWW-Authenticate: Basic`, which makes browsers hold `fetch()` open for a
  native prompt; Caddy strips the header.
- The default inbound SMTP throttles (25 messages an hour per sender and recipient) are restored at
  startup whenever none exist, so deleting them lasts only until the next restart. The dev stack
  keeps one disabled throttle instead (`deploy/stalwart/plan.ndjson`).
- There's no Archive mailbox by default; archiving creates one on first use, since JMAP has no
  "All Mail" and an email must stay in at least one mailbox.
- Any `Email/query` with a `sort` took about 1.4 s on an account with 50,000 messages, against 10 ms without one.
- Under Playwright's Firefox, `fetch()` for the push stream does not resolve until Stalwart's first ping, 30 s in; oinbox treats a request still open after 2 s as connected.

## License

MIT, see [LICENSE](LICENSE). oinbox talks to Stalwart only over JMAP and contains none of its code; Stalwart itself is licensed separately (AGPL-3.0 or the Stalwart Enterprise License).
