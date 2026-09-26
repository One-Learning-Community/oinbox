# oinbox — design

Gmail-style JMAP webmail for a small team on self-hosted Stalwart. Frontend only.
Source brief: the user's "Build a Gmail-style JMAP webmail client" prompt (2026-09-25).

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Base | Start fresh; do not fork Bulwark | Bulwark groups threads client-side (no `collapseThreads`), its core lives in 5–9k-line files that change daily, and one maintainer dominates. Its conversation view already exists, so there is nothing to "contribute"; the gap is the data model. |
| Threading | Trust Stalwart's `threadId` | Client re-threading conflicts with `Thread/get` and `collapseThreads`. Report threading gaps upstream. |
| Framework | SolidJS 1.9 + Vite, TypeScript strict | Fine-grained reactivity: one `Email/changes` updates one row. Dogfoods the rozie.js Solid wrappers. |
| Components | rozie.js (`@rozie-ui/*-solid`) wherever a fit exists | Dogfooding. Gaps are logged in `docs/rozie-feedback.md`, not silently patched. |
| Hosting | Static `dist/` served by Caddy on the same origin as Stalwart | No CORS; one CSP. |
| Auth | OAuth 2 Authorization Code + PKCE against Stalwart (public client) | No stored password; Stalwart's own login/2FA. |
| Push | `fetch`-streamed SSE (not native `EventSource`) | Native `EventSource` cannot send `Authorization: Bearer`. |

## Architecture

```
src/
  jmap/     typed JMAP client: request builder with back-references, session, blobs, SSE stream.  No Solid imports.
  sync/     normalized entity cache (Solid stores) + live query windows; applies /changes and /queryChanges.
  cache/    IndexedDB persistence of mailboxes, first page of each viewed query, and state strings.
  auth/     PKCE flow, token refresh, 401 handling.
  mail/     pure mail logic: quote detection, HTML sanitize, participants formatting, search parser (M2).
  ui/       Solid components. Read stores, call sync actions. Never call jmap/ directly.
```

### Data flow
1. Boot: `auth` yields a token → `GET /.well-known/jmap` → session.
2. Warm start: `cache` hydrates mailboxes + the last inbox window; UI renders immediately.
3. One batched request: `Mailbox/get` + `Email/query(collapseThreads)` → `Email/get(#ids)` → `Thread/get(#threadIds)` → `Email/get(/list/*/emailIds, [from, keywords, mailboxIds, receivedAt])`.
4. Push: `StateChange` → `Email/changes`, `Thread/changes`, `Mailbox/changes` (+ `Email/queryChanges` per live query). If the server answers `cannotCalculateChanges`, refetch only the visible window of that query.
5. Thread open: `Thread/get` → `Email/get` with bodies. Prefetched on row focus/hover.

### Thread list
Virtualized with `@tanstack/virtual-core` (rozie DataTable lacks stable row ids, a visible-range event, and a row-activate event — see `docs/rozie-feedback.md`). The query is a sparse array: `total` from the server, pages of 50 fetched by position as the viewport needs them. Row: participants (from all messages in the thread, including Sent, "me" for own identities), count, subject — preview, attachment flag, date, unread bold, star.

### Conversation view
All thread messages oldest → newest. Unread + latest expanded; read collapsed to one line; runs of >3 collapsed fold into "N older messages". Messages only in Trash/Junk hidden behind "N deleted messages" unless that mailbox is being viewed.

### HTML safety
DOMPurify → `<iframe sandbox="allow-same-origin" srcdoc>` (no scripts) with a CSP meta: `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:` (+ `https:` when images allowed). Remote `src` rewritten to `data-oinbox-src` at sanitize time; per-sender allow list in IndexedDB. `cid:` → blob URLs. Links `target=_blank rel="noopener noreferrer"`. Quoted text (`blockquote[type=cite]`, `.gmail_quote`, Outlook `#divRplyFwdMsg`/`#appendonsend`, "On … wrote:" + `>` lines) folded behind "…".

## Milestones
- **M1** read-only: auth, session, mailboxes, thread list, conversation view, push, Docker Compose.
- **M2** search: operator parser → `FilterCondition`; `SearchSnippet/get` highlights.
- **M3** compose: inline reply/reply-all/forward (rozie TipTap), Identity/get, draft autosave, blob upload, `EmailSubmission/set` with 10 s undo (rozie Toast).
- **M4** triage + shortcuts: optimistic `Email/set` with rollback; Gmail key map.

## Testing
Vitest unit tests for `jmap/` (fake fetch), `sync/` reducers, `mail/` pure functions (quote detection, sanitizer, search parser). Playwright e2e against the Docker Compose stack (seeded users + threads).

## Non-goals (v1)
Calendar, contacts, filter UI, multiple accounts, offline mode, PGP.
