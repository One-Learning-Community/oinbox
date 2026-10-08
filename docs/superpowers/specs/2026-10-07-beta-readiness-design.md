# oinbox beta readiness

This slice takes oinbox from "works for the person who built it" to "another Stalwart operator can install it and trust it".
It adds no mail or calendar features. It makes the app survive its own bugs and bad networks, checks it by keyboard, screen reader, phone and a 50,000-message mailbox, corrects the docs, and packages a release.

Success is a tagged `0.1.0-beta.1` that an operator can install from the README and the operator guide alone, with every known shortcoming written down.

## Who it is for

Other Stalwart operators (agreed 2026-10-07). The repo becomes public at the end of the slice. Production deployment is therefore a generic template with `example.com` placeholders, not an installation on one domain. Deploying to the author's own domain is a follow-up outside this spec and is the first real use of the template.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Audience | Other operators; generic production template. | Matches the MIT decision and the goal of giving people a reason to choose Stalwart. Keeps everything testable in CI. |
| Hardening method | Audit each area against a fixed checklist, write findings to `docs/beta-audit.md`, fix blockers and majors, list minors as known limitations. Each checklist has measurable exit criteria. | A "sweep" has no natural end; a checklist and a severity rule give it one. |
| Checkpoint | Work stops after the audits. The user reads the findings before any fix starts. | The fix list is unknown until then and may need re-scoping. |
| Phone | Mail and settings fully usable at 390×844; calendar readable, events opened and answered, create and edit by form. No touch drag. | Mail on a phone is what a user tries first. Touch drag is a project of its own. |
| Bad network | Honest status, no write queue. The composer never loses text. | A write queue is the first half of offline mode, which is a non-goal. |
| Large mailbox | About 50,000 Enron corpus messages imported into a third account, measured by a hand-run `@perf` spec. | Real mail has real threading and header oddities; a separate account leaves the normal suite alone. |
| Accessibility | WCAG 2.1 AA on the main flows: axe in CI plus a scripted VoiceOver and keyboard pass. | Axe alone finds about a third of real problems. |
| Topology | Same origin as Stalwart behind any reverse proxy. Each release ships an image and a plain tarball. A separate-origin CDN is untested and documented as such. | Operators already run a proxy; this avoids taking on CORS in the beta. |
| Browsers | Chromium, Firefox, WebKit on desktop; WebKit at phone size. | WebKit is what every iPhone runs. |
| Telemetry | None. Errors are shown to the user and logged to the console; nothing is sent anywhere. | A mail client must not phone home. |

## Severity rule

- **Blocker**: loses or corrupts user data, or stops one of the main flows for everyone on a supported browser.
- **Major**: a main flow fails or is unusable for some users (a screen-reader user, a phone user, a large mailbox) with no reasonable workaround.
- **Minor**: everything else.

Blockers and majors are fixed in this slice. Minors go to "Known limitations" in the README. If the audit finds more majors than fit, the checkpoint is where the user decides what moves out.

The **main flows** are: sign in, read a thread, reply, compose and send, triage (archive, delete, mark read), label, search, change a setting, open a calendar event, answer an invitation.

## Phases

1. **Known work**: error boundaries, connection status, composer safety, test matrix, version stamp, the fixture fix.
2. **Audits**: accessibility, phone, large mailbox, network. Output is `docs/beta-audit.md`. **Stop for review.**
3. **Fixes and release**: fix blockers and majors, then docs, production template and release packaging, so that the docs describe the final state.

---

## Phase 1: known work

### Error boundaries

Today any uncaught render error blanks the whole UI.

**`src/ui/PaneBoundary.tsx`** wraps Solid's `ErrorBoundary`. Its fallback shows "This part of oinbox hit a problem.", a **Try again** button (calls the boundary's `reset`), and a collapsed "Details" block with the error message, the version stamp and a Copy button. It has `role="alert"`. It also raises one error toast.

Panes wrapped, each on its own:

