# Beta audit

What was checked before `0.1.0-beta.1`, how, and what was found.
Severity: a **blocker** loses or corrupts data, or stops a main flow for everyone on a supported browser. A **major** makes a main flow fail or unusable for some users with no reasonable workaround. Everything else is a **minor**. Blockers and majors are fixed before the beta; minors are listed under "Known limitations" in the README.

## Summary

**Status on 2026-10-08, after the fixes.** No blocker was found. Twelve majors were found. Nine are fixed. Three remain: two are done on oinbox's side and wait on rozie component releases (A6 and P2, along with the minor A1), and one is a Stalwart cost oinbox cannot remove (L2). The table at the audit checkpoint, before the fixes, is kept below it for the record.

| Area | Exit criteria now | Majors found | Fixed | Open |
|---|---|---|---|---|
| Browser engines | Met: the suite passes on Firefox and WebKit | E1 | E1 | – |
| Accessibility | axe: met except A1 (rozie). Keyboard: met. VoiceOver: **not yet checked** | A3, A5, A6, A8 | A3, A5, A8; A6 on oinbox's side | A6 (rozie Toaster) |
| Phone width | Mail and settings met; calendar card pending rozie | P2, P3, P4, P7 | P3, P4, P7; P2 on oinbox's side | P2 (rozie Popover) |
| Large mailbox | Start-up, rendering, long thread, memory met; paging and search not | L2 | – | L2 (Stalwart) |
| Network | Met | N1, N2 | N1, N2 | – |

Minors: fixed A2, A4, A7, N3, N4. Left as known limitations (listed in the README): A1 (rozie), A9, A10, E2, E3, E5, P1, P5, P6.

### Waiting on rozie (to be fixed before this slice is finished)

`docs/rozie-feedback.md` has the detail. oinbox is written as though these are done.

| Component | Gap | Finding | What turns green |
|---|---|---|---|
| Toaster | Standing polite and assertive live regions; `alert` for error toasts; the `toastSlot` function leaking into a DOM attribute | A6 | A VoiceOver check: an archive toast and a "Couldn't send" toast are read out |
| Popover | The panel can leave the viewport on a narrow screen | P2 | `e2e/phone.spec.ts` "the calendar opens in day view and an event opens on tap" (an expected failure today) |
| Popover | `aria-modal="false"` on a panel with no dialog role | A1 | `e2e/a11y.spec.ts` "event card" and "event form", both themes (expected failures today; then delete the `KNOWN` map) |

### Still needs a person

1. **VoiceOver pass** (`docs/a11y-script.md`, about 30 minutes) to confirm A3, A5 and A8 by ear and to check A6 once rozie Toaster is updated.
2. **A real Firefox**: does the status dot turn green within a second of loading (E4)?
3. **A real phone**: the on-screen keyboard over the reply composer (P1).
4. **Stalwart**: raise L2 upstream, or check it on a non-Docker, non-Mac install.

### At the checkpoint (2026-10-07, before the fixes)

| Area | Exit criteria | Blockers | Majors | Minors |
|---|---|---|---|---|
| Browser engines | Suite passes on Firefox and WebKit, bar E1 | 0 | 1 (E1) | 2 |
| Accessibility | Not met: axe (A1–A4), keyboard (A5). VoiceOver pass not done | 0 | 4 (A3, A5, and A6, A8 to confirm) | 5 |
| Phone width | Mail and settings usable; calendar card (P2) and target sizes (P3) not met | 0 | 3 (P2, P3, P4) | 3 |
| Large mailbox | Not checked: needed the corpus | – | – | – |
| Network | Met | 0 | 2, both fixed (N1, N2) | 2 |

## Browser engines

