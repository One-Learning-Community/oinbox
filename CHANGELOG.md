# Changelog

All notable changes to oinbox are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Drive: a link to OpenCloud in the sidebar, under Contacts, for operators who name its public address in `OINBOX_DRIVE_URL` (docs/operating.md, "Drive"). It opens OpenCloud's own web UI in a new tab, where the user signs in again.

## 0.1.0-beta.4

Tested against Stalwart 0.16.23 with OpenSearch 2.19.6, and OpenCloud 7.2.4 for Drive.

### Added

- Contacts: an address book of your own, kept in Stalwart where your phone and other clients see the same cards. Open it from the sidebar (or `g` then `p`), search by name, organisation, address or phone number, and add, edit and delete people; a delete can be undone. A card holds names, a photo, several email addresses and phone numbers, organisation and job title, postal addresses, a birthday and notes. What another client stored that oinbox does not edit (nicknames, links, keywords) is shown and left alone.
- Contact groups: make a group from the sidebar of the Contacts page, tick people in the list (or everyone shown) and add them, or add and remove someone from their card. A group's page lists its people; renaming and deleting are in its "⋯" menu, and deleting a group keeps its people. With people ticked you can also export them or delete them together.
- A group is offered by name when you address a message, marked "List" with its size. Picking it adds one recipient per member, by their preferred address, so everyone who will get the message is in view; people already on the message are not added twice, and you are told how many members have no address.
- Import contacts from vCard files (2.1, 3.0 and 4.0, as Google, Apple and Outlook write them), groups included. You see what the files hold before anything is sent; people already in your contacts are skipped unless you say otherwise. Stalwart reads each card as an uploaded file and counts it against the same hourly allowance as attachments (1,000 an hour by default): the dialog says so, warns before a larger import, and if the limit is reached tells you how many are left and when to come back. Choosing the same files again imports only what is missing. A photo too large for the server is left out and the result says so.
- Export all contacts, one group, or the people you ticked as one vCard 4.0 file.
- A card changed on another device, or by a phone over CardDAV, changes on screen without a reload.
- Add someone to your contacts from a message or from a recipient chip: click their address, or their name among a message's recipients, for a small card of who they are and what you can do. On a chip the name is the one stop for the Tab key: Enter opens the card, Delete or Backspace removes the recipient.
- Saved contacts are offered when you address a message, under the names you saved them with, and are found by organisation and nickname too. People you have written to still come first; then your contacts, then the organisation, then everyone else. Typing without accents finds names with them.
- Recipient suggestions include everyone in the organisation: the people and groups Stalwart lists, under the names their administrator gave them, whether or not you have written to them before. Groups are marked. Your own address is offered too, for a note to yourself. People you have written to still come first. The list is fetched once an hour at most and kept for the next start; mailing lists and aliases are not in it, because Stalwart does not list them.
- Picture attachments (JPEG, PNG, GIF, WebP, AVIF) show as thumbnails in the message, and open in a full-screen viewer that steps through the message's pictures with the arrow keys. A picture over 5 MB is fetched only when you open it. SVG and formats a browser cannot draw are shown as files.
- Every attachment in a message is a tile of one size: a picture shows itself, any other file shows its kind (PDF, DOCX) and downloads on a click.

### Changed

- OpenSearch 2.19 is now the search store oinbox is developed and tested with, in place of Meilisearch: the development stack and the production template (`deploy/production`) both run it, through Stalwart's ElasticSearch store type. Search then matches word forms ("redesigning" finds "redesign") and no longer the beginnings of words. Meilisearch still works, and a server that keeps it needs to change nothing. To move a server over, see docs/operating.md, "Moving an existing server from Meilisearch to OpenSearch"; `MEILI_MASTER_KEY` is no longer read by the template.

### Fixed

- The production template's `apply.sh` restarts Stalwart when it sets or changes the search store, and has what is already stored indexed. Before, a newly installed server did not use its search store until Stalwart was next restarted.
- Someone who shares only an address book or a calendar with you is no longer offered as a shared mailbox that then fails to open.

## 0.1.0-beta.3

Tested against Stalwart 0.16.23 with Meilisearch 1.54, and OpenCloud 7.2.4 and 8.1.0 for Drive.

### Added

- Drive: where an OpenCloud runs beside Stalwart, an attachment can be saved into one of its folders from the message; files can be attached from it when writing; and files too large for mail are uploaded to it and sent as one link, with a password (typed or generated, in the message or passed on another way) and an expiry. No second sign-in. Operators turn it on with `OINBOX_DRIVE_UPSTREAM` (docs/operating.md, "Drive"). Tested against OpenCloud 7.2.4 and 8.1.0.

## 0.1.0-beta.2

Tested against Stalwart 0.16.23 with Meilisearch 1.54.

### Added

- Images in the text of a message: paste one, drop it on the text, or use the toolbar's Insert image. It is sent as a real inline part, so other mail clients show it in place.
- A reply or a forward keeps the inline images of the message it quotes, and a forward carries the original's attachments.
- Change your password in Settings. It asks for the current one, and signs you out everywhere, this browser included. A forgotten password is still reset by an administrator.

### Fixed

- A draft with attachments that was reopened from Drafts could no longer be saved after its first save, and the failed save removed it from the server. Saving now creates the new version before it removes the old one.

### Changed

- The image passes Stalwart the client's address, taken from `X-Forwarded-For` when the request comes from a trusted proxy (`OINBOX_TRUSTED_PROXIES`, by default private addresses). Before, behind a load balancer, Stalwart saw the load balancer's address for everyone. Stalwart needs `Http.useXForwarded` on to read it.
- Toasts are announced by screen readers through standing live regions, errors at once and the rest politely.
- On a phone, an event's details card stays on the screen.
- The calendar's event card and form pass the automated accessibility check they failed (`aria-modal`).

### Known limits

- An image dropped on the text together with a file of another kind is attached with it, not put into the text.
- Images cannot be resized, and are uploaded at their original size. Stalwart's default allows an account 50 MB of uploads an hour.

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
- Shared mailboxes: a Stalwart group the user belongs to opens from a switcher above Compose, with its own inbox, search, labels and drafts; replies are sent as the group and filed in its Sent. The switcher, the tab title and notifications show unread mail in every mailbox.
- The tab title shows the Inbox's unread count, and desktop notifications for new mail can be switched on in Settings. They need an open tab: there is no notification with the browser closed.
- Your own name and logo (`OINBOX_BRAND_NAME`, `OINBOX_BRAND_LOGO`) in the top bar, the sign-in card and the browser tab.
- The release image runs behind a load balancer as it is: plain HTTP, with the listen address (`OINBOX_LISTEN`) and Stalwart's address (`OINBOX_UPSTREAM`) set from the environment.

### Known limitations

See "Known limitations" in the [README](README.md#known-limitations) and the full audit in [docs/beta-audit.md](docs/beta-audit.md).