| Pane | Where | Note |
|---|---|---|
| Sidebar | `Shell.tsx` | A sidebar fault must not hide the mail. |
| Thread list | `MailView` | |
| Conversation | `MailView` | Each message body also gets its own boundary in `Conversation`, so one malformed message doesn't hide the rest of the thread. |
| Composer | `ComposeDock`, inline composer | Retry re-mounts the view; the composer's state lives in `src/app/composer.ts`, outside the view, so the draft survives. |
| Calendar | route level, around the lazy `CalendarView` | Also catches a failed chunk load. |
| Settings | route level | |
| Invite card | `Conversation` | Fallback is nothing at all, as slice 3 decided for lookup failures. |

**`src/ui/RootFallback.tsx`** is the last resort, at the top of `src/index.tsx`. It shows "oinbox hit a problem and needs to reload.", a **Reload** button and the same Details block. It uses plain elements and inline styles only: no app context, no rozie components, no stylesheet classes, because any of those may be what failed.

Solid's boundaries do not catch errors thrown in event handlers or rejected promises. `src/app/errors.ts` therefore listens for `error` and `unhandledrejection` on `window` and raises an error toast, "Something went wrong. If things look off, reload." It shows at most one such toast every 10 seconds and always logs the error with the version stamp. A failed dynamic import (a chunk missing after an upgrade) is recognised and gets its own message: "oinbox was updated. Reload to continue."

### Connection status

The plumbing exists: 401 refresh with one retry (`src/jmap/client.ts`, `src/auth/oauth.ts`), push reconnect with capped backoff and catch-up (`src/jmap/sse.ts`). What is missing is anything the user can see, and many failures end in `.catch(() => undefined)` in `src/sync/engine.ts`.

**`src/sync/connection.ts`** (pure, unit-tested) is a small store:

- State: `'ok' | 'retrying' | 'signed-out'`.
- `reportFailure(source, error)` and `reportSuccess(source)`, where `source` is `'request'` or `'push'`.
- A failure counts only if it is a transport failure: `fetch` rejecting, a timeout, or HTTP 502, 503 or 504. A JMAP method error or a 4xx is not a connection problem and is handled where it happens, as today.
- The state becomes `'retrying'` after two transport failures in a row or one that has lasted 3 seconds, so a single blip shows nothing. It returns to `'ok'` on the first success from any source.
- `'signed-out'` is set when a refresh fails for good.

Changes around it:

- `JmapClient` gives every API request a 30-second timeout (uploads and downloads have none) and reports each outcome to the store.
- The push connection reports connect and disconnect.
- Every swallowed catch in `engine.ts` is reviewed. Transport failures go to the store. Anything else is logged; none stay silent.
- While `'retrying'`, the engine retries its catch-up with the same capped backoff as push. The browser's `online` event triggers an immediate retry; `navigator.onLine` is never trusted as proof of a connection.

**Banner** (`src/ui/ConnectionBanner.tsx`, in the shell where the vacation banner sits): "Can't reach the server. Retrying…" with a **Retry now** button, `role="status"`. It disappears on recovery. When the state is `'signed-out'` it says "You've been signed out." with a **Sign in again** button.

Reading what is already loaded keeps working throughout. A triage write that fails rolls back with a toast, as it does today.

### The composer never loses text

- A failed send keeps the composer open with its content and shows "Couldn't send. Your message is still here." with **Retry**.
- A failed draft save shows the existing `error` save status with **Retry**, and retries by itself when the connection returns.
- Closing a composer whose last save failed asks for confirmation.
- On `'signed-out'`, each open composer with unsaved changes is written to `localStorage` under `oinbox.rescue.<accountId>.<composerId>`. After the same account signs in again, those composers reopen and the entries are removed. Entries older than 7 days are removed. An explicit Sign out removes them at once, so no draft text outlives a deliberate sign-out.

### Test matrix

- **Projects** in `playwright.config.ts`: `chromium` (as now), `firefox`, `webkit`, and `phone` (WebKit, 390×844, touch). Desktop projects run the whole suite. `phone` runs the tests tagged `@phone` (see the phone audit).
- A test that cannot pass on an engine is skipped for that engine with a comment that says why. Skips are listed in the audit file.
- **CI** runs the four projects as a matrix, each job with its own stack, so they run side by side.
- **Axe**: `@axe-core/playwright` (dev dependency) and `e2e/a11y.spec.ts`. See the accessibility audit.

