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
Dialog (shortcut help, confirm) and Resizable (list/reading-pane split) — not yet adopted in-app,
tracked separately.

## DataTable 0.6.0 — was not usable for a live thread list, now mostly is
Wanted: the Gmail thread list (50k rows, server-paged, rows inserted/removed by push).
1. **FIXED: `getRowId`** is now exposed and documented for exactly this case (rows added/removed
   while selection/expansion state is held).
2. **FIXED: `visible-range-change` event** — fires `{ start, end }` on the rendered row window under
   `virtual`, pairs with `manual` + `rowCount` + sparse `data`. Matches what was asked for.
3. **FIXED: `row-activate` event** — fires on a plain click (not on a control/link/editor) or Enter
   on a non-editable cell; payload `{ row, index, trigger }`. The rozie README literally cites
   "oinbox's email thread" as the motivating case.
4. **Still open: types are `any`** across props, slot contexts and the handle.

oinbox still uses `@tanstack/virtual-core` directly with its own Solid adapter — worth revisiting
now that 1–3 are solved, not yet migrated.

## Toast 0.2.0
1. **FIXED: `show()` now takes `action`/`data`** — see the README's `Undo` example
   (`action: { label, onClick }`, `data` rides to the callback and the `dismissed` event).
2. **Still open:** handle is typed `(...args: any[]) => any` in `dist/index.d.mts`; `show` isn't
   typed with its option object despite the feature working.

## TipTap 0.4.0
1. **Still unconfirmed:** `autofocus`/`focusEditor()` focus timing — no `onReady(editor)` event
   found in this release either. Not re-tested this pass.
2. **FIXED: `@tiptap/extension-character-count` is now `optional: true`** in `peerDependenciesMeta`
   (along with `extension-image` and `extension-floating-menu`); `core`/`extensions`/`starter-kit`/
   `extension-bubble-menu` remain required, which is correct.
3. **Still open:** default theme is light-only; oinbox still maps `--rozie-tiptap-*` onto its own
   tokens (unchanged, not re-tested this pass).

## Tags 0.1.10
Not re-tested this pass; light-only default chip/input colors were the only open item as of 0.1.9.
