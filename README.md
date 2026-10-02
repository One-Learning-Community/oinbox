# oinbox

A Gmail-style webmail client for [Stalwart](https://stalw.art), speaking only JMAP (RFC 8620/8621).
Frontend only: a static SolidJS app served on the same origin as Stalwart.

- **Conversations**: server threads (`collapseThreads`, `Thread/get`) with every message, including Sent,
  oldest to newest. Read messages collapse; quoted text folds behind "•••".
- **Thread list**: one row per conversation, virtualized and paged from the server, kept live over push.
- **Search**: Gmail operators (`from: to: cc: bcc: subject: has:attachment is: in: label: before: after:
  older_than: newer_than: larger: smaller:`, `-`, `OR`, `{…}`, `(…)`) → JMAP filters, with highlighted snippets.
- **Compose**: inline reply / reply-all / forward, recipient suggestions from your mail history, identities, draft autosave, attachments, 10 s undo send.
- **Triage**: archive, delete, spam, read/unread, star, move, label; optimistic with rollback and Undo.
- **Keyboard**: Gmail defaults (`j k o u x e # ! s I U v l c r a f / g+i ?`).
- **Safety**: sanitized HTML in a script-less sandboxed iframe with its own CSP; remote images blocked
  until allowed per message or per sender.

## Run it

```sh
pnpm install
pnpm build                     # writes dist/, which Caddy serves
cd deploy && docker compose up -d && ./seed.sh
open http://localhost:8080     # alice@example.test / oinbox-dev-pass
```

See [deploy/README.md](deploy/README.md) for the stack (Stalwart + Meilisearch + Caddy) and credentials.

For development with hot reload, keep the stack running and use `pnpm dev` (http://localhost:5173).
Vite proxies JMAP and OAuth to `localhost:8080`; the seeded OAuth client also allows the
`http://localhost:5173/auth/callback` redirect.

## Test

```sh
pnpm test        # unit: JMAP client, sync engine (against an in-memory JMAP fake), search parser, sanitizer, quotes, compose
pnpm e2e         # Playwright against the Docker Compose stack
```

## Layout

| Path | What |
|---|---|
| `src/jmap/` | Typed JMAP client: batching with back-references, session, blobs, fetch-streamed push |
| `src/sync/` | Normalized cache + live query windows; `/changes` catch-up; optimistic mutations |
| `src/mail/` | Pure mail logic: search parser, sanitizer, quote folding, compose, participants |
| `src/cache/` | IndexedDB warm-start snapshot |
| `src/auth/` | OAuth 2 authorization code + PKCE (public client) |
| `src/ui/` | Solid components (rozie.js: Toast, CommandPalette, TipTap, Combobox, Dialog, FullCalendar, Popover) |
| `docs/` | Design spec and rozie.js dogfooding feedback |

## Stalwart notes

Found while building against Stalwart 0.16.23:

- `Email/queryChanges` with `collapseThreads: true` returns wrong results rather than
  `cannotCalculateChanges`, so collapsed lists re-read their visible window after changes
  (`MailEngine` option `collapsedQueryChanges` turns queryChanges back on).
- An unauthenticated `/jmap/session` returns 200 with no accounts; the client treats that as signed out.
- 401 responses carry `WWW-Authenticate: Basic`, which makes browsers hold `fetch()` open for a
  native prompt; Caddy strips the header.
- There's no Archive mailbox by default; archiving creates one on first use, since JMAP has no
  "All Mail" and an email must stay in at least one mailbox.