### Version stamp

`package.json` version becomes `0.1.0-beta.1`. `vite.config.ts` defines `__APP_VERSION__` and `__APP_COMMIT__` (from `OINBOX_COMMIT`, else `git rev-parse --short HEAD`, else `unknown`; the Dockerfile takes it as a build argument). Settings shows "oinbox 0.1.0-beta.1 (2031ab9)" at the bottom, and error details include it.

### The fixture fix

`e2e/calendar-edit.spec.ts`, "a recurring event and an invited event are read-only": the invited fixture starts at 17:00 today, which is in the past after 17:00 New York, and Stalwart sends no invitation for a past event. The fixture moves to 10:00 tomorrow, and the test navigates to that day's week when tomorrow falls outside the current one. A `futureStart(zone)` helper in `e2e/support/calendar.ts` holds the rule, and `e2e/calendar-invite.spec.ts` uses it too if it has the same assumption.

---

## Phase 2: audits

Each audit appends to `docs/beta-audit.md`: what was checked, how, and a table of findings with severity, steps and the fix or the reason it is deferred. Findings about rozie components also go in `docs/rozie-feedback.md`. If a rozie defect blocks a main flow, work stops and the user is told; it is not worked around.

### Accessibility

**Automated.** `e2e/a11y.spec.ts` runs axe with the WCAG 2.1 A and AA rule tags on: sign-in, thread list, conversation, composer (new and inline reply), search results, settings, calendar week, event form, a confirm dialog, the label dialog, the shortcuts dialog. Each runs in light and dark. The message iframe is included.
Exit: no `serious` or `critical` violations. The spec then stays in CI.

**Manual, keyboard only** and **manual, VoiceOver with Safari**, over the same eight flows: sign in; read a thread; reply; triage; label; search; change a setting; answer an invitation. For each step the script records whether the control can be reached, what is announced, and where focus goes afterwards.
Checked in particular:

- Focus goes somewhere sensible after every dialog, route change, archive and delete.
- Toasts, new mail, the connection banner and save status are announced through live regions, politely, and not twice.
- Every control has an accessible name; icon buttons especially.
- Focus is always visible, in both themes.
- The thread list's virtualisation exposes correct row counts and positions.
- Text and controls meet contrast in both themes, and the app respects `prefers-reduced-motion`.

Exit: all eight flows can be completed by keyboard alone and by VoiceOver alone.
Out of scope: NVDA and JAWS; moving or resizing calendar events by keyboard (the form covers create and edit).

### Phone width

At 390×844 in WebKit with touch, and once by hand at 360×640:

- Mail: open the drawer, switch mailbox, read a thread, reply inline, compose with the on-screen keyboard open, attach a file, archive, delete, label, search, undo from a toast.
- Settings: edit the signature, add and remove an identity, turn vacation on and off.
- Calendar: opens in day view below 800px; move between days; open an event; answer an invitation from mail; create and edit by form.

Checked in particular: no horizontal scroll on any screen; every target at least 44px; nothing hidden behind the keyboard or the composer; dialogs and popovers fit the screen; safe-area insets respected; no hover-only control.

Exit: every item above can be done by touch. The tests that cover them are tagged `@phone` and run in the `phone` project.

### Large mailbox

**`deploy/seed/seed_bulk.py`** imports messages into `carol@example.test` (added to `accounts.ndjson`) with `Email/import`, in batches, skipping Message-IDs already present.

- `--source <dir>`: an extracted copy of the CMU Enron corpus. The script does not download it; `deploy/README.md` says where to get it. It is kept outside the repo.
- `--count N` (default 50000) and `--spread-days N` (default 730) to re-date messages across two years, so date searches and paging have something to work on.
- Mailboxes in the corpus map to an Inbox, Sent and about 20 labels; at least one thread has 50 or more messages.

**`e2e/perf.spec.ts`**, tagged `@perf`, run with `pnpm e2e:perf`, never in CI. It signs in as carol and records, on the developer's machine against the local stack:

