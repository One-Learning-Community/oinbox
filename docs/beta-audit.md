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
