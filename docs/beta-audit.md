# Beta audit

What was checked before `0.1.0-beta.1`, how, and what was found.
Severity: a **blocker** loses or corrupts data, or stops a main flow for everyone on a supported browser. A **major** makes a main flow fail or unusable for some users with no reasonable workaround. Everything else is a **minor**. Blockers and majors are fixed before the beta; minors are listed under "Known limitations" in the README.

## Browser engines

**Checked:** the whole e2e suite (80 tests) on Playwright's Firefox 155 and WebKit 26.6, desktop 1280×900, 2026-10-07.
**How:** `pnpm exec playwright test --project=firefox` and `--project=webkit` against the Compose stack.
**Result:** Firefox 79 pass, 1 skipped. WebKit 78 pass, 2 expected failures (E1).

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| E1 | major | **Safari: quoted text in a message cannot be expanded.** The "•••" button inside the message does nothing. The message iframe is sandboxed without `allow-scripts`, and WebKit does not run event listeners on elements in such a frame, even when the parent page added them. | WebKit: open Erin's HTML reply in "Design review", press "•••". | To fix: fold the quote with `<details>`/`<summary>`, which needs no script, and size the frame from a `ResizeObserver` in the parent. Two tests in `e2e/html-message.spec.ts` are marked `test.fail` for WebKit until then. Check for other listeners added inside the frame (link clicks, image banner) at the same time. |
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

