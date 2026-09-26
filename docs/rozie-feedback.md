# rozie.js feedback from oinbox (Solid wrappers)

Findings from dogfooding `@rozie-ui/*-solid` in a live-updating webmail client.
Each entry: what we needed, what's missing, and what we did instead.

## BLOCKER: Solid dists ship raw JSX
Every `@rozie-ui/*-solid` package checked (toast, popover, combobox, command-palette, tags,
data-table) has JSX in `dist/index.mjs`, which is what the `import` export condition resolves to.
Vite 8 / rolldown fails with `PARSE_ERROR Unexpected JSX expression`. This contradicts "no build step".
Fix: compile JSX with `babel-preset-solid` at publish time for `import`, and expose the JSX
source under the `solid` export condition (the convention `vite-plugin-solid` and
`solid-js`-aware bundlers look for).
Workaround in oinbox `vite.config.ts`: `solid({ extensions: ['.mjs'], include: [..., /@rozie-ui\/.+-solid\/dist\/.+\.mjs$/] })`
plus `optimizeDeps.exclude` for the rozie packages.

## Packages not published for Solid
`dialog`, `listbox`, `resizable`, `slider`, `switch`, `number-field`, `pagination` are listed on the
components page as headless primitives but `@rozie-ui/<name>-solid` returns 404 on npm (2026-09-25).
oinbox needed Dialog (shortcut help, confirm) and Resizable (list/reading-pane split).

## DataTable 0.5.0 — not usable for a live thread list
Wanted: the Gmail thread list (50k rows, server-paged, rows inserted/removed by push).
1. **No `getRowId`.** Selection, expansion and the active cell are keyed by row index. When a push
   inserts a thread at the top, a checked selection silently moves to a different thread. TanStack
   core supports `getRowId`; please expose it.
2. **No visible-range event with `virtual`.** There is no way to learn which rows are on screen, so
   the consumer can't fetch the pages the viewport needs. `manual` + `rowCount` covers pagination,
   not windowed lazy loading. Suggest `onVisibleRangeChange({ start, end })` plus letting `data`
   contain placeholders (or a `rowCount` larger than `data.length` in virtual mode).
3. **No row activation event** (`onRowClick` / Enter on a row) for list-style use.
4. **Types are `any`** across props, slot contexts and the handle (`sortColumn: (...args: any[]) => any`).
   Generic `DataTable<Row>` typing would catch misuse.

oinbox instead uses `@tanstack/virtual-core` directly with a ~40-line Solid adapter.

## Toast 0.1.8
1. **`show()` drops unknown fields**, so there is no way to attach an action ("Undo") or payload to a
   toast. Workaround: `toastSlot` plus a side map from toast id to action. Suggest
   `show({ message, action: { label, onClick } })` or passing through a `data` field.
2. Handle is typed `(...args: any[]) => any`; `show` should be typed with its option object.

## TipTap 0.3.6
1. **Unconfirmed:** `autofocus` and `focusEditor()` didn't move focus into an inline reply editor.
   Only observed in an automated Chrome window without OS focus (`document.hasFocus() === false`),
   so this needs confirming in a normal window before filing. Either way, there's no "ready" event to
   know when `focusEditor()` will work. Workaround: two rAFs, then focus the `[contenteditable]`.
   Suggest an `onReady(editor)` event.
2. Missing peer `@tiptap/extension-character-count` is required even when `maxLength` is unused.
3. The default theme hardcodes a light toolbar/background; there's no dark-mode default. oinbox maps
   `--rozie-tiptap-*` onto its own tokens.

## Tags 0.1.9
Works well for recipients: `validate` + `delimiters` handle paste of "a, b; c". Default chip/input
colors are light-only (same theming note as TipTap).