| Measure | Threshold |
|---|---|
| Cold start to first thread rows | 3 s |
| Warm start (IndexedDB snapshot) to first rows | 1 s |
| Scroll from top to row 5,000: longest time a visible row stays blank | 500 ms |
| Same scroll: 95th percentile frame time | 32 ms |
| Free-text search to first results | 2 s |
| Open a 50-message thread to the last message rendered | 1.5 s |
| JS heap after 10 minutes open with a push every 10 s, against heap at 1 minute | +20% |
| IndexedDB snapshot size | 20 MB |

The numbers are a first guess at "feels fine". A miss is a finding, rated by the severity rule, not an automatic blocker; the audit records the measured values next to the thresholds.

The same run also checks by eye and by log: no sanitizer errors, no message that renders blank, no thread that Stalwart and oinbox disagree about. Real mail may show rendering faults; those are findings in the same file.

### Network

`e2e/network.spec.ts` (stays in CI) and one manual pass:

| Condition | How | Expected |
|---|---|---|
| Offline while reading | `context.setOffline(true)` | Banner within 5 s; loaded threads still open; banner clears and the list catches up after reconnect. |
| Offline during a triage action | as above | Row returns, toast says it failed. |
| Offline during send | as above | Composer stays with its text and Retry; Retry sends once after reconnect, and only once. |
| Offline during draft autosave | as above | Save status shows the error; saves by itself after reconnect. |
| 503 from `/jmap/` for 10 s | `page.route` | Same as offline; no error toast storm. |
| A request that never answers | `page.route` that never fulfils | Times out at 30 s, then as above. |
| Refresh token rejected | clear the token server-side or route `/auth/token` to 400 | "You've been signed out."; an open draft comes back after signing in. |
| Stalwart restarted mid-session | `docker compose restart stalwart` (manual, and in CI if it proves stable) | Banner, then recovery without a reload; push resumes; no duplicate rows. |
| Slow 3G | Chromium throttling, manual | Usable; spinners or skeletons, no blank panes. |
| Upload interrupted | offline during an attachment upload | The attachment shows a failure with Retry; the rest of the draft is intact. |

Exit: every row behaves as described, and no condition loses composer text.

### Checkpoint

When the four audits are written, work stops. The user reads `docs/beta-audit.md` and confirms or changes the fix list.

---

## Phase 3: fixes and release

### Fixes

Blockers and majors from the audit, each with a test that fails first (unit where the fault is in logic, e2e where it is in the page). Minors are copied to "Known limitations".

### README

Rewritten to match the product:

- Remove calendar from the non-goals. Add calendar (views, single-event editing, invitations), settings (signature, identities, vacation) and labels to the feature list.
- State the non-goals for v1: contacts, a filter UI, multiple accounts, offline mode, PGP, editing recurring events.
- "Install" points to the operator guide; "Develop" keeps the current quick start.
- Supported browsers, the accessibility statement (what was tested, what was not), and **Known limitations**.
- Update the layout table and the test counts.

### Operator guide: `docs/operating.md`

1. **What you need**: Stalwart 0.16.23 or later in the 0.16 line (the version tested), with JMAP, OAuth and a full-text store. Meilisearch is what oinbox is tested with; the guide says what search needs and what happens without it.
2. **Topology**: oinbox must be served on Stalwart's origin. What the proxy must do: send the listed paths to Stalwart except `/auth/callback`; fall back to `index.html`; stream the push connection unbuffered with no read timeout; strip `WWW-Authenticate` from Stalwart's responses; send the CSP and the other security headers. Full examples for Caddy and nginx.
3. **Stalwart settings**: register the `oinbox` OAuth client (public, PKCE S256, redirect `https://<domain>/auth/callback`), keep `requireClientRegistration` on, leave permissive CORS off, set the public URL. Given as `stalwart-cli apply` input and described in words for the WebUI.
4. **Install**: with the image (Compose), or with the tarball behind an existing proxy.
5. **First sign-in** and how to tell it worked.
6. **Upgrade**: replace the image or the files; hashed assets are cached for a year and `index.html` is not, so users get the new version on the next load; a tab left open sees "oinbox was updated. Reload to continue."
7. **Backup**: oinbox stores nothing on the server. Everything is in Stalwart; the guide links Stalwart's backup docs. What lives in the browser (tokens, a cache, preferences) and how to clear it.
8. **What signs users out** (from `deploy/README.md`), and **troubleshooting**: the native login prompt, a blank page after upgrade, push not arriving, search results lagging behind delivery.
9. **Unsupported**: a separate-origin or CDN deployment, with what it would take.

