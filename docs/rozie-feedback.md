# rozie.js feedback from oinbox (Solid wrappers)

Findings from dogfooding `@rozie-ui/*-solid` in a live-updating webmail client.
Each entry: what we needed, what's missing, and what we did instead.

## FIXED (2026-09-27 release): Solid dists shipped raw JSX
Was: every `@rozie-ui/*-solid` package checked (toast, popover, combobox, command-palette, tags,
tiptap, data-table) had JSX in `dist/index.mjs`, the file the `import` export condition resolves to.
Now fixed as suggested: `dist/index.mjs` is precompiled (solid-js/web `template`/`insert`/etc.), and
the `solid` export condition points at raw JSX (`dist/source/index.jsx`). Removed the
`vite.config.ts` workaround (`solid({ extensions: ['.mjs'], include: [...] })` +
`optimizeDeps.exclude`) — plain `solid()` now builds clean.

## FIXED (2026-09-27 release): Packages not published for Solid
`dialog-solid`, `listbox-solid`, `resizable-solid`, `slider-solid`, `switch-solid`,
`number-field-solid`, `pagination-solid` are now on npm (first releases, 0.1.3). oinbox wanted
Dialog for shortcut help and a new confirm-before-archive/trash/spam/discard-draft flow — both now
built on `dialog-solid` (`src/ui/Overlays.tsx` `HelpDialog`, `src/ui/ConfirmDialog.tsx`). Resizable
(list/reading-pane split) is still not adopted — deliberately out of scope this pass, not a rozie gap.

## DataTable 0.7.0 — every asked-for API now exists, but it's still not a fit for ThreadList
Wanted: the Gmail thread list (50k rows, server-paged, rows inserted/removed by push).
1. **FIXED: `getRowId`** is now exposed and documented for exactly this case (rows added/removed
   while selection/expansion state is held).
2. **FIXED: `visible-range-change` event** — fires `{ start, end }` on the rendered row window under
   `virtual`, pairs with `manual` + `rowCount` + sparse `data`. Matches what was asked for.
3. **FIXED: `row-activate` event** — fires on a plain click (not on a control/link/editor) or Enter
   on a non-editable cell; payload `{ row, index, trigger }`. The rozie README literally cites
   "oinbox's email thread" as the motivating case.
4. **FIXED (0.7.0): `scrollToRow(index, options?)` and `getScrollElement()`** on the imperative
   handle — exactly the ask filed after trying the migration below: `scrollToRow` mirrors
   TanStack virtual-core's `scrollToIndex`, and `getScrollElement()` is "the supported replacement
   for reaching into the internal `.rdt-scroll` class selector." Independent of grid-mode focus,
   so it doesn't fight a `role="list"` consumer either.
5. **Still open: types are `any`** across props, slot contexts and the handle (unchanged in 0.7.1,
   where the `on*` props went from `(...args: unknown[])` to `(...args: any[])`).

Even with every row-level API now fixed, DataTable still isn't a good fit for a list-shaped UI like
a thread list, for the reason that actually matters: **it renders a real `<table>`/`<tr>` structure**
(`interactionMode: 'table'`, "byte-behaviorally identical to a plain accessible table"). ThreadList's
rows are Gmail-style list items (`role="list"`/`role="listitem"`), so migrating would change how
screen readers announce the inbox — a table of cells instead of a list of conversations. That's a
real regression, not a styling difference, and not something a consumer can override from outside
(the table semantics are the point of an accessible-by-default `<table>`). It's also still a full
spreadsheet-grade grid (inline editing, grouping, column pinning, undo/redo) — a lot of machinery to
import for a component that's conceptually a virtualized list with one flexible "row" column.

oinbox still uses `@tanstack/virtual-core` directly with its own ~60-line Solid adapter
(`src/ui/virtual.ts`) and isn't migrating ThreadList to DataTable. Every fix above is still valuable
for anyone using DataTable as an actual multi-column grid with live/pushed data — that's most of what
was asked for.

