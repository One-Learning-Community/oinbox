# Changelog

All notable changes to oinbox are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0-beta.1

The first public release. Tested against Stalwart 0.16.23 with Meilisearch 1.54.

### What oinbox does

- Mail: threaded conversations, a live thread list, Gmail-style search operators, compose with reply, reply-all and forward, recipient suggestions, identities and signatures, attachments, draft autosave and undo send.
- Triage: archive, delete, spam, read and unread, star, move and label, with Undo; label management; Gmail's keyboard shortcuts.
- Settings: identities, signatures and the vacation responder.
- Calendar: month, week and day views; create, move, resize, rename and delete single events; invitations in mail with Accept, Maybe and Decline.
- Safety: sanitized message HTML in a script-less sandboxed frame under its own Content-Security-Policy; remote images blocked until allowed.

### Made ready for beta

- A fault in one part of the screen no longer blanks the whole app: each pane has its own fallback, and each message its own.
- A banner shows when the server can't be reached, and oinbox retries by itself. A push connection that has gone silent is noticed and reopened.
- A failed send reopens the message with its text and offers Retry, and cannot send twice. A failed save says so, offers Retry, and saves by itself when the connection returns.
- Being signed out no longer loses what you were writing: oinbox stays on the page and restores the draft after you sign in again.
- Works on Firefox and Safari as well as Chrome. In Safari, quoted text in a message can now be expanded.
- Keyboard: a new message takes focus; opening a thread moves focus into it and closing it returns to the row you opened; the list's cursor row has real focus.
- Phones: every control is at least 44px on touch screens; the search field takes the top bar while in use; a "New event" button creates an event without dragging.
- Accessibility: no serious axe findings on the mail and settings screens; a message's header is no longer a button around buttons; contrast fixes in the dark theme.
- The app's files are compressed (the main script is 265 kB on the wire, down from 870 kB), and "Loading…" shows while they download.
- A production template (`deploy/production/`) with automatic HTTPS, TLS on the mail ports and CORS off, and an operator guide (`docs/operating.md`).
- The version is shown at the bottom of Settings.
- The tab title shows the Inbox's unread count, and desktop notifications for new mail can be switched on in Settings. They need an open tab: there is no notification with the browser closed.
- Your own name and logo (`OINBOX_BRAND_NAME`, `OINBOX_BRAND_LOGO`) in the top bar, the sign-in card and the browser tab.
- The release image runs behind a load balancer as it is: plain HTTP, with the listen address (`OINBOX_LISTEN`) and Stalwart's address (`OINBOX_UPSTREAM`) set from the environment.

### Known limitations

See "Known limitations" in the [README](README.md#known-limitations) and the full audit in [docs/beta-audit.md](docs/beta-audit.md).
