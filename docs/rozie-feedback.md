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
5. **Still open: types are `any`** across props, slot contexts and the handle (unchanged in 0.7.0).

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

## FullCalendar 0.1.10 (Solid) — adopted for the calendar page; three gaps
Wanted: a read-only calendar that fills the main pane, fed from a JMAP store.
1. **`height` is typed `Number` (pixels) only.** FullCalendar itself takes `'auto'`, `'100%'` or any CSS
   height, and the curated `height` prop always wins over `options.height`, so there is no typed way
   to say "fill the parent". We measure the host with a `ResizeObserver` and pass pixels
   (`src/ui/CalendarView.tsx`). Suggest `Number | String`.
2. **`loading` only reflects FullCalendar-fetched event sources.** With `events` passed as an array
   (the documented usage) it never fires, so it can't drive a loading bar. Worth a note in the README.
3. **`noEventsContent` only renders in list views** (a FullCalendar fact). The slot is exposed on
   a wrapper whose baked-in plugins have no list view, so it can't show without `options.plugins`.
   Worth a note in the README.

## Popover 0.2.4 — no external or virtual anchor
Wanted: open event details next to a FullCalendar event element that the popover doesn't render.
Popover measures only its own `.rozie-popover-anchor` wrapper (filled by `anchorSlot`); there's no
`anchor` prop taking an element or a floating-ui virtual element (`getBoundingClientRect`).
Workaround (`src/ui/CalendarView.tsx` `EventPopover`): a `position: fixed` wrapper div (Popover's props
don't accept `class`/`style`) sized to the clicked event's rect, with the anchor stretched to fill it
and an empty anchor slot, mounted fresh per click. Suggest an `anchor`
prop accepting `Element | { getBoundingClientRect(): DOMRect }`. Related: FullCalendar's
`eventClick` payload drops `info.el`, so the element is recovered via `jsEvent.target.closest('.fc-event')`.

## FullCalendar 0.1.10 (Solid) — typing and defaults
Found while wiring the calendar page; none blocked us, all cost a workaround or a surprise.
1. **Event handlers and slots are untyped.** Every handler is `(...args: unknown[]) => void` and every
   slot context is `{ arg: any }`, although the README documents each payload (`datesSet` →
   `{ start, end, view }`, `eventClick` → `{ event, jsEvent, view }`, …). `src/ui/CalendarView.tsx`
   casts both handlers it uses. Suggest exporting payload types (`DatesSetPayload`,
   `EventClickPayload`, …) and typing the `on*` props with them.
2. **Events are always keyboard-focusable.** The wrapper always registers FullCalendar's
   `eventClick`, and FullCalendar makes events interactive (`tabindex="0"`) whenever an eventClick
   handler exists. oinbox wants this (event details open with Enter; pinned by
   `e2e/calendar.spec.ts`), but a consumer that ignores clicks still gets a tab stop per event.
   Suggest registering `eventClick` only when `onEventClick` is bound (or exposing
   `eventInteractive`), and documenting the behaviour either way.
3. **The title fallback leaks ids.** `normalizeEvent` shows an untitled event as `Event <id>`
   (`Event (no id)` without one). For server-backed data that id is internal (Stalwart ids look like
   `h1jfdmaaaaap`). oinbox always sends a title (`(No title)`), so we don't hit it. Suggest an empty
   title or a `untitledLabel` prop.