## Toast 0.2.1
1. **FIXED: `show()` takes `action`/`data`**, as of 0.2.0.
2. **FIXED (0.2.1): the whole `ToasterHandle` is properly typed** — `show`/`patch`/`promise` now
   have real option-object signatures instead of `(...args: any[]) => any`. Nothing left open here.

## TipTap 0.5.0
1. **FIXED: a `ready` event** now exists — "The editor exists — the live TipTap `Editor` instance.
   Fires once per mount. Handle verbs (`focusEditor()`, `setContent()`, …) work from here on."
   Exactly the `onReady(editor)` ask; resolves the `autofocus`/`focusEditor()` timing uncertainty
   too, since there's now a documented moment to act instead of guessing with rAFs.
2. **FIXED (0.4.0, confirmed still true):** `@tiptap/extension-character-count` stays `optional: true`
   in `peerDependenciesMeta`.
3. **FIXED, correcting a mistake in this doc:** a real dark-mode default *does* ship in 0.5.0 — a
   zero-import `@media (prefers-color-scheme: dark)` block baked directly into the component's own
   compiled bundle (`dist/index.mjs`), not a separate `themes/*.css` file. The earlier "still
   light-only" entry here was wrong: it only checked for a theme CSS file and a `## Theming` README
   section, both of which this package genuinely doesn't have — the default is injected inline
   instead, same `:not(.light):not([data-theme="light"])` opt-out convention as every other
   package. **Real gap found while verifying this**, though: oinbox's own `--rozie-tiptap-*`
   overrides in `styles.css` didn't cover every token the dark block sets. Two were live in
   oinbox's actual UI (`placeholder-color`, used by the reply placeholder; `button-active-border-color`)
   and left uncovered, meaning they'd silently follow the *browser's* OS-level dark-scheme setting
   instead of oinbox's own `data-theme` toggle — invisible when the two happen to agree, wrong when
   they don't (e.g. OS light + oinbox's toggle set to dark). Fixed by adding both to oinbox's own
   token overrides. Four more (`readonly-bg`, `count-border`, `count-color`, `count-over-color`)
   are genuinely unused — oinbox doesn't set `readonly` or use the character-count/`maxLength`
   feature — so left alone rather than overriding dead code paths.