**Exit criteria:** no serious or critical axe violations — **not met** (A1–A4; five screens are marked `test.fail` with their finding). All eight flows by keyboard alone — **not met** (A5). By VoiceOver alone — **not checked**.

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| A5 | major | **A new message does not take focus.** After `c` or the Compose button, focus stays on the page. The composer is last in the tab order, so a keyboard user tabs through the top bar, the sidebar and the thread list to reach "To". Replies do focus their editor. | Inbox: press `c`, then type. | To fix: focus the To field when a new composer opens; return focus to where it was when it closes. |
| A3 | major | **A message's header is a button that contains buttons** (Reply, star, more). Screen readers flatten a button's content, so the inner controls may not be reachable, and the header reads as one long name. axe: `nested-interactive`, serious. | Open any thread. | To fix: make the toggle its own button inside the header, next to the actions, not around them. |
| A6 | major (to confirm with VoiceOver) | **Toasts may not be announced.** There is no live region on the page until a toast appears; a region inserted together with its text is often skipped, VoiceOver in particular. The toast also nests one `role="status"` inside another, which can announce twice elsewhere. Errors ("Couldn't send…") and Undo arrive this way. | Archive a thread with VoiceOver on. | To fix: keep one empty polite region and one assertive region mounted for the life of the page and write toast text into them; drop the inner role. The outer element is rozie Toaster's (see `docs/rozie-feedback.md`). |
| A8 | major (to confirm with VoiceOver) | **Opening and closing a thread does not move focus, and the `j`/`k` cursor is visual only.** After `o` or Enter, focus is on the page, so Tab starts from the top bar and nothing announces the conversation. The cursor row is a CSS class: it has no focus and no `aria-current`, so a screen-reader user cannot tell which row `e` or `#` will act on. Rows are links and can be reached with Tab. | Inbox: `j`, `j`, `o`, then Tab. | To fix: focus the conversation heading on open and the row on return; give the cursor row real focus (roving tabindex). |
| A1 | minor (axe: critical) | The event card and event form sit in a rozie Popover whose panel has `aria-modal="false"` with no dialog role, which ARIA does not allow. No effect on use was seen. | Calendar: click an event. | rozie defect, reported in `docs/rozie-feedback.md`. It is the only thing that would keep axe red after the other fixes, so it needs a rozie release. |
| A2 | minor (axe: serious) | "Delete" in the event card has a contrast of 2.39:1 in the dark theme (#b3261e on #232327). | Dark theme, calendar: click an event. | To fix: a lighter danger colour in the dark theme. One line. |
| A4 | minor (axe: serious) | FullCalendar's previous and next icons have `role="img"` and no name. The buttons around them are named ("Previous week"), so this is noise more than loss. | Calendar. | To fix: hide the icons from the accessibility tree after render, or through the rozie wrapper if it offers a hook. |
| A7 | minor | The search field has no focus ring: its box changes background and gains a shadow, which is faint in the dark theme. | Tab to "Search mail". | To fix: an outline on `.search-box:focus-within`. |
| A9 | minor | An event card opened from the keyboard keeps focus on the event; its Edit and Delete buttons come after every other event in the tab order. | Calendar: focus an event, Enter, Tab. | Deferred: full keyboard editing of events was put off by decision. Escape returns to the event correctly. |
| A10 | minor | Closing the label picker with Escape leaves focus on the page, not on the row or button it came from. | Inbox: `j`, `l`, Escape. | Deferred with A8 if that fix does not cover it. |
| A11 | note | axe cannot check the message body: the frame runs no scripts, so axe cannot enter it (it hangs if asked to). The content there is the sender's HTML. | | None. |

What passed: every icon button has a name; every other control showed a visible focus ring in both themes; dialogs (confirm, label, shortcuts, identity) take focus on opening and give it back on closing; the label "⋯" menu is fully operable from the keyboard; settings and the calendar toolbar have a sensible tab order; the thread list is a named list of links; sign-in, thread list, composer, search, settings and all dialogs have no serious axe violations.

## Phone width

**Checked:** mail, settings and calendar at 390×844 (Playwright WebKit as an iPhone 14, touch) and by screenshot at 360×640, 2026-10-07. No real device and no on-screen keyboard: both are things only a phone in the hand can show.
**How:** `e2e/phone.spec.ts`, 13 tests tagged `@phone`, run by the `phone` project in CI: no sideways scroll on each screen, drawer, open and read a thread, inline reply, compose and send, archive, label, search, settings (vacation switch, identity dialog), calendar day view and event card, and a scan for touch targets under 44px.
**Exit criteria:** every listed flow can be done by touch — **met for mail and settings, with P4 making search awkward; not met for the calendar event card (P2)**. Every target at least 44px — **not met (P3)**.

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| P2 | major | **The event card runs off the right edge of the screen** in week view (its right edge is at 521px of 390). Text is cut off and, for an event on the right of the grid, the Edit and Delete buttons can be out of reach. | Phone: calendar › week › tap "Design review". | To fix: on narrow screens show the card as a sheet across the bottom, or let the popover shift and cap its width to the viewport. Check whether rozie Popover's `strategy="fixed"` with a shift/size option does this. |
| P4 | major | **The search field is about 47px wide on a phone**: it shows three characters of what is typed. The top bar gives the space to four icon buttons. | Phone: tap the search field and type `from:bob`. | To fix: let the field take the row when focused (hide the other top-bar buttons), or move the theme and sign-out buttons into the drawer on narrow screens. |
| P3 | major by the 44px bar set for this slice; minor by WCAG 2.2 AA (24px) for most | **Many controls are smaller than 44px.** Top bar: Menu 40, Search 36. Thread list: star 32, checkbox 16. Thread toolbar buttons 40. Composer: format buttons 28, Send 40 high, close 40, "Cc/Bcc" 18 high. Message: "Show images" and "Always show images…" 18 high. Calendar toolbar: 34 high; calendar toggles 12×12. Settings: several. Four are under 24px in one direction (Cc/Bcc, the two image links, the calendar toggles, the list checkbox). | Phone: any screen. | To fix: under `@media (pointer: coarse)`, give `.icon-btn`, the composer toolbar, the calendar toolbar and the link-style buttons a 44px minimum box (padding, not bigger glyphs). Mostly CSS. Four tests are marked `test.fail` until then. |
| P1 | minor (to check on a device) | In a long thread the inline reply's Send button can be below the fold while typing; the page scrolls to it. With the on-screen keyboard up there is less room still. | Phone: open "Lunch Friday?", Reply, type. | To fix with P3: scroll the composer's action row into view on focus. One test is marked `test.fail`. |
| P5 | minor | The calendar toolbar wraps into two uneven rows at 360px ("today" drops under the arrows). | 360px: calendar › week. | Deferred, cosmetic. |
| P6 | minor | A message's date wraps onto three lines at 360px ("Sep 25, 2026 at 5:28 PM (12 days ago)"). | 360px: open a thread. | Deferred, cosmetic; a shorter date on narrow screens would do. |

What passed: no screen scrolls sideways; the drawer opens, switches mailbox and closes; a thread opens and reads, including an HTML message; a new message fills the screen, sends and arrives; archive, label and search work by touch; settings fit, the vacation switch toggles and the identity dialog fits; the calendar opens in day view below 700px (this was already in place).
