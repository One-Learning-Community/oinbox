# oinbox end-to-end tests

Playwright (Chromium, Firefox, WebKit, and WebKit at phone size) against the real dev stack in `deploy/` (Stalwart + Meilisearch + Caddy on http://localhost:8080).

## Run

```sh
# once: stack with Caddy serving this checkout's dist/ (not the dist baked into the image)
(cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d)
pnpm build    # the tests run against ./dist
pnpm e2e      # Chromium only: the quick run
pnpm e2e:all  # Chromium, Firefox, WebKit and the phone project, as CI runs them
pnpm e2e:perf # hand-run measurements against the 50k mailbox (see deploy/README.md); never in CI
```

## Projects and tags

| Project | Engine | Runs |
|---|---|---|
| `chromium`, `firefox`, `webkit` | desktop, 1280×900 | every spec, except tests tagged `@phone`, `@perf` or `@production` |
| `phone` | WebKit as an iPhone 14 (390×844, touch) | only tests tagged `@phone` |
| `perf` | Chromium | only tests tagged `@perf` |

Put the tag in the test title (`test('@phone the inbox fits the screen', …)`). A test that cannot pass on one engine is skipped for that engine with the reason in the `test.skip` call, and listed in `docs/beta-audit.md`.
`pnpm exec playwright install firefox webkit` fetches the other engines once.

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
| `push.spec.ts` | SMTP delivery while the inbox is open → a new unread row appears live (about 50 ms), with no navigation or reload. A reply delivered while its conversation is open appears as the newest message, expanded. |
| `compose.spec.ts` | The composer end to end, Alice → Bob: a new message arrives and is filed in Sent; an inline reply joins the open conversation and carries `In-Reply-To`; Undo in the last second of the 10 s window reopens the draft and nothing is delivered; Discard deletes the draft; a draft autosaves and reopens from Drafts after a reload; an attachment arrives intact; `c` opens the composer, shortcut keys typed into it stay text, Ctrl+Enter sends. Recipient suggestions: ranked from mail history, picked with Enter, ArrowDown or Tab, not offered twice, closed by Escape, learned from a message just sent; free text by comma, paste and blur; an address already in the field is not added twice. The field fills its row with chips and input on one line, and reports `aria-expanded` only while a list shows. |
| `search.spec.ts` | `from:bob` (deep link) returns only Bob's threads, including "Lunch Friday?". A free-text search for "zeppelin" from the search box hits the Q3 thread with `<mark>` highlights. |
| `keyboard.spec.ts` | `j` then `e` prompts a confirm dialog before archiving the cursor thread; Cancel keeps it, confirming removes it (row disappears, server confirms). Also `o` opens a thread, `u` goes back, `?` opens the shortcuts dialog and Escape closes it. |
| `imap-sync.spec.ts` | A real IMAP client (simulating another mail app) mutates mail while oinbox is open: marking a message seen, moving it out of the inbox, and deleting one message of an open thread all update the UI live via push, with no reload. |
| `labels.spec.ts` | Label management: "+" creates a label (a double submit creates one); a path creates its parent; duplicates and empty segments are refused inline; rename keeps the URL and can move a label under another parent; delete keeps the mail (shared mail loses the label, mail only there goes to Archive) and returns to the Inbox; a label with sub-labels can't be deleted; the "⋯" menu works from the keyboard (arrows, Home/End, Escape, Tab closes it), silences the app's shortcuts while open, and gets the focus back after the rename dialog or a cancelled delete; on a touch screen the label buttons are at least 44px; a label deleted by another client sends its view to the Inbox; the pickers' "Create" row creates and applies a label, and emphasizes the typed path rather than letters of "Create"; the chip "×" removes a label, with Undo. Labels it creates are named `e2e-…` and removed after each test. || `inline-images.spec.ts` | Images in the text of a message: one put between two paragraphs is sent as an inline part of `multipart/related` and arrives in place, with the caret kept; a pasted or dropped image goes into the text and one dropped elsewhere on the composer is attached; a draft with an image reopens with it, saves twice more and sends it; a reply keeps the original's inline image in its quote; a forward carries the inline image and the attachment. Messages it creates are named `Inline image test …` and removed after each test. |

## Regression tests for fixed bugs

The first three started as `test.fixme`; the rest were found by new specs. All pass now:

1. **Pushed thread at the top of the inbox** (`push.spec.ts`). Stalwart sends `StateChange` up to ~100 ms before a new email sorts into place, so `MailEngine` re-reads the visible window once more 500 ms after a push (`settleDelayMs`).
2. **Operator searches typed into the search box** (`search.spec.ts`). The route param was encoded twice; `MailView` now decodes it before building the slug.
3. **Open message keeps its iframe across updates** (`html-message.spec.ts`). `Conversation` keys its `<For>` by email id, so starring or a pushed change no longer re-mounts the message.
4. **A successful send was reported as failed** (`compose.spec.ts`). Stalwart answers `onSuccessUpdateEmail`'s implicit `Email/set` under the `EmailSubmission/set` call id, and `BatchResult` kept the last response per id. It now keeps the first.
5. **Messages joining an open conversation never appeared** (`push.spec.ts`, `compose.spec.ts`). Pushed emails sync without bodies and the conversation only shows emails with bodies; `Conversation` now loads the thread again when it gains an email.
6. **Undo disappeared 2 s before the send** (`compose.spec.ts`). The "Sending…" toast now stays for the whole undo window.