### Production template: `deploy/production/`

- `docker-compose.yml`: Stalwart, Meilisearch and the oinbox image at a pinned tag, with named volumes and no dev ports.
- `Caddyfile`: the site address from `{$OINBOX_DOMAIN}`, automatic HTTPS, HSTS, the same routing and headers as the dev file, no `auto_https off`, logging without request bodies.
- `plan.ndjson`: placeholders for the mail domain and public origin, the OAuth client with the HTTPS redirect only, Meilisearch, permissive CORS off, the spam filter and SMTP checks left at Stalwart's defaults. No accounts and no passwords. `apply.sh` fills the placeholders in from `.env` and applies it; `certificate.ndjson` points Stalwart at the certificate.
- `.env.example`: `OINBOX_DOMAIN`, `MAIL_DOMAIN`, the ACME contact, the image tag, the Meilisearch key, the Stalwart recovery admin.
- The dev `deploy/Caddyfile` and the production one share their routing through an imported snippet, so the two cannot drift.

**Tested in CI**: a job starts the template with an override that sets the domain to `localhost` and Caddy's `tls internal`, applies the plan, creates one user, and runs `login.spec.ts` and one compose test over HTTPS with certificate errors ignored. It also asserts that a cross-origin request to `/jmap/session` gets no `Access-Control-Allow-Origin` header and that the page sends HSTS and the CSP.

**Probed before writing** (results below, under "Probed on Stalwart 0.16.23"):

- How Stalwart gets certificates for SMTP and IMAP when Caddy owns ports 80 and 443. The template must not leave mail ports without TLS; the guide documents whichever arrangement the probe shows to work.
- Whether Stalwart 0.16 can restrict CORS to one origin. Only for the "Unsupported" section.
- Whether Stalwart sets its own security headers on the paths it serves (`/login`), and whether the proxy should add any.

### Probed on Stalwart 0.16.23 (2026-10-08, local stack)

- **Certificates for the mail ports.** Stalwart has its own ACME client (`AcmeProvider`; challenges TLS-ALPN-01, HTTP-01, DNS-01, DNS-PERSIST-01), which would compete with Caddy for ports 80 and 443 unless DNS is used. It also has a `Certificate` object whose `certificate` and `privateKey` can be `{"@type":"File","filePath":…}` (also `EnvironmentVariable` and `Text`), and an `Action/ReloadTlsCertificates`. Chosen: Caddy obtains the one certificate; a `cert-sync` service copies it to a volume Stalwart can read (Caddy keeps its files readable by root only, and Stalwart runs as uid 2000); Stalwart's `Certificate` points at the copy. Verified with Caddy's local CA: IMAP on 993, submission on 465 and STARTTLS on 25 all present that certificate (`e2e/production.spec.ts`). A renewed certificate needs `./apply.sh --reload-tls`.
- **CORS.** `Http` has only `usePermissiveCors` (all origins or none). A separate-origin deployment would mean `Access-Control-Allow-Origin: *` on the mail server.
- **Headers on Stalwart's pages.** `/login` and `/admin/` come with no security headers. The shared proxy routing now adds `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` to everything proxied to Stalwart; `Http.enableHsts` and `Http.responseHeaders` exist but the proxy already covers them.
- **Limits that surprise.** 1,000 requests a minute per account (`Http.rateLimitAuthenticated`); 500 ids per `/get`; 1,000 uploads and 50 MB of uploads per account per hour (`Jmap.maxUploadCount`, `Jmap.uploadQuota`), which bounds attachments. `SystemSettings.defaultHostname` must be a real host name (`localhost` is refused).
- **Sorted queries.** Any `Email/query` with a `sort` took about 1.4 s on an account with 50,000 messages, against 10 ms unsorted (`docs/beta-audit.md`, L2).