## Tags 0.1.11
**FIXED: real dark-mode default**, both OS-driven (`@media (prefers-color-scheme: dark)`) and
app-toggled (`:where(.dark, [data-theme="dark"])`) — the app-toggled selector matches oinbox's own
`document.documentElement.dataset.theme` mechanism exactly. oinbox's own `--rozie-tags-*` token
overrides in `styles.css` still win (public tokens beat the package's internal dark-mode wiring), so
this was a no-op for us visually, but it means a consumer with *no* theme bridge of their own now
gets a correct dark mode for free. Nothing open left for this package.

## FIXED (0.2.0): FullCalendar — `height`, `loading`, `noEventsContent`
1. **FIXED: `height` takes any CSS height** (`'auto'`, `'100%'`, `'32rem'`) as well as pixels.
   oinbox passes `height="100%"` and dropped its `ResizeObserver` (`src/ui/CalendarView.tsx`).
2. **FIXED (documented): `loading` only reflects FullCalendar-fetched sources.** The README says so
   and shows `options.eventSources` for managed fetching.
3. **FIXED (documented): `noEventsContent` needs a list view**, with the `@fullcalendar/list` recipe.

## FIXED (0.3.0): Popover — external or virtual anchor
`reference` takes an Element or a floating-ui virtual element, and FullCalendar 0.2.0's `eventClick`
payload carries `el`. The event details card now anchors to the clicked event
(`src/ui/CalendarView.tsx` `EventPopover`: `trigger="manual"`, `strategy="fixed"`,
`reference={el}`); the fixed-position overlay box and the `closest('.fc-event')` lookup are gone.
A click on another event moves the card, as the README promises (pinned in `e2e/calendar.spec.ts`),
but only with one long-lived Popover whose `reference` is repointed. Our first version mounted a
new Popover per click (`<Show keyed>`), and that closes the new card: the outside-click decision is
deferred with `setTimeout(0)`, the timer is not cancelled when the component is disposed, and the
disposed instance then calls its `onOpenChange(false)`. It passed locally and failed in CI, so it is
timing-dependent. Suggest clearing that timer in `onCleanup`.
One consequence to know: the popover closes when the referenced element leaves the document, and
FullCalendar re-creates event elements when `events` changes, so a pushed calendar change closes an
open card. Fine for us; a consumer who wants it to stay can pass a virtual element with a fixed rect.

## FIXED (0.2.0): FullCalendar — typing and defaults
1. **FIXED: handlers, slots and the handle are typed** (`FullCalendarEventClick`,
   `FullCalendarDatesSet`, … are exported). `CalendarView.tsx` lost both casts.
2. **FIXED (documented, with an opt-out): events are keyboard-focusable.** The wrapper still always
   registers `eventClick`, but the README now says so and `options={{ eventInteractive: false }}`
   turns it off. oinbox keeps the default.
3. **FIXED: the title fallback no longer leaks ids.** An untitled event renders an empty title and
   gets an `aria-label`.

## Tags 0.1.12 — still no suggestions and no way to clear the draft
Unchanged from 0.1.11: no suggestion list, no event for the typed text, no `commit()`/`clearDraft()`
on the handle (it has `clear` and `focus`). oinbox's recipient fields are on Combobox and the
package is not installed; Combobox 0.7.0 now covers the token-input case (below), so this matters
only to someone who wants Tags itself with suggestions.

## Combobox 0.7.0 — the eight token-input gaps are fixed; five smaller findings
Wanted: a Gmail-style recipient field: chips, a suggestion list fed by the host, free text for
addresses nobody has suggested. `src/ui/RecipientField.tsx` now uses, from the 0.7.0 release:
1. **FIXED: commit keys** — `delimiters={[',', ';']}`.
2. **FIXED, but not used by us: paste-to-add** — `delimiters` also splits a paste. See finding A.
3. **FIXED: Tab picks** — `selectOnTab`; and `activeOption()` on the handle. We no longer read
   `aria-activedescendant`.
4. **FIXED: the list can stay closed** — `disableOpenOnFocus` and `hideEmpty`. With `hideEmpty` the
   input reports `aria-expanded="false"` while nothing shows (pinned in `e2e/compose.spec.ts`); the
   CSS that hid an empty list by class name is gone.
5. **FIXED: Escape** is left to the host unless a list is showing. We read `defaultPrevented`.
6. **FIXED: free text without a "Create" row** — `validate`.
7. **FIXED: fills its container** — `block`.
8. **FIXED: chips and input on one wrapping row** — `chipLayout="inline"`, with
   `--rozie-combobox-inline-*` tokens. All of oinbox's CSS that re-laid out Combobox's internals is
   gone; only tokens remain.
Also **FIXED: `on*` payloads and slot contexts are typed** (`ComboboxChangePayload`, …). `option` and
`value` are still `any`; a generic `Combobox<TOption>` would remove our two casts.

New findings, all with small host-side code:
- **A. Paste replaces what is already typed, and can't be customised.** `onPaste` splits the
  clipboard text on the delimiters, commits the accepted parts and sets the input to the rejected
  parts, discarding text already in the input (type `ann@`, paste `corp.com, bob@x.test`: the input
  becomes `corp.com`). A single value with no delimiter is not committed. The split is not
  quote-aware, so `"Roe, Sam" <sam@x.test>` becomes two pieces. oinbox keeps its own paste handler
  and registers it in the capture phase with `stopPropagation()` so Combobox never sees the event.
  Suggest inserting at the caret, and a `splitPaste: (text) => string[] | null` hook (or a
  cancellable `paste` event).
- **B. `validate` can't normalise.** It returns a boolean, so `Sam Roe <sam@x.test>` is committed to
  `value` as that whole string. We keep `value` controlled and convert in `onChange` (`text` →
  address). Tags' `validate` returns the string to store; the same shape here would do.
- **C. The query can change without a `search` event.** `search` fires on input only. When Combobox
  clears the input itself, the host's copy of the query goes stale. After a pick or a commit there is
  a `change` to hang that on, but a free-text commit of a value already selected clears the input
  and fires nothing. We resync on `keydown`. Suggest firing `search` with `''`, or a `query()` on
  the handle.
- **D. No commit on blur.** Leaving the field with a complete address typed should add it. We do it
  in `focusout`. Suggest `commitOnBlur`.
- **E. Enter with Ctrl/Cmd/Alt no longer picks the highlighted option** (0.6.0 picked). A good
  change, since hosts use Ctrl+Enter to submit, but it arrived unannounced in a minor and failed one
  of our e2e tests. The packages ship no changelog; one per package would have covered this.

## CommandPalette — a row pinned last needs the whole scorer replaced
**FIXED in 0.5.0, not adopted yet:** `score` now receives the default scorer as a third argument
(`item.id === 'create' ? -Infinity : defaultScore(item, query)`), and an item can set
`highlight: false` or its own ranges. oinbox still uses its own scorer (`src/ui/picker.ts`, 18
lines) and the `optionSlot` branch: switching would change the ranking of every row for no visible
gain. The entry below is as written against 0.4.10.

Wanted: the Move/Label pickers show "Create '<typed text>'" as the last row, below every match.
`score` is the only way to order one row, and it replaces the default scorer for every row; the
default (`defaultScore` / `fuzzyMatch`) isn't exported, so we wrote our own ranking for all rows
(`src/ui/picker.ts`) to pin one. The docs suggest `return baseScore + bonus` inside `score`, which
also needs the base. Suggest exporting `defaultScore`, or passing it to `score` as a third
argument, or a first-class `creatable` row as Combobox has.
Worked well: the row is an ordinary item, so arrow keys, Enter and the group heading come free.
Highlighting: `labelHighlight` marks the first subsequence match in the visible label, so for the
row `Create 'ea'` it marks letters of "Create", not the typed text. We render that one row through
`optionSlot` (returning `undefined` for every other row keeps the default rendering, which is
handy). A per-item `highlight: false`, or highlight ranges an item can supply, would do.

## Popover 0.3.0 — hosting a menu (the sidebar label "⋯")
Wanted: a menu button with Rename/Delete. There is no Menu component, so the roving focus, arrow
keys, focus-first-item and Escape-returns-focus are ours (`src/ui/LabelMenu.tsx`).
1. **FIXED in 0.3.0, not adopted yet: trigger ARIA.** `popupRole="menu"` sets the `aria-haspopup`
   value, and the anchor slot now receives `open`, `panelId` and `popupRole` for the consumer's own
   button. LabelMenu still uses `trigger="manual"` with its own ARIA; moving it saves little while
   the menu keyboard handling stays ours.
2. **Still open: the root is `display: contents`.** It now accepts `class`, but a class can't place
   a box that isn't there; we still wrap it in our own positioned `<span>`.
3. **Partly fixed: panel ids.** There is an `idBase` prop (panel id `idBase + '-panel'`), but the
   default is the same for every instance, so two open popovers still share an id unless each sets
   one. Suggest a generated default.
4. **FIXED in 0.3.0:** the "no external anchor" gap (`reference`), so one shared Popover for all
   label rows is now possible. Not adopted.
5. **Still open: no Menu component.** Home/End, and Tab closing the menu with focus handed back to
   the button, are ours too. A Menu component would cover all of this.

## FIXED (0.2.0): Dialog — `initialFocus`
`initialFocus` (selector or element) exists. The label dialog's field is the dialog's first
focusable element, so the native choice already lands on it; we only call `select()` on the input
in `onMount`, with no microtask wait.

## FIXED (0.2.0): Dialog — scroll lock released when unmounted while open
`onCleanup` now releases the lock.

## FIXED (0.2.0): Dialog — focus returned when unmounted while open
`onCleanup` closes the `<dialog>` and, if the focus is still lost a tick later, focuses the element
that had it when the dialog opened. oinbox deleted `src/ui/focus.ts` and its two callers
(ConfirmDialog, LabelDialog); `e2e/labels.spec.ts` pins the result (the "⋯" button gets the focus
back after a closed rename dialog and a cancelled delete).

## All packages (2026-10-02 release) — wrappers accept the root element's props
Every wrapper's props now extend `ComponentProps<'div'>` (or `'dialog'`), which is what lets
`class` through. Two side effects:
1. **A removed or renamed event prop still type-checks.** Popover's `onChange` was removed in 0.3.0
   in favour of `onOpenChange`; `<Popover onChange={…}>` now compiles as the native DOM `change`
   handler and silently never fires. oinbox already used `onOpenChange`, but the compiler can no
   longer catch this class of break. A changelog entry is the only warning a consumer gets.
2. **Untyped handlers got looser:** `(...args: unknown[]) => void` became `(...args: any[]) => void`
   in Dialog, CommandPalette, DataTable, TipTap and Toast.


## FIXED in 0.1.15 (2026-10-06): DatePicker 0.1.14 — `focus()` doesn't move DOM focus
Wanted: the vacation form opens a DatePicker in a Popover and calls the handle's `focus()` so a
keyboard user lands in the grid (the README: "Move keyboard focus into the calendar grid … Useful
right after the picker becomes visible").
What happens: the active day changes (today gets the roving `tabindex=0` and its outline), but
`document.activeElement` stays on the button that opened the popover. Calling `focus()` 300 ms after
the open, with the handle present and the grid rendered, gives the same result, so it isn't timing.
Cause, from the sources: `focus()` → `seedActiveDay()` → `setActiveDay()`. In `@rozie/runtime-solid`
0.8.0 `createKeynav`'s effect only calls `activeEl.focus()` when `mayApply` is true, which needs
`hasInteracted` (set by a `focusin` inside the grid) or the focus already inside the scope. Neither is
true when the call comes from outside, which is the case the handle exists for.
Effect in oinbox: the popover's calendar can't be reached from the keyboard (it's portalled, so Tab
from the button doesn't go there either). The settings slice's vacation dates are blocked on this.
Expected: `focus()` focuses the active day cell unconditionally (it's an explicit request), e.g. by
marking the next settle as "apply focus".

## FIXED in 0.5.2 (2026-10-06): TipTap 0.5.1 — Escape inside the editor never reaches a surrounding `<dialog>`
ProseMirror's `captureKeyDown` calls `preventDefault()` on Escape (and Enter) in every editor, so a
native `<dialog>` (rozie Dialog) doesn't fire `cancel` while the focus is in a TipTap field. oinbox's
identity dialog closes itself on an Escape keydown whose target is the contenteditable
(`src/ui/IdentityDialog.tsx`). A wrapper option (or Dialog listening for Escape regardless of
`defaultPrevented` from a ProseMirror target) would make this unnecessary. Not blocking.
Resolved: 0.5.2 leaves an unhandled Escape alone; the workaround in `IdentityDialog.tsx` is removed.

## Switch 0.1.4 — no gaps found (2026-10-02)
`id` passes through to the `role="switch"` button, so a plain `<label for>` names it; Space toggles.

## No Select package (2026-10-07)
The calendar event form's calendar picker is a native `<select>`: there is no `@rozie-ui/select-*`
package to dogfood. Not blocking.

## FullCalendar 0.2.0 — `eventDrop`/`eventResize` payload has no `allDay` (2026-10-07)
`FullCalendarEventRef` is `{ id, title, start, end }`. A drop onto the all-day row (or off it) can't
be told apart from a plain move, so oinbox reads `ref.getApi().getEventById(id).allDay` through the
handle. An `allDay` field on the payload would remove that lookup. Not blocking.