**Checked:** the whole e2e suite (80 tests) on Playwright's Firefox 155 and WebKit 26.6, desktop 1280×900, 2026-10-07.
**How:** `pnpm exec playwright test --project=firefox` and `--project=webkit` against the Compose stack.
**Result:** Firefox 79 pass, 1 skipped. WebKit 78 pass, 2 expected failures (E1).

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| E1 | major | **Safari: quoted text in a message cannot be expanded.** The "•••" button inside the message does nothing. The message iframe is sandboxed without `allow-scripts`, and WebKit does not run event listeners on elements in such a frame, even when the parent page added them. | WebKit: open Erin's HTML reply in "Design review", press "•••". | **Fixed** (phase 3): the quote is folded in a `<details>` with a `<summary>` toggle, which needs no script; the frame's height already followed a `ResizeObserver` in the parent. The two WebKit tests pass again. The only other listener inside the frame is E5. |
| E5 | minor | Safari: after clicking into a message, keyboard shortcuts (`j`, `e`, `r`…) do nothing until the page outside the message is clicked. The frame forwards its key presses to the page with a listener, which WebKit does not run (same cause as E1). | WebKit: open a thread, click in the message text, press `u`. | Deferred: known limitation. A fix needs the frame not to take focus, which also affects text selection. |
| E2 | minor | In Firefox and WebKit the event details card can cover a neighbouring event, which then can't be clicked until the card is closed. Text metrics differ, so the card lands on the other side of the event. | Calendar week: click "Design review", then try to click "1:1 with Bob". | Deferred: Escape or a click elsewhere closes the card. `e2e/calendar.spec.ts` closes it first on those engines. |
| E3 | minor | Safari: the label name is not pre-selected in the Rename dialog; the caret sits at the end. | WebKit: label "⋯" › Rename. | Deferred: the name can still be edited. |
| E4 | note | Under Playwright's Firefox, `fetch()` for the push stream does not resolve until the first body chunk, which is Stalwart's first ping 30 s in. Pushes were delivered throughout, but the status dot stayed grey and catch-up after a reconnect waited for that ping. | Firefox: load the inbox and watch the status dot. | Fixed in this slice: a push request still open after 2 s counts as connected for the status dot and for catch-up (not for the connection banner). **To verify in a real Firefox**: this may be an artefact of Playwright's patched build. |

**Skipped or adjusted for an engine**

| Test | Engine | Why |
|---|---|---|
| `compose.spec.ts` "free text still works…" | Firefox | Skipped: Firefox drops `clipboardData` from a script-made `ClipboardEvent`, so a paste cannot be simulated. Pasting itself is not known to be broken. |
| `labels.spec.ts` "Tab closes the menu…" | WebKit | One assertion dropped: Safari's Tab skips links and buttons unless the user enables full keyboard access, so focus lands on the page after the menu closes. |
| `labels.spec.ts` "renaming the label being viewed…" | WebKit | The pre-selection assertion is dropped (E3). |
| `calendar.spec.ts` "clicking an event shows its details" | Firefox, WebKit | Closes the first card before clicking the second event (E2). |

## Accessibility

**Checked:** WCAG 2.1 A and AA on the main screens, in the light and the dark theme, Chromium, 2026-10-07.
**How:**
- `e2e/a11y.spec.ts`: axe-core on 12 screens × 2 themes, plus sign-in. Serious and critical violations fail the test. It runs in CI.
- A keyboard-only pass over the main flows, driven by a script that recorded the focused element and its focus indicator after every step.
- **Not yet done: the VoiceOver pass** in Safari (`docs/a11y-script.md`). It needs a person at the Mac. A6 and A8 below are predictions from the markup and must be confirmed there.

