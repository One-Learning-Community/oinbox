# Contributing

Thanks for looking. oinbox is small enough to hold in your head: a typed JMAP client, a sync engine, pure mail and calendar logic, and Solid components on top. The README's "Layout" table says where each lives.

## Running it

```sh
pnpm install
pnpm build
cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d && ./seed.sh
```

`deploy/README.md` explains the stack and its test accounts. `pnpm dev` gives hot reload on http://localhost:5173.

## Tests

```sh
pnpm test         # unit tests (Vitest, jsdom)
pnpm typecheck
pnpm e2e          # Playwright on Chromium against the stack; run `pnpm build` first
pnpm e2e:all      # all four browser projects, as CI does
```

A change comes with a test that fails without it: a unit test where the fault is in logic, an end-to-end test where it is in the page. The sync engine is tested against an in-memory JMAP server (`src/sync/fake-jmap.ts`); when Stalwart turns out to behave differently from the fake, fix the fake too.

### Writing end-to-end tests

- Specs share one mailbox and run one at a time. Each arranges what it needs through JMAP or SMTP (`e2e/support/`) and removes it afterwards.
- **Do not wait on a subject search** to find a message you have just delivered: Stalwart's full-text index lags behind delivery. List the newest messages and filter them, or follow thread membership (`recentWithSubject` in `e2e/calendar-invite.spec.ts` is the pattern).
- An invitation fixture must start in the future (`futureStart` in `e2e/support/calendar.ts`): Stalwart sends no invitation for an event that has begun.
- Tag a phone-only test `@phone` in its title. If a test cannot pass on one engine, skip it there with the reason in the call, and add it to `docs/beta-audit.md`.
- `e2e/a11y.spec.ts` runs axe on every main screen. A new screen belongs in its list.

## Conventions

- **JMAP only.** oinbox talks to Stalwart through JMAP and OAuth and nothing else.
- **rozie.js for components.** Where a rozie component exists (dialogs, popovers, toasts, combobox, date picker, the editor, the calendar), use it. If it falls short, write the gap down in `docs/rozie-feedback.md` and fix it there; do not work around it here.
- **No telemetry, no third-party requests.** The Content-Security-Policy enforces the second; please keep to the first.
- **Text people read** (labels, messages, errors) is plain and specific. Say what happened and what to do.
- Comments explain why, not what.
- Commit messages say what changed for the user, in the imperative or as a plain statement, with the area first when it helps ("Calendar: …").

## Reporting bugs

Include the version from the bottom of Settings, the browser, and the Stalwart version. For anything touching security, see `SECURITY.md` and report privately.

## License

By contributing you agree that your work is released under the MIT license in `LICENSE`.
