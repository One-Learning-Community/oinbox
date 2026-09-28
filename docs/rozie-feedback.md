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