**Exit criteria at the audit:** no serious or critical axe violations — not met (A1–A4). All eight flows by keyboard alone — not met (A5). By VoiceOver alone — not checked.
**After the fixes:** axe is clean except A1 (two calendar screens, rozie Popover); the keyboard flows work; VoiceOver is still unchecked.

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| A5 | major | **A new message does not take focus.** After `c` or the Compose button, focus stays on the page. The composer is last in the tab order, so a keyboard user tabs through the top bar, the sidebar and the thread list to reach "To". Replies do focus their editor. | Inbox: press `c`, then type. | **Fixed**: a new message opens with focus in To, and closing it returns focus to what opened it (`compose.spec.ts`). |
| A3 | major | **A message's header is a button that contains buttons** (Reply, star, more). Screen readers flatten a button's content, so the inner controls may not be reachable, and the header reads as one long name. axe: `nested-interactive`, serious. | Open any thread. | **Fixed**: the sender's name is the toggle button; the header is no longer a button. |
| A6 | major (to confirm with VoiceOver) | **Toasts may not be announced.** There is no live region on the page until a toast appears; a region inserted together with its text is often skipped, VoiceOver in particular. The toast also nests one `role="status"` inside another, which can announce twice elsewhere. Errors ("Couldn't send…") and Undo arrive this way. | Archive a thread with VoiceOver on. | **oinbox side fixed**: its toast element no longer has a role of its own, so there is one region, the toaster's. **Waiting on rozie Toaster** for standing regions and `alert` for errors (`docs/rozie-feedback.md`); until then errors are announced politely, if at all in VoiceOver. |
| A8 | major (to confirm with VoiceOver) | **Opening and closing a thread does not move focus, and the `j`/`k` cursor is visual only.** After `o` or Enter, focus is on the page, so Tab starts from the top bar and nothing announces the conversation. The cursor row is a CSS class: it has no focus and no `aria-current`, so a screen-reader user cannot tell which row `e` or `#` will act on. Rows are links and can be reached with Tab. | Inbox: `j`, `j`, `o`, then Tab. | **Fixed**: the cursor row has the focus and `aria-current`, and is the list's one tab stop; opening a thread focuses its heading; closing it returns focus to the row, which is also now the row that was opened and not the top of the list (`keyboard.spec.ts`). |
| A1 | minor (axe: critical) | The event card and event form sit in a rozie Popover whose panel has `aria-modal="false"` with no dialog role, which ARIA does not allow. No effect on use was seen. | Calendar: click an event. | rozie defect, reported in `docs/rozie-feedback.md`. It is the only thing that would keep axe red after the other fixes, so it needs a rozie release. |
| A2 | minor (axe: serious) | Red text has a contrast of 2.39:1 in the dark theme (#b3261e on #232327): "Delete" in the event card, and the "Draft" marker on a thread row that holds a draft. The second only shows when such a row is on screen, so the axe test for the list depends on the mailbox. | Dark theme: calendar, click an event; or reply to a thread, close the reply, look at its row. | **Fixed**: red text uses a lighter red in the dark theme. |
| A4 | minor (axe: serious) | FullCalendar's previous and next icons have `role="img"` and no name. The buttons around them are named ("Previous week"), so this is noise more than loss. | Calendar. | **Fixed**: text arrows instead of the icon font. |
| A7 | minor | The search field has no focus ring: its box changes background and gains a shadow, which is faint in the dark theme. | Tab to "Search mail". | **Fixed**: the search box has an outline while focused. |
| A9 | minor | An event card opened from the keyboard keeps focus on the event; its Edit and Delete buttons come after every other event in the tab order. | Calendar: focus an event, Enter, Tab. | Deferred: full keyboard editing of events was put off by decision. Escape returns to the event correctly. |
| A10 | minor | Closing the label picker with Escape leaves focus on the page, not on the row or button it came from. | Inbox: `j`, `l`, Escape. | Deferred with A8 if that fix does not cover it. |
| A11 | note | axe cannot check the message body: the frame runs no scripts, so axe cannot enter it (it hangs if asked to). The content there is the sender's HTML. | | None. |

What passed: every icon button has a name; every other control showed a visible focus ring in both themes; dialogs (confirm, label, shortcuts, identity) take focus on opening and give it back on closing; the label "⋯" menu is fully operable from the keyboard; settings and the calendar toolbar have a sensible tab order; the thread list is a named list of links; sign-in, thread list, composer, search, settings and all dialogs have no serious axe violations.

## Phone width

**Checked:** mail, settings and calendar at 390×844 (Playwright WebKit as an iPhone 14, touch) and by screenshot at 360×640, 2026-10-07. No real device and no on-screen keyboard: both are things only a phone in the hand can show.
**How:** `e2e/phone.spec.ts`, 13 tests tagged `@phone` at the audit, 18 after phase 3 (attach a file, edit a signature, accept an invitation and create an event were added), run by the `phone` project in CI: no sideways scroll on each screen, drawer, open and read a thread, inline reply, compose and send, archive, label, search, settings (vacation switch, identity dialog), calendar day view and event card, and a scan for touch targets under 44px.
**Exit criteria:** every listed flow can be done by touch — **met for mail and settings, with P4 making search awkward; not met for the calendar event card (P2)**. Every target at least 44px — **not met (P3)**.

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| P2 | major | **The event card runs off the right edge of the screen** in week view (its right edge is at 521px of 390). Text is cut off and, for an event on the right of the grid, the Edit and Delete buttons can be out of reach. | Phone: calendar › week › tap "Design review". | **oinbox side fixed**: the card is never wider than the screen. **Waiting on rozie Popover** to keep its panel inside the viewport (`docs/rozie-feedback.md`); the phone test for it is an expected failure until then. |
| P4 | major | **The search field is about 47px wide on a phone**: it shows three characters of what is typed. The top bar gives the space to four icon buttons. | Phone: tap the search field and type `from:bob`. | **Fixed**: the field takes the whole top bar while it has the focus, and no longer shares its space with an empty spacer when it does not (about 135px unfocused, 370px focused, at 390px). |
| P3 | major by the 44px bar set for this slice; minor by WCAG 2.2 AA (24px) for most | **Many controls are smaller than 44px.** Top bar: Menu 40, Search 36. Thread list: star 32, checkbox 16. Thread toolbar buttons 40. Composer: format buttons 28, Send 40 high, close 40, "Cc/Bcc" 18 high. Message: "Show images" and "Always show images…" 18 high. Calendar toolbar: 34 high; calendar toggles 12×12. Settings: several. Four are under 24px in one direction (Cc/Bcc, the two image links, the calendar toggles, the list checkbox). | Phone: any screen. | **Fixed**: on touch screens every control checked is at least 44px in both directions (the four target tests pass on the inbox, a thread, the composer, settings and the calendar). |
| P7 | major | **An event could only be created by dragging on the grid.** On a phone that is a long press and a drag; from the keyboard it was not possible at all. Found in phase 3 while writing the phone tests the audit had skipped. | Phone or keyboard: try to add an event. | **Fixed**: a "New event" button in the calendar toolbar opens the form for the next full hour (`calendar-edit.spec.ts`, `phone.spec.ts`). Editing an existing event on a phone still goes through the event card, which P2 affects. |
| P1 | minor (to check on a device) | In a long thread the inline reply's Send button is sometimes below the fold while typing (seen in two runs of three); the page scrolls to it. With the on-screen keyboard up there is less room still. | Phone: open "Lunch Friday?", Reply, type. | To fix with P3: scroll the composer's action row into view on focus. |
| P5 | minor | The calendar toolbar wraps into two uneven rows at 360px ("today" drops under the arrows). | 360px: calendar › week. | Deferred, cosmetic. |
| P6 | minor | A message's date wraps onto three lines at 360px ("Sep 25, 2026 at 5:28 PM (12 days ago)"). | 360px: open a thread. | Deferred, cosmetic; a shorter date on narrow screens would do. |

What passed: no screen scrolls sideways; the drawer opens, switches mailbox and closes; a thread opens and reads, including an HTML message; a new message fills the screen, sends and arrives; archive, label and search work by touch; settings fit, the vacation switch toggles and the identity dialog fits; the calendar opens in day view below 700px (this was already in place).

## Large mailbox

**Checked:** `carol@example.test` with 50,000 messages (the CMU Enron corpus plus 375 hand-made ones, one of them a 55-message thread) in an Inbox of 13,182 threads, Sent Items and 22 labels; 2026-10-08, Chromium, on the development Mac against the Compose stack (Stalwart 0.16.23 on RocksDB, Meilisearch 1.54).
**How:** `deploy/seed/seed_bulk.py` (`Email/import`, 50 per request), then `pnpm e2e:perf` four times over about an hour. The corpus has almost no threading headers, so nearly every message is its own thread.
**Exit criteria:** thresholds at 50,000 messages — **met for start-up, rendering, a long thread and memory; not met for moving through the list and for search, because of L2.**

| Measure | Threshold | Measured (range over the runs) | Verdict |
|---|---|---|---|
| Cold start to first rows | 3 s | 0.9 – 3.4 s | borderline: see L2 |
| Warm start to first rows | 1 s | 0.06 s | pass |
| Scroll at 1,800 rows a second through 5,000 rows: longest time with no rows | 500 ms | 4.2 s (2.8 s of scrolling, then 1.4 s) | fail: see L2 |
| Scroll: 95th percentile frame | 32 ms | 16.7 ms | pass |
| Jump to row 20,000: time to rows | 1 s | 0.9 – 2.9 s | fail: see L2 |
| Search ("meeting") to first results | 2 s | 1.3 – 2.8 s | borderline: see L2 |
| Open a 55-message thread | 1.5 s | 0.8 s | pass |
| Heap growth over 9 minutes with a new message every 10 s | +20% | +15% | pass |
| Browser storage used | 20 MB | 0.1 MB | pass |

Seen on the way: no import failures in 50,000 messages; no sanitizer errors or blank messages in the ones opened (a few dozen, by hand and by the tests; this was not a systematic read of the corpus); the warm-start snapshot stays small because it holds one page of the list, not the mailbox.

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| L2 | major by the thresholds; the cause is in Stalwart | **Every sorted list query takes Stalwart about 1.4 s on this account**, whatever the mailbox, the position or the filter, and it is not cached. The same query unsorted takes 10 ms, and the 60-message account answers in 10 ms either way. oinbox always sorts by date, so each page of the list costs at least that: start-up, each page reached while scrolling, a jump, and a search are all one or two such queries. Just after the import the same queries were faster (0.9 s cold start); after Stalwart's settings were reloaded they settled at 1.4 s. | `time curl -u carol@example.test:… /jmap/ -d '…["Email/query",{"accountId":"e","sort":[{"property":"receivedAt","isAscending":false}],"limit":50},"q"]…'` with and without the `sort`. | **Not fixed.** oinbox cannot drop the sort (unsorted order is storage order, not date order). What it could do: show the cached first page while the query runs (it already does on a warm start), and fetch pages only when scrolling rests (tried: no gain, since the wait is one query, not a queue). Worth raising with Stalwart with the reproduction above; it may also be specific to RocksDB in Docker on a Mac. For the beta: a known limitation for mailboxes of this size. |
| L3 | note | Three Stalwart defaults got in the way of the import and matter to operators: 1,000 requests a minute per account (`Http.rateLimitAuthenticated`), 500 ids per `Email/get`, and **1,000 uploads or 50 MB of uploads per account per hour** (`Jmap.maxUploadCount`, `Jmap.uploadQuota`). The last one bounds attachments: a user cannot attach more than 50 MB in an hour. | | For the operator guide. The import raised the first and third on the dev stack for its run and put them back. |

## Network

**Checked:** eight conditions on Chromium, Firefox and WebKit, plus a Stalwart restart and an emulated slow link on Chromium, 2026-10-07.
**How:** `e2e/network.spec.ts` (7 tests, in CI on every engine) using Playwright's offline mode and routed responses; two throwaway scripts for the restart and the slow link.
**Exit criteria:** every condition behaves as the spec describes and none loses composer text — **met**, after the two fixes below.

| Condition | Result |
|---|---|
| Offline while reading | Banner within a second; loaded threads still open; banner clears and live updates resume without a reload. |
| Offline during archive | The thread stays in the Inbox (checked on the server) and an error toast shows. |
| Offline during send | "Couldn't send. Your message is still here."; the composer reopens with recipient, subject and body; sending again after reconnect delivers exactly one copy to Bob. |
| Offline during draft autosave | "Couldn’t save draft" with Retry; saves by itself after reconnect. |
| 503 from `/jmap/` | One banner, at most one toast in 10 s, the warm-start mailbox stays on screen, recovery without a reload. |
| A request that never answers | Covered by unit tests only (`client.test.ts`: a timeout becomes a transport failure; `connection.test.ts`: that raises the banner). Not driven in a browser. |
| Refresh token rejected | "You've been signed out." in place; the composer and its text stay on screen; after "Sign in again" the draft is restored and the saved copy removed from the browser. |
| Upload interrupted | "Couldn't attach notes.txt"; the rest of the draft is intact; attaching again after reconnect works. |
| Stalwart restarted mid-session | Banner, recovery after about 15 s with no reload, an edited draft saved, a new message arrived by push, no duplicate rows, not signed out. |
| Slow link (400 kbit/s, 400 ms latency) | A cold load took 22 s to first rows before N1 was fixed; opening a loaded thread 0.4 s; the calendar 26 s on first visit (a 278 kB chunk). The page is blank while the script downloads: see N3. |

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| N1 | major | **The app's files were served uncompressed**: the main script is 870 kB on the wire and 265 kB with gzip. On a slow link that is most of the cold-start time. | `curl -H 'accept-encoding: gzip' -D - -o /dev/null http://localhost:8080/assets/index-*.js` | **Fixed here**: `encode zstd gzip` on the static-file block of the Caddyfile (not on the proxied paths, so the event stream is not buffered). The nginx example in the operator guide must do the same. |
| N2 | major | **A sign-out during a draft autosave went unnoticed.** The autosave swallowed the "not authorised" error, so the app kept looking signed in while every request failed. | Compose, then have the server reject the refresh token. | **Fixed here**: a token refresh the server refuses ends the session at the source, whoever catches the error. A refresh that fails on the network is no longer treated as a sign-out. |
| N3 | minor | Nothing is shown while the app's script downloads: the page is blank for the whole cold load on a slow link. | Throttle the network and load `/`. | **Fixed**: `index.html` shows "Loading oinbox…" until the app mounts. |
| N4 | minor | The calendar is a 278 kB chunk fetched on first visit; on a slow link the pane is empty for that time with no indicator. | Slow link: click Calendar. | **Fixed**: "Loading calendar…" shows while the chunk downloads. |
| N5 | note | An idle tab cannot tell that the network has gone until the browser says so or the push stream has been silent for 75 s. Both are now handled (the `offline` event restarts the stream; a watchdog covers a network that drops without closing connections). | | Done in this slice. |
