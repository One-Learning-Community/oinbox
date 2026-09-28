# oinbox end-to-end tests

Playwright (Chromium) against the real dev stack in `deploy/` (Stalwart + Meilisearch + Caddy on http://localhost:8080).

## Run

```sh
# once: stack with Caddy serving this checkout's dist/ (not the dist baked into the image)
(cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d)
pnpm build    # the tests run against ./dist
pnpm e2e      # = playwright test
```

`e2e/global-setup.ts` does four things:

1. Checks that `dist/index.html` exists.
2. Brings the stack up with the local-dist override if it is down.
3. Fails fast if Caddy is serving a different `index.html`, for example a stale baked image.
4. Runs `deploy/seed.sh`, which is idempotent and doesn't touch existing accounts, so your own browser session stays signed in. It then deletes mail left behind by earlier aborted runs.

Environment variables:

| Variable | Effect |
|---|---|
| `E2E_RESET=1` | `docker compose down -v && up -d` before seeding: a pristine mailbox, about 2 minutes. |
| `E2E_SKIP_SEED=1` | Skip `seed.sh` for faster local iterations. |
| `E2E_BASE_URL`, `E2E_SMTP_PORT` | Override `http://localhost:8080` and `2525`. |
| `E2E_IMAP_HOST`, `E2E_IMAP_PORT` | Override `localhost` and `1993` (IMAPS) for `support/imap.ts`, which drives a real IMAP client (imapflow) to simulate another mail app (e.g. Thunderbird) mutating mail while oinbox is open. |

Specs share Alice's mailbox, so they run serially (`workers: 1`). Each spec arranges its own preconditions through JMAP (Basic auth) and SMTP in `support/mail.ts`: it marks threads read, puts mail back in the Inbox, or delivers messages with unique subjects and deletes them afterwards. The specs therefore don't depend on run order or on earlier runs.

**Gotcha:** Stalwart's `Email/query` subject filter (and `deliverToAlice`'s wait, which uses it) silently returns zero results for any search string containing a colon — e.g. searching for a literal `"Re: ..."` subject never matches, even though the same text without `"Re:"` matches fine, and even though the message is actually there. This looks like a Meilisearch query-syntax collision, not an oinbox bug. When a fixture needs a reply subject (`Re: ...`), deliver it with `sendMail` directly and wait on thread membership (`threadEmails`) instead of `deliverToAlice`/`emailsBySubject`. See `imap-sync.spec.ts`'s thread-delete test for the pattern.

The `setup` project signs Alice in once through the real OAuth flow and saves `e2e/.auth/alice.json` (gitignored), which the other specs reuse.

## Coverage

| Spec | What it checks |
|---|---|
| `login.spec.ts` | "Sign in" card → Stalwart `/login` (client_id `oinbox`, PKCE S256, redirect `/auth/callback`) → token exchange with refresh token → `/inbox` with the seeded threads. |
| `conversation.spec.ts` | The "Q3 planning offsite" thread shows all 5 messages, including Alice's Sent copy (shown as "me"), oldest → newest. The latest is expanded and the older read ones are collapsed; the "older messages" pill is expanded first. |
| `html-message.spec.ts` | Erin's HTML reply: `.images-banner` shown and no `img[src=http…]`. The quote is folded behind `button.oinbox-quote-toggle` inside the iframe and toggles open and closed. No request reaches `picsum.photos` or `tracker.design.test`. |
| `push.spec.ts` | SMTP delivery while the inbox is open → a new unread row appears live (about 50 ms), with no navigation or reload. |
| `search.spec.ts` | `from:bob` (deep link) returns only Bob's threads, including "Lunch Friday?". A free-text search for "zeppelin" from the search box hits the Q3 thread with `<mark>` highlights. |
| `keyboard.spec.ts` | `j` then `e` prompts a confirm dialog before archiving the cursor thread; Cancel keeps it, confirming removes it (row disappears, server confirms). Also `o` opens a thread, `u` goes back, `?` opens the shortcuts dialog and Escape closes it. |
| `imap-sync.spec.ts` | A real IMAP client (simulating another mail app) mutates mail while oinbox is open: marking a message seen, moving it out of the inbox, and deleting one message of an open thread all update the UI live via push, with no reload. |

## Regression tests for fixed bugs

These three started as `test.fixme` and now pass:

1. **Pushed thread at the top of the inbox** (`push.spec.ts`). Stalwart sends `StateChange` up to ~100 ms before a new email sorts into place, so `MailEngine` re-reads the visible window once more 500 ms after a push (`settleDelayMs`).
2. **Operator searches typed into the search box** (`search.spec.ts`). The route param was encoded twice; `MailView` now decodes it before building the slug.
3. **Open message keeps its iframe across updates** (`html-message.spec.ts`). `Conversation` keys its `<For>` by email id, so starring or a pushed change no longer re-mounts the message.