### Release packaging

- `.github/workflows/release.yml`, on a `v*` tag: runs the checks, builds the image for `linux/amd64` and `linux/arm64`, pushes `ghcr.io/one-learning-community/oinbox:<version>`, builds `oinbox-<version>.tar.gz` from `dist/` with a `SHA256SUMS` file, and opens a **draft** GitHub release with both attached and the changelog entry as its text. The user publishes it.
- `CHANGELOG.md`, starting at `0.1.0-beta.1`.
- `SECURITY.md`: how to report a vulnerability privately (GitHub's private reporting), what is in scope, and a summary of the HTML sanitising and CSP design.
- `CONTRIBUTING.md`: how to run the stack and the tests, the rule that e2e helpers do not wait on subject searches, and that rozie findings go in `docs/rozie-feedback.md`.
- `package.json` loses `"private": true` only if that is needed for the release tooling; the package is not published to npm.

### Release checklist (the user's actions)

1. Push `main` (the MIT commit `2031ab9` is not on `origin` yet).
2. Read the final audit and the known limitations.
3. Make the repository public and turn on private vulnerability reporting.
4. Tag `v0.1.0-beta.1`; check the draft release; publish it and make the package public.

None of these is done by the implementer.

---

## Testing

| Layer | What |
|---|---|
| Unit | `connection.ts` (thresholds, recovery, what counts as transport failure); `PaneBoundary` and `RootFallback` (a throwing child, retry, details); the window error handler's rate limit; the client timeout; composer rescue (write, restore, expiry, removal on sign-out); the version stamp. |
| e2e, every push | `network.spec.ts`; `a11y.spec.ts`; a boundary test that makes one pane throw (a test-only hook behind `import.meta.env.MODE === 'test'` or a routed response that triggers a render fault) and checks that the rest of the app works; the `@phone` set; the production template job. |
| e2e, by hand | `perf.spec.ts`; the Stalwart restart; slow 3G; the VoiceOver script. |
| Existing suite | Passes on Chromium, Firefox and WebKit, with any skip explained. |

e2e helpers in this slice do not wait on subject searches (Stalwart's full-text index lags behind delivery); they wait on ids or thread membership, as `recentWithSubject` in `e2e/calendar-invite.spec.ts` does.

## Files

New: `src/ui/PaneBoundary.tsx`, `src/ui/RootFallback.tsx`, `src/ui/ConnectionBanner.tsx`, `src/app/errors.ts`, `src/sync/connection.ts`, `src/app/rescue.ts` (with tests); `e2e/a11y.spec.ts`, `e2e/network.spec.ts`, `e2e/perf.spec.ts`; `deploy/seed/seed_bulk.py`; `deploy/production/*`; `docs/operating.md`, `docs/beta-audit.md`; `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`; `.github/workflows/release.yml`.

Changed: `src/index.tsx`, `src/ui/Shell.tsx`, `src/ui/Conversation.tsx`, `src/ui/ComposerView.tsx`, `src/ui/SettingsView.tsx`, `src/ui/CalendarView.tsx` (day view on phones), `src/ui/styles.css`, `src/jmap/client.ts`, `src/jmap/sse.ts`, `src/sync/engine.ts`, `src/app/composer.ts`, `src/app/context.tsx`, `src/auth/oauth.ts`; `vite.config.ts`, `package.json`, `Dockerfile`, `playwright.config.ts`, `.github/workflows/ci.yml`; `e2e/calendar-edit.spec.ts`, `e2e/support/calendar.ts`, `e2e/README.md`; `deploy/Caddyfile`, `deploy/README.md`, `deploy/stalwart/accounts.ndjson`; `README.md`; `docs/rozie-feedback.md` as findings arise.

## Not in this slice

- An installable-app manifest and icons. It invites offline expectations this slice rules out; it is the natural next small slice.
- Calendar slice 4: editing recurring events, per-occurrence answers, free/busy.
- The deferred minors from the recipient-autocomplete review, except any the audits find again.
- A write queue or any offline mode.
- A supported separate-origin deployment.
- Deploying to the author's own domain.
- Contacts, a filter UI, multiple accounts, PGP, translations.
