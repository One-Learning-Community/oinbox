# Beta Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make oinbox survive its own bugs and bad networks, audit it by keyboard, screen reader, phone and a 50,000-message mailbox, and package a `0.1.0-beta.1` release another Stalwart operator can install.

**Architecture:** Three phases. Phase 1 adds error boundaries, a connection-status store fed by the JMAP client and the push stream, composer safety, a wider test matrix and a version stamp. Phase 2 runs four audits into `docs/beta-audit.md` and stops for the user. Phase 3 fixes blockers and majors, then writes docs, a production template and a release workflow.

**Tech Stack:** SolidJS 1.9, Vite 8, Vitest 5 (jsdom), Playwright 1.63, `@axe-core/playwright`, rozie.js components, Stalwart 0.16.23, Caddy 2.11, Docker Compose, GitHub Actions, Python 3.13 (stdlib only) for seeding.

**Spec:** `docs/superpowers/specs/2026-10-07-beta-readiness-design.md`

## Global Constraints

- Branch: `beta-readiness`. Nothing is pushed, tagged or made public by the implementer.
- JMAP only; no new runtime dependency. The only new dev dependency is `@axe-core/playwright`.
- No telemetry: errors are shown and logged to the console; nothing is sent anywhere.
- UI uses rozie components where one exists. A rozie defect that blocks a main flow stops the work; it is not worked around. Findings go in `docs/rozie-feedback.md`.
- e2e helpers never wait on subject searches (Stalwart's full-text index lags); wait on ids or thread membership.
- Exact copy: "This part of oinbox hit a problem." / "Try again" / "oinbox hit a problem and needs to reload." / "Reload" / "Something went wrong. If things look off, reload." / "oinbox was updated. Reload to continue." / "Can't reach the server. Retrying…" / "Retry now" / "You've been signed out." / "Sign in again" / "Couldn't send. Your message is still here." / "Retry".
- Connection thresholds: banner after two transport failures in a row or one lasting 3 s; API timeout 30 s; uploads and downloads have no timeout.
- Rescue key: `oinbox.rescue.<accountId>.<composerId>`; expiry 7 days; removed on explicit Sign out.
- Phone size 390×844 (WebKit, touch); touch targets at least 44px.
- Version: `0.1.0-beta.1`.
- Commit messages follow the repo's style ("Beta readiness: …") and end with the two attribution lines used on this branch.
- After every task: `pnpm test` and `pnpm typecheck` pass. e2e commands assume the stack is up with the local-dist override and `pnpm build` has run.

## Review Focus

1. **A send that timed out but reached the server.** Retrying must not send twice or delete the sent copy. Expected: the retry finds the message is no longer a draft and reports "Message sent." (Task 6 test.)
2. **`localStorage` full or blocked (private mode) during rescue.** Expected: sign-out handling continues; nothing throws. (Task 7 test.)
3. **An error whose value is not an `Error`** (a thrown string, `null`, an object without `message`). Expected: the fallback and the toast still render. (Task 3 test.)
4. **Flapping connection** (fail, succeed, fail, succeed every second). Expected: no banner flicker and no toast storm. (Task 4 test.)
5. **A fallback that itself throws**, or a boundary error while a dialog is open. Expected: the root fallback shows; the page is never blank. (Task 3 test.)

---

# Phase 1: known work

### Task 1: Version stamp

**Files:**
- Modify: `package.json`, `vite.config.ts`, `src/vite-env.d.ts`, `Dockerfile`, `deploy/docker-compose.yml`, `src/ui/SettingsView.tsx`, `src/ui/styles.css`
- Create: `src/app/version.ts`, `src/app/version.test.ts`

**Interfaces:**
- Produces: `VERSION: string`, `COMMIT: string`, `versionLabel(): string` from `src/app/version.ts`.

- [ ] **Step 1: Failing test** — `src/app/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { COMMIT, VERSION, versionLabel } from './version';

describe('version', () => {
  it('takes the version from package.json', () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toBe('0.1.0-beta.1');
  });
  it('labels the build with version and commit', () => {
    expect(COMMIT).toMatch(/^[0-9a-f]{7,}$|^unknown$/);
    expect(versionLabel()).toBe(`oinbox ${VERSION} (${COMMIT})`);
  });
});
```

Add `"resolveJsonModule": true` to `tsconfig.app.json` if the import fails to type-check.

- [ ] **Step 2:** `pnpm test src/app/version.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement.**

`package.json`: `"version": "0.1.0-beta.1"`.

`vite.config.ts` (top of file and in `defineConfig`):

```ts
import { execSync } from 'node:child_process';
import pkg from './package.json' with { type: 'json' };

function commit(): string {
  if (process.env.OINBOX_COMMIT) return process.env.OINBOX_COMMIT.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}
// in defineConfig({...}):
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __APP_COMMIT__: JSON.stringify(commit()) },
```

`src/vite-env.d.ts`: add `declare const __APP_VERSION__: string; declare const __APP_COMMIT__: string;`

`src/app/version.ts`:

```ts
export const VERSION = __APP_VERSION__;
export const COMMIT = __APP_COMMIT__;
export const versionLabel = (): string => `oinbox ${VERSION} (${COMMIT})`;
```

`Dockerfile`, build stage, before `RUN pnpm build`: `ARG OINBOX_COMMIT=unknown` and `ENV OINBOX_COMMIT=$OINBOX_COMMIT`. `deploy/docker-compose.yml` `caddy.build`: `args: { OINBOX_COMMIT: "${OINBOX_COMMIT:-unknown}" }`.

`SettingsView`: after `<VacationForm />` add `<p class="settings-version">{versionLabel()}</p>`; CSS `.settings-version { margin-top: 32px; color: var(--muted); font-size: 12px; }` (use the existing muted colour variable name from `styles.css`).

- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm build` → PASS.
- [ ] **Step 5: Commit** "Beta readiness: version stamp in Settings and the build".

### Task 2: Fix the invited-event fixture

**Files:**
- Modify: `e2e/support/calendar.ts`, `e2e/calendar-edit.spec.ts`, `e2e/calendar-invite.spec.ts` (only if it uses `todayIn(...)T..` for an invited event)

**Interfaces:**
- Produces: `futureStart(timeZone: string, hour?: number): { start: string; date: string; inThisWeek: boolean }` in `e2e/support/calendar.ts`.

- [ ] **Step 1: Add the helper** next to `todayIn`:

```ts
/**
 * A start that is always in the future: `hour`:00 tomorrow in `timeZone`. Stalwart sends no
 * invitation for an event that has already started, so invited fixtures must not use today.
 * `inThisWeek` is false when tomorrow is a Sunday, the first day of the next week view.
 */
export function futureStart(timeZone: string, hour = 10): { start: string; date: string; inThisWeek: boolean } {
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(tomorrow);
  return { start: `${date}T${String(hour).padStart(2, '0')}:00:00`, date, inThisWeek: weekday !== 'Sun' };
}
```

- [ ] **Step 2: Use it** in "a recurring event and an invited event are read-only, with a reason": replace `` `${todayIn(TZ)}T17:00:00` `` with `when.start` where `const when = futureStart(TZ);`. After `await page.keyboard.press('Escape');` add:

```ts
if (!when.inThisWeek) await page.getByRole('button', { name: /next/i }).click();
```

(Use the accessible name FullCalendar's next button has in `CalendarView`'s toolbar; read it from the page if `next` does not match.) Apply the same replacement to every other `createInvitedEvent(..., todayIn(...))` call found by `grep -n "createInvitedEvent" e2e/*.spec.ts`.

- [ ] **Step 3: Prove it at the failing hour.** Run once normally and once with the browser and Node clocks past 17:00 New York: `TZ=Pacific/Kiritimati pnpm exec playwright test e2e/calendar-edit.spec.ts --project=chromium -g "read-only"` (UTC+14 puts "now" after 17:00 New York for most of the day). Both PASS.
- [ ] **Step 4: Commit** "Beta readiness: invited-event fixture starts in the future".

### Task 3: Error boundaries

**Files:**
- Create: `src/app/errors.ts`, `src/app/errors.test.ts`, `src/ui/PaneBoundary.tsx`, `src/ui/PaneBoundary.test.tsx`, `src/ui/RootFallback.tsx`, `src/ui/RootFallback.test.tsx`, `e2e/boundary.spec.ts`
- Modify: `src/index.tsx`, `src/ui/Shell.tsx`, `src/ui/Conversation.tsx`, `src/ui/styles.css`

**Interfaces:**
- Consumes: `versionLabel()` (Task 1); `ToastFn` from `src/app/actions`.
- Produces from `src/app/errors.ts`:
  - `errorMessage(e: unknown): string`
  - `errorDetails(e: unknown): string` (message, up to five stack lines, version label)
  - `isChunkLoadError(e: unknown): boolean`
  - `createErrorReporter(toast: ToastFn, now?: () => number): { report(e: unknown, where: string): void; install(target: Window, isHandled: (e: unknown) => boolean): () => void }`
- Produces: `<PaneBoundary name="…" silent? report?>`, `<RootFallback error={…} />`.

- [ ] **Step 1: Failing tests.**

`src/app/errors.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createErrorReporter, errorDetails, errorMessage, isChunkLoadError } from './errors';

describe('errorMessage', () => {
  it('reads any thrown value', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(null)).toBe('Unknown error');
    expect(errorMessage({ nope: 1 })).toBe('Unknown error');
    expect(errorMessage(new Error(''))).toBe('Unknown error');
  });
});

describe('errorDetails', () => {
  it('ends with the version label', () => {
    expect(errorDetails(new Error('boom'))).toMatch(/^boom\n[\s\S]*oinbox 0\.1\.0-beta\.1 \(/);
  });
});

describe('isChunkLoadError', () => {
  it('recognises failed dynamic imports across engines', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });
});

describe('createErrorReporter', () => {
  it('shows at most one toast every 10 seconds but logs every error', () => {
    const toast = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let t = 0;
    const r = createErrorReporter(toast, () => t);
    r.report(new Error('a'), 'x');
    r.report(new Error('b'), 'x');
    t = 10_001;
    r.report(new Error('c'), 'x');
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith('Something went wrong. If things look off, reload.', 'error', expect.anything());
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });

  it('says the app was updated when a chunk fails to load', () => {
    const toast = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createErrorReporter(toast).report(new TypeError('Importing a module script failed.'), 'calendar');
    expect(toast).toHaveBeenCalledWith('oinbox was updated. Reload to continue.', 'error', expect.objectContaining({ label: 'Reload' }));
  });

  it('listens for window errors and rejections, skipping handled ones', () => {
    const toast = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = createErrorReporter(toast);
    const off = r.install(window, (e) => e === 'auth');
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'auth' }));
    expect(toast).not.toHaveBeenCalled();
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('x') }));
    expect(toast).toHaveBeenCalledTimes(1);
    off();
  });
});
```

`src/ui/PaneBoundary.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal, ErrorBoundary } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { PaneBoundary } from './PaneBoundary';
import { RootFallback } from './RootFallback';

function Bomb(props: { armed: () => boolean; value?: unknown }) {
  return <>{(() => { if (props.armed()) throw props.value ?? new Error('kaboom'); return <p>fine</p>; })()}</>;
}

describe('PaneBoundary', () => {
  it('shows a fallback for its pane only, and recovers on Try again', async () => {
    const report = vi.fn();
    const [armed, setArmed] = createSignal(true);
    render(() => (
      <>
        <p>sibling</p>
        <PaneBoundary name="list" report={report}><Bomb armed={armed} /></PaneBoundary>
      </>
    ));
    expect(screen.getByRole('alert')).toHaveTextContent('This part of oinbox hit a problem.');
    expect(screen.getByText('sibling')).toBeInTheDocument();
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'list');
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
    setArmed(false);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('fine')).toBeInTheDocument();
  });

  it('renders for a thrown value that is not an Error', () => {
    render(() => <PaneBoundary name="x" report={() => {}}><Bomb armed={() => true} value="just a string" /></PaneBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/just a string/)).toBeInTheDocument();
  });

  it('shows nothing when silent', () => {
    const { container } = render(() => <PaneBoundary name="invite" silent report={() => {}}><Bomb armed={() => true} /></PaneBoundary>);
    expect(container).toBeEmptyDOMElement();
  });

  it('lets the root fallback take over when reporting itself throws', () => {
    render(() => (
      <ErrorBoundary fallback={(e) => <RootFallback error={e} />}>
        <PaneBoundary name="x" report={() => { throw new Error('reporter broke'); }}><Bomb armed={() => true} /></PaneBoundary>
      </ErrorBoundary>
    ));
    expect(screen.getByText('oinbox hit a problem and needs to reload.')).toBeInTheDocument();
  });
});
```

`src/ui/RootFallback.test.tsx`:

```tsx
import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { RootFallback } from './RootFallback';

describe('RootFallback', () => {
  it('offers Reload and the details, with no stylesheet classes', () => {
    const { container } = render(() => <RootFallback error={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('oinbox hit a problem and needs to reload.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByText(/Unknown error/)).toBeInTheDocument();
    expect(container.querySelector('[class]')).toBeNull();
  });
});
```

- [ ] **Step 2:** `pnpm test src/app/errors.test.ts src/ui/PaneBoundary.test.tsx src/ui/RootFallback.test.tsx` → FAIL (modules missing).

- [ ] **Step 3: Implement.**

`src/app/errors.ts`:

```ts
import type { ToastFn } from './actions';
import { versionLabel } from './version';

const TOAST_EVERY_MS = 10_000;

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || 'Unknown error';
  if (typeof e === 'string' && e) return e;
  return 'Unknown error';
}

/** What a user can paste into a bug report: message, the top of the stack, the build. */
export function errorDetails(e: unknown): string {
  const stack = e instanceof Error && e.stack ? e.stack.split('\n').slice(1, 6).map((l) => l.trim()) : [];
  return [errorMessage(e), ...stack, versionLabel()].join('\n');
}

/** A lazy chunk that is gone, usually because the server was upgraded under an open tab. */
export function isChunkLoadError(e: unknown): boolean {
  return /dynamically imported module|Importing a module script failed/i.test(errorMessage(e));
}

export function createErrorReporter(toast: ToastFn, now: () => number = Date.now) {
  let lastToast = -Infinity;
  const reload = { label: 'Reload', run: () => location.reload() };

  const report = (e: unknown, where: string): void => {
    console.error(`[${versionLabel()}] ${where}:`, e);
    if (now() - lastToast < TOAST_EVERY_MS) return;
    lastToast = now();
    if (isChunkLoadError(e)) toast('oinbox was updated. Reload to continue.', 'error', reload);
    else toast('Something went wrong. If things look off, reload.', 'error', reload);
  };

  /** Solid's boundaries don't see event handlers or rejected promises; these listeners do. */
  const install = (target: Window, isHandled: (e: unknown) => boolean): (() => void) => {
    const onError = (ev: Event) => report((ev as ErrorEvent).error ?? (ev as ErrorEvent).message, 'window');
    const onRejection = (ev: Event) => {
      const reason = (ev as PromiseRejectionEvent).reason;
      if (isHandled(reason)) return ev.preventDefault();
      report(reason, 'promise');
    };
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    return () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
    };
  };

  return { report, install };
}

export type ErrorReporter = ReturnType<typeof createErrorReporter>;
```

`ToastFn`'s action type has `{ label, run, forMs? }` (see `src/app/actions.ts`); match it.

`src/ui/PaneBoundary.tsx`:

```tsx
import { createSignal, ErrorBoundary, Show, useContext, type JSX } from 'solid-js';
import { AppContext } from '../app/context';
import { errorDetails } from '../app/errors';

/**
 * Keeps a fault inside one pane: the rest of the app stays usable.
 * `silent` panes (the invite card) show nothing, as a card must never get in the way of the mail.
 */
export function PaneBoundary(props: { name: string; silent?: boolean; report?: (e: unknown, where: string) => void; children: JSX.Element }) {
  const app = useContext(AppContext);
  return (
    <ErrorBoundary
      fallback={(err, reset) => {
        (props.report ?? app?.errors.report)?.(err, props.name);
        return (
          <Show when={!props.silent}>
            <PaneFallback error={err} reset={reset} />
          </Show>
        );
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}

function PaneFallback(props: { error: unknown; reset: () => void }) {
  const [copied, setCopied] = createSignal(false);
  const details = errorDetails(props.error);
  return (
    <div class="pane-fallback" role="alert">
      <p>This part of oinbox hit a problem.</p>
      <button type="button" class="btn" onClick={props.reset}>Try again</button>
      <details>
        <summary>Details</summary>
        <pre>{details}</pre>
        <button type="button" class="btn-text" onClick={() => void navigator.clipboard?.writeText(details).then(() => setCopied(true))}>
          {copied() ? 'Copied' : 'Copy'}
        </button>
      </details>
    </div>
  );
}
```

`src/ui/RootFallback.tsx` (plain elements, inline styles, system colours so it reads in both themes without the stylesheet):

```tsx
import { errorDetails } from '../app/errors';

/** Last resort. No app context, no rozie, no stylesheet classes: any of those may be what failed. */
export function RootFallback(props: { error: unknown }) {
  return (
    <div role="alert" style={{ 'max-width': '520px', margin: '15vh auto', padding: '24px', font: '16px/1.5 system-ui, sans-serif', color: 'CanvasText', background: 'Canvas' }}>
      <p style={{ 'font-size': '18px', margin: '0 0 16px' }}>oinbox hit a problem and needs to reload.</p>
      <button type="button" style={{ font: 'inherit', padding: '8px 20px', 'min-height': '44px' }} onClick={() => location.reload()}>Reload</button>
      <details style={{ 'margin-top': '24px' }}>
        <summary>Details</summary>
        <pre style={{ 'white-space': 'pre-wrap', 'font-size': '12px' }}>{errorDetails(props.error)}</pre>
      </details>
    </div>
  );
}
```

`src/app/context.tsx`: add `errors: ErrorReporter;` to `App`.

`src/index.tsx`:
- After `const toasts = createToasts();`: `const errors = createErrorReporter(toasts.toast);`
- Replace the existing `unhandledrejection` listener with `errors.install(window, onAuthError);` (`onAuthError` already returns true when it handled the error).
- Add `errors,` to `app`.
- Wrap the rendered tree: `<ErrorBoundary fallback={(e) => { console.error(e); return <RootFallback error={e} />; }}>` around `<AppContext.Provider>`.
- Routes: wrap `CalendarView` and `SettingsView` route components: `component={() => <PaneBoundary name="calendar">{app.hasCalendars() ? <CalendarView /> : <Navigate href="/inbox" />}</PaneBoundary>}` and `component={() => <PaneBoundary name="settings"><SettingsView /></PaneBoundary>}`.
- Last line: `void boot().catch((e) => { console.error(e); root.textContent = ''; render(() => <RootFallback error={e} />, root); });`

`src/ui/Shell.tsx`: wrap `<Sidebar … />` in `<PaneBoundary name="sidebar">`, `<ComposeDock />` in `<PaneBoundary name="composer">`; in `MailView` wrap `<ThreadList …/>` in `<PaneBoundary name="thread list">` and `<Conversation …/>` in `<PaneBoundary name="conversation">`.

`src/ui/Conversation.tsx` (around line 300): `<PaneBoundary name="invite card" silent><InviteCard email={props.email} /></PaneBoundary>` and `<PaneBoundary name="message"><MessageBody email={props.email} /></PaneBoundary>`. Wrap the inline composer the same way with `name="composer"` where `Conversation` renders it.

`styles.css`:

```css
/* ---- Error fallback for one pane ---- */
.pane-fallback { margin: 24px; padding: 16px; border: 1px solid var(--border); border-radius: 8px; }
.pane-fallback p { margin: 0 0 12px; }
.pane-fallback details { margin-top: 12px; }
.pane-fallback pre { white-space: pre-wrap; font-size: 12px; max-height: 160px; overflow: auto; }
@media (pointer: coarse) { .pane-fallback .btn { min-height: 44px; } }
```

(Use the border variable and button classes that exist in `styles.css`; add `.btn-text` only if no text-button class exists.)

- [ ] **Step 4:** `pnpm test && pnpm typecheck` → PASS. Fix any existing test that builds an `App` object by adding `errors`.

- [ ] **Step 5: e2e** — `e2e/boundary.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { openInbox, rows } from './support/app';

test('a calendar chunk that fails to load leaves mail usable', async ({ page }) => {
  await page.route(/\/assets\/CalendarView-[^/]+\.js$/, (route) => route.fulfill({ status: 404, body: 'gone' }));
  await openInbox(page);
  await page.goto('/calendar');
  await expect(page.getByRole('alert').filter({ hasText: 'This part of oinbox hit a problem.' })).toBeVisible();
  await expect(page.getByText('oinbox was updated. Reload to continue.')).toBeVisible();
  // The shell and mail still work.
  await page.getByRole('link', { name: /^Inbox/ }).click();
  await expect(rows(page).first()).toBeVisible();
  await rows(page).first().click();
  await expect(page.locator('.conversation, [data-conversation]').first()).toBeVisible();
});
```

Adjust the two locators at the end to the classes `Conversation` actually renders. If a rejected `lazy()` import is not caught by the pane boundary (no `<Suspense>` in the tree), add `<Suspense>` inside the calendar route's `PaneBoundary` and note it in the commit.

Run: `pnpm build && pnpm exec playwright test e2e/boundary.spec.ts --project=chromium` → PASS.

- [ ] **Step 6: Commit** "Beta readiness: error boundaries per pane and at the root".

### Task 4: Connection store

**Files:**
- Create: `src/sync/connection.ts`, `src/sync/connection.test.ts`

**Interfaces:**
- Consumes: `RequestError`, `UnauthorizedError` from `src/jmap/client`.
- Produces:

```ts
export type ConnectionState = 'ok' | 'retrying' | 'signed-out';
export type ConnectionSource = 'request' | 'push';
export function isTransportFailure(e: unknown): boolean;
export function logUnexpected(e: unknown): void; // for background work: quiet on transport and auth failures
export interface Connection {
  state: Accessor<ConnectionState>;
  reportFailure(source: ConnectionSource, error: unknown): void;
  reportSuccess(source: ConnectionSource): void;
  signedOut(): void;
  /** Called on a backoff schedule while retrying, and at once by retryNow(). */
  onRetry(fn: () => void): () => void;
  /** Called on each retrying → ok transition. */
  onRecovered(fn: () => void): () => void;
  retryNow(): void;
}
export function createConnection(opts?: { graceMs?: number; failuresToShow?: number }): Connection;
```

- [ ] **Step 1: Failing test** — `src/sync/connection.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError, UnauthorizedError } from '../jmap/client';
import { createConnection, isTransportFailure } from './connection';

const net = () => new TypeError('Failed to fetch');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('isTransportFailure', () => {
  it('counts network errors, timeouts and gateway errors only', () => {
    expect(isTransportFailure(net())).toBe(true);
    expect(isTransportFailure(new RequestError(0, 'timeout'))).toBe(true);
    for (const s of [502, 503, 504]) expect(isTransportFailure(new RequestError(s, ''))).toBe(true);
    for (const s of [400, 403, 404, 413, 500]) expect(isTransportFailure(new RequestError(s, ''))).toBe(false);
    expect(isTransportFailure(new UnauthorizedError())).toBe(false);
    expect(isTransportFailure(new Error('Email/set failed: invalidArguments'))).toBe(false);
    expect(isTransportFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('createConnection', () => {
  it('ignores one blip', () => {
    const c = createConnection();
    c.reportFailure('request', net());
    expect(c.state()).toBe('ok');
    vi.advanceTimersByTime(2000);
    c.reportSuccess('request');
    vi.advanceTimersByTime(5000);
    expect(c.state()).toBe('ok');
  });

  it('shows after two failures in a row', () => {
    const c = createConnection();
    c.reportFailure('request', net());
    c.reportFailure('push', new Error('stream closed'));
    expect(c.state()).toBe('retrying');
  });

  it('shows after one failure that lasts 3 seconds', () => {
    const c = createConnection();
    c.reportFailure('push', new Error('stream closed'));
    vi.advanceTimersByTime(2999);
    expect(c.state()).toBe('ok');
    vi.advanceTimersByTime(1);
    expect(c.state()).toBe('retrying');
  });

  it('ignores request failures that are not transport failures', () => {
    const c = createConnection();
    c.reportFailure('request', new RequestError(400, 'bad'));
    c.reportFailure('request', new Error('method error'));
    vi.advanceTimersByTime(10_000);
    expect(c.state()).toBe('ok');
  });

  it('recovers on the first success and tells listeners once', () => {
    const c = createConnection();
    const recovered = vi.fn();
    c.onRecovered(recovered);
    c.reportFailure('request', net());
    c.reportFailure('request', net());
    c.reportSuccess('push');
    c.reportSuccess('request');
    expect(c.state()).toBe('ok');
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('does not flicker while the connection flaps', () => {
    const c = createConnection();
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      c.reportFailure('request', net());
      seen.push(c.state());
      vi.advanceTimersByTime(1000);
      c.reportSuccess('request');
      seen.push(c.state());
      vi.advanceTimersByTime(1000);
    }
    expect(new Set(seen)).toEqual(new Set(['ok']));
  });

  it('retries with capped backoff while retrying, and at once on retryNow', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    c.reportFailure('request', net());
    c.reportFailure('request', net());
    vi.advanceTimersByTime(1000);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(retry).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10 * 60_000);
    const calls = retry.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(20); // capped at 30 s
    expect(calls).toBeLessThanOrEqual(26);
    c.retryNow();
    expect(retry).toHaveBeenCalledTimes(calls + 1);
    c.reportSuccess('request');
    vi.advanceTimersByTime(60_000);
    expect(retry).toHaveBeenCalledTimes(calls + 1);
  });

  it('stays signed out whatever is reported afterwards', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    c.signedOut();
    c.reportSuccess('request');
    c.reportFailure('request', net());
    c.reportFailure('request', net());
    vi.advanceTimersByTime(60_000);
    expect(c.state()).toBe('signed-out');
    expect(retry).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2:** `pnpm test src/sync/connection.test.ts` → FAIL.

- [ ] **Step 3: Implement** `src/sync/connection.ts`:

```ts
import { createSignal, type Accessor } from 'solid-js';
import { RequestError, UnauthorizedError } from '../jmap/client';

export type ConnectionState = 'ok' | 'retrying' | 'signed-out';
export type ConnectionSource = 'request' | 'push';

const GRACE_MS = 3000;
const FAILURES_TO_SHOW = 2;
const RETRY_CAP_MS = 30_000;

/** The request never got a usable answer: network down, timed out, or the proxy couldn't reach Stalwart. */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof RequestError) return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
  // fetch() rejects with a TypeError when the network fails; an abort is the caller's own doing.
  return e instanceof TypeError;
}

/** For background work whose failure has nowhere to go: transport and auth failures are handled elsewhere. */
export function logUnexpected(e: unknown): void {
  if (isTransportFailure(e) || e instanceof UnauthorizedError) return;
  console.error('[oinbox]', e);
}

export interface Connection {
  state: Accessor<ConnectionState>;
  reportFailure(source: ConnectionSource, error: unknown): void;
  reportSuccess(source: ConnectionSource): void;
  signedOut(): void;
  onRetry(fn: () => void): () => void;
  onRecovered(fn: () => void): () => void;
  retryNow(): void;
}

export function createConnection(opts: { graceMs?: number; failuresToShow?: number } = {}): Connection {
  const graceMs = opts.graceMs ?? GRACE_MS;
  const failuresToShow = opts.failuresToShow ?? FAILURES_TO_SHOW;
  const [state, setState] = createSignal<ConnectionState>('ok');
  const retryFns = new Set<() => void>();
  const recoveredFns = new Set<() => void>();
  let failures = 0;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      attempt++;
      for (const fn of retryFns) fn();
      if (state() === 'retrying') scheduleRetry();
    }, Math.min(RETRY_CAP_MS, 1000 * 2 ** attempt));
  };

  const show = () => {
    clearTimeout(grace);
    grace = undefined;
    if (state() !== 'ok') return;
    setState('retrying');
    attempt = 0;
    scheduleRetry();
  };

  const stopTimers = () => {
    clearTimeout(grace);
    clearTimeout(retryTimer);
    grace = retryTimer = undefined;
  };

  return {
    state,
    reportFailure(source, error) {
      if (state() === 'signed-out') return;
      // A dropped push stream is a transport failure whatever the error looks like.
      if (source === 'request' && !isTransportFailure(error)) return;
      failures++;
      if (failures >= failuresToShow) show();
      else grace ??= setTimeout(show, graceMs);
    },
    reportSuccess() {
      if (state() === 'signed-out') return;
      failures = 0;
      const was = state();
      stopTimers();
      if (was === 'retrying') {
        setState('ok');
        for (const fn of recoveredFns) fn();
      }
    },
    signedOut() {
      stopTimers();
      setState('signed-out');
    },
    onRetry(fn) {
      retryFns.add(fn);
      return () => retryFns.delete(fn);
    },
    onRecovered(fn) {
      recoveredFns.add(fn);
      return () => recoveredFns.delete(fn);
    },
    retryNow() {
      if (state() !== 'retrying') return;
      attempt = 0;
      for (const fn of retryFns) fn();
      scheduleRetry();
    },
  };
}
```

- [ ] **Step 4:** `pnpm test src/sync/connection.test.ts` → PASS. If the backoff-count assertion is off by the first intervals, fix the bounds to the real count (1+2+4+8+16 s, then every 30 s) rather than the implementation.
- [ ] **Step 5: Commit** "Beta readiness: connection status store".

### Task 5: Wire connection status and show the banner

**Files:**
- Modify: `src/jmap/client.ts`, `src/jmap/client.test.ts` (create if absent), `src/jmap/sse.ts`, `src/jmap/sse.test.ts`, `src/sync/engine.ts`, `src/index.tsx`, `src/app/context.tsx`, `src/ui/Shell.tsx`, `src/ui/styles.css`
- Create: `src/ui/ConnectionBanner.tsx`, `src/ui/ConnectionBanner.test.tsx`

**Interfaces:**
- Consumes: `Connection`, `logUnexpected` (Task 4).
- Produces:
  - `JmapClientOptions.onOutcome?: (error: unknown | null) => void` — called once per request attempt; `null` for an answer from Stalwart.
  - `PushOptions.onDisconnected?: (error: unknown) => void`.
  - `openPushStream(...)` returns `{ close(): void; wake(): void }` (was a close function).
  - `App.connection: Connection`, `App.signIn(): void`.
  - `<ConnectionBanner connection={…} onSignIn={…} />`.

- [ ] **Step 1: Failing tests.**

Client (add to the client's test file, using the `fetch` option):

```ts
import { describe, expect, it, vi } from 'vitest';
import { JmapClient, RequestError } from './client';

const make = (fetchImpl: typeof fetch, onOutcome = vi.fn(), timeoutMs = 30_000) =>
  ({ client: new JmapClient({ sessionUrl: 'http://x/session', getToken: async () => 't', fetch: fetchImpl, onOutcome, timeoutMs }), onOutcome });

describe('JmapClient outcomes', () => {
  it('reports an answer as success, even a 4xx', async () => {
    const { client, onOutcome } = make(async () => new Response('no', { status: 400 }));
    await client.authFetch('http://x/a');
    expect(onOutcome).toHaveBeenCalledWith(null);
  });
  it('reports a network failure and rethrows it', async () => {
    const err = new TypeError('Failed to fetch');
    const { client, onOutcome } = make(async () => { throw err; });
    await expect(client.authFetch('http://x/a')).rejects.toBe(err);
    expect(onOutcome).toHaveBeenCalledWith(err);
  });
  it('reports 502, 503 and 504 as failures', async () => {
    for (const status of [502, 503, 504]) {
      const { client, onOutcome } = make(async () => new Response('', { status }));
      await client.authFetch('http://x/a');
      expect(onOutcome.mock.calls[0]![0]).toBeInstanceOf(RequestError);
    }
  });
  it('reports a timeout as a RequestError with status 0', async () => {
    const hang: typeof fetch = (_u, init) => new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    const { client, onOutcome } = make(hang, vi.fn(), 20);
    await expect(client.authFetch('http://x/a')).rejects.toMatchObject({ status: 0 });
    expect(onOutcome.mock.calls[0]![0]).toMatchObject({ status: 0 });
  });
  it('does not report a caller abort', async () => {
    const ac = new AbortController();
    const hang: typeof fetch = (_u, init) => new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const { client, onOutcome } = make(hang);
    const p = client.authFetch('http://x/a', { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(onOutcome).not.toHaveBeenCalled();
  });
  it('gives uploads no timeout', async () => {
    let signal: AbortSignal | undefined;
    const { client } = make(async (_u, init) => { signal = init!.signal!; return Response.json({ accountId: 'a', blobId: 'b', type: 't', size: 1 }); }, vi.fn(), 5);
    client.useSession({ uploadUrl: 'http://x/up/{accountId}', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' } } as never);
    await client.upload(new Blob(['x']));
    await new Promise((r) => setTimeout(r, 20));
    expect(signal!.aborted).toBe(false);
  });
});
```

Push (add to `src/jmap/sse.test.ts`, following the fake-client pattern already there):

```ts
it('reports a dropped stream and reconnects at once when woken', async () => {
  let calls = 0;
  const client = {
    eventSourceUrl: () => 'http://x/es',
    authFetch: async () => {
      calls++;
      return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
    },
  } as unknown as JmapClient;
  const dropped = vi.fn();
  const push = openPushStream(client, { onStateChange: () => {}, onDisconnected: dropped });
  await vi.waitFor(() => expect(dropped).toHaveBeenCalledTimes(1));
  push.wake();
  await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
  push.close();
});
```

Update the two existing `const close = openPushStream(...)` uses in that file to `const { close } = …`.

Banner — `src/ui/ConnectionBanner.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from '../sync/connection';
import { ConnectionBanner } from './ConnectionBanner';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ConnectionBanner', () => {
  it('is absent while connected', () => {
    const { container } = render(() => <ConnectionBanner connection={createConnection()} onSignIn={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('announces retrying and retries on demand', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    render(() => <ConnectionBanner connection={c} onSignIn={() => {}} />);
    c.reportFailure('request', new TypeError('x'));
    c.reportFailure('request', new TypeError('x'));
    expect(screen.getByRole('status')).toHaveTextContent("Can't reach the server. Retrying…");
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(retry).toHaveBeenCalledTimes(1);
    c.reportSuccess('request');
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('offers sign-in when signed out', () => {
    const c = createConnection();
    const signIn = vi.fn();
    render(() => <ConnectionBanner connection={c} onSignIn={signIn} />);
    c.signedOut();
    expect(screen.getByRole('status')).toHaveTextContent("You've been signed out.");
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signIn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2:** run the three test files → FAIL.

- [ ] **Step 3: Implement.**

`src/jmap/client.ts`:
- `JmapClientOptions`: add `/** Once per attempt: null when Stalwart answered, else the transport failure. */ onOutcome?: (error: unknown | null) => void;`
- `authFetch`: add a fourth parameter and replace the fetch block:

```ts
  async authFetch(url: string, init: RequestInit = {}, retried = false, noTimeout = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await this.opts.getToken()}`);
    const own = !init.signal && !noTimeout;
    const signal = init.signal ?? (noTimeout ? undefined : AbortSignal.timeout(this.opts.timeoutMs ?? 30_000));
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      const timedOut = own && (e as Error).name === 'TimeoutError';
      const err = timedOut ? new RequestError(0, 'the mail server did not respond in time') : e;
      // An abort is the caller closing its own request, not a connection problem.
      if ((e as Error).name !== 'AbortError') this.opts.onOutcome?.(err);
      throw err;
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) this.opts.onOutcome?.(new RequestError(res.status, 'the mail server is unavailable'));
    else this.opts.onOutcome?.(null);
    if (res.status === 401) {
      if (!retried && (await this.opts.onUnauthorized?.())) return this.authFetch(url, init, true, noTimeout);
      throw new UnauthorizedError();
    }
    return res;
  }
```

- `upload` and `fetchBlob` call `this.authFetch(url, init, false, true)`. In the upload test the fetch receives no `signal`; change that test's last assertion to `expect(signal?.aborted ?? false).toBe(false)`.

`src/jmap/sse.ts`:
- `PushOptions`: add `/** The stream ended or could not be opened; a reconnect follows. */ onDisconnected?: (error: unknown) => void;`
- In `run`: after the read loop ends (`done`), `throw new Error('push stream closed')` so both paths reach the `catch`; in the `catch`, after the `UnauthorizedError` branch, call `opts.onDisconnected?.(e)`.
- Make the backoff sleep wakeable and return an object:

```ts
  let wakeUp: (() => void) | null = null;
  // …in the loop, replacing the plain sleep:
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.5 + Math.random() / 2);
      await new Promise<void>((r) => {
        const t = setTimeout(r, delay);
        wakeUp = () => { clearTimeout(t); r(); };
      });
      wakeUp = null;
  // …
  return {
    close: () => { closed = true; controller?.abort(); wakeUp?.(); },
    /** Skip the rest of the backoff wait (the user pressed Retry, or the browser came back online). */
    wake: () => { attempt = 0; wakeUp?.(); },
  };
```

`src/sync/engine.ts`: import `logUnexpected` from `./connection`. Replace every `.catch(() => undefined)` on background work (lines near 204, 216, 268, 580, 827, 828 and any other found by `grep -n "catch(() => undefined)" src/sync/engine.ts`) with `.catch(logUnexpected)`. Line 826 `void this.catchUp();` becomes `void this.catchUp().catch(logUnexpected);`. Leave the two `await this.catchUp().catch(() => undefined)` in `deleteLabel` as `.catch(logUnexpected)` too. Then run `grep -rn "catch(() => undefined)\|catch(() => {})" src --include="*.ts" --include="*.tsx" | grep -v test` and convert the rest in `src/` the same way unless the surrounding comment explains why silence is right (keep those and list them in the commit message).

`src/ui/ConnectionBanner.tsx`:

```tsx
import { Match, Switch } from 'solid-js';
import type { Connection } from '../sync/connection';

export function ConnectionBanner(props: { connection: Connection; onSignIn: () => void }) {
  return (
    <Switch>
      <Match when={props.connection.state() === 'retrying'}>
        <p class="connection-banner" role="status">
          Can't reach the server. Retrying…
          <button type="button" class="btn-text" onClick={() => props.connection.retryNow()}>Retry now</button>
        </p>
      </Match>
      <Match when={props.connection.state() === 'signed-out'}>
        <p class="connection-banner" role="status">
          You've been signed out.
          <button type="button" class="btn-text" onClick={props.onSignIn}>Sign in again</button>
        </p>
      </Match>
    </Switch>
  );
}
```

CSS, next to `.vacation-banner` and modelled on it: `.connection-banner { … same box as .vacation-banner, warning colours … }` plus `@media (pointer: coarse) { .connection-banner button { min-height: 44px; } }`.

`src/ui/Shell.tsx`: inside `<main class="main">`, above the vacation banner: `<ConnectionBanner connection={app.connection} onSignIn={app.signIn} />`.

`src/app/context.tsx`: `connection: Connection; signIn: () => void;` on `App`.

`src/index.tsx`:

```ts
  const connection = createConnection();
  const client = new JmapClient({
    sessionUrl: `${origin}/.well-known/jmap`,
    getToken: () => auth.getToken(),
    onUnauthorized: () => auth.renew(),
    onOutcome: (e) => (e === null ? connection.reportSuccess('request') : connection.reportFailure('request', e)),
  });
```

`getToken()` can itself fail on the network during a refresh; `tokenRequest` only signs out on a non-OK *response*, so a rejected `fetch` there surfaces as a `TypeError` through `authFetch`'s caller. Wrap it: `getToken: () => auth.getToken().catch((e) => { connection.reportFailure('request', e); throw e; })`.

Session loss (replaces the direct `signOut()` calls made for auth errors; Task 7 adds the rescue):

```ts
  const sessionLost = () => {
    if (connection.state() === 'signed-out') return;
    const user = client.hasSession ? client.session.username : null;
    auth.signOut();
    recipients.stop();
    push?.close();
    if (user) void clearCache(user);
    connection.signedOut();
  };
  const signIn = () => void auth.authorizationUrl(location.pathname + location.search).then((u) => location.assign(u));
```

`onAuthError` calls `sessionLost()` instead of `signOut()`. If the app has not rendered yet (cold start), keep the existing behaviour: in the cold-start `catch`, an auth error calls `signOut()` (redirect to the sign-in card) as today.

Push:

```ts
  let push: { close(): void; wake(): void } | undefined;
  // in start():
    push = openPushStream(client, {
      onStateChange: …unchanged…,
      onConnected: () => {
        connection.reportSuccess('push');
        engine.setOnline(true);
        void engine.catchUp().catch(logUnexpected);
        void engine.refreshSettings().catch(logUnexpected);
        calendar.onConnected();
      },
      onDisconnected: (e) => {
        engine.setOnline(false);
        connection.reportFailure('push', e);
      },
      onUnauthorized: () => sessionLost(),
    });
  // after start is defined:
  connection.onRetry(() => {
    push?.wake();
    void engine.catchUp().catch(logUnexpected);
  });
  window.addEventListener('online', () => connection.retryNow());
```

A warm start whose `start()` fails on the network currently toasts "Couldn't reach the mail server" and never retries. Replace that `catch` with: if not an auth error and `isTransportFailure(e)`, do nothing more than `connection.onRecovered`-driven retry: register `const off = connection.onRetry(() => void start().then(off).catch(logUnexpected))` so the session and push come up once the server is back; any other error still toasts. Add `connection, signIn,` to `app`.

- [ ] **Step 4:** `pnpm test && pnpm typecheck` → PASS (fix `App` fakes in tests by adding `connection: createConnection(), signIn: () => {}`).
- [ ] **Step 5: Manual check.** `pnpm build`, open the app, `docker compose -f deploy/docker-compose.yml stop stalwart`: banner within about 5 s, loaded threads still open. `start stalwart`: banner clears with no reload and the status dot goes green.
- [ ] **Step 6: Commit** "Beta readiness: connection banner, fed by the JMAP client and the push stream".

### Task 6: The composer never loses text

**Files:**
- Modify: `src/app/composer.ts`, `src/app/composer.test.ts`, `src/sync/engine.ts`, `src/sync/engine.test.ts`, `src/sync/fake-jmap.ts` (only if `Email/get` of a destroyed id needs `notFound`), `src/ui/ComposerView.tsx`, `src/index.tsx`

**Interfaces:**
- Consumes: `Connection.onRecovered` (Task 4).
- Produces:
  - `MailEngine.draftState(id: Id): Promise<'draft' | 'sent' | 'gone'>`
  - `createComposers(engine, client, toast, confirm, onSent, onRecovered?: (fn: () => void) => void)`
  - `Composers.retrySave(c: Composer): void`
  - `Composers.snapshot(): RescuedComposer[]` and `Composers.restore(items: RescuedComposer[]): void` (used by Task 7)
  - `export interface RescuedComposer { mode: ComposeMode; draft: Draft; draftId: Id | null; identityId: Id | null; threadId: Id | null; replyTo: Id | null; signatureMode: SignatureMode }`

- [ ] **Step 1: Failing tests.** Follow the setup already used in `src/app/composer.test.ts` (engine on the JMAP fake, a `toast` spy, a `confirm` stub). Add:

```ts
describe('a failed send', () => {
  it('reopens the composer with its text and offers Retry', async () => {
    const { composers, engine, toast } = setup();
    const c = composers.open('new');
    c.update({ to: [{ name: null, email: 'bob@example.test' }], subject: 'Hello', bodyHtml: '<p>keep me</p>' });
    vi.spyOn(engine, 'sendDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.spyOn(engine, 'draftState').mockResolvedValue('draft');
    await composers.send(c);
    await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
    expect(composers.list()).toHaveLength(1);
    expect(composers.list()[0]!.draft().bodyHtml).toBe('<p>keep me</p>');
    expect(toast).toHaveBeenCalledWith("Couldn't send. Your message is still here.", 'error', expect.objectContaining({ label: 'Retry' }));
  });

  it('does not send twice when the first send reached the server', async () => {
    const { composers, engine, toast } = setup();
    const c = composers.open('new');
    c.update({ to: [{ name: null, email: 'bob@example.test' }], subject: 'Once' });
    const send = vi.spyOn(engine, 'sendDraft').mockRejectedValueOnce(new RequestError(0, 'timeout'));
    vi.spyOn(engine, 'draftState').mockResolvedValue('sent');
    await composers.send(c);
    await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
    expect(composers.list()).toHaveLength(0);
    expect(toast).toHaveBeenLastCalledWith('Message sent.', 'success');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('checks again before the reopened composer saves, when the first check could not run', async () => {
    const { composers, engine, toast } = setup();
    const c = composers.open('new');
    c.update({ to: [{ name: null, email: 'bob@example.test' }], subject: 'Maybe' });
    vi.spyOn(engine, 'sendDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const state = vi.spyOn(engine, 'draftState').mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue('sent');
    const save = vi.spyOn(engine, 'saveDraft');
    await composers.send(c);
    await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
    const reopened = composers.list()[0]!;
    const saves = save.mock.calls.length;
    await composers.send(reopened);
    expect(state).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(saves); // never destroyed the sent copy
    expect(composers.list()).toHaveLength(0);
    expect(toast).toHaveBeenLastCalledWith('Message sent.', 'success');
  });
});

describe('a failed save', () => {
  it('keeps the composer open on close unless the user confirms', async () => {
    const { composers, engine, confirm } = setup();
    const c = composers.open('new');
    c.update({ subject: 'unsaved' });
    vi.spyOn(engine, 'saveDraft').mockRejectedValue(new TypeError('Failed to fetch'));
    confirm.mockResolvedValueOnce(false);
    await composers.close(c);
    expect(composers.list()).toHaveLength(1);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Close without saving?' }));
    confirm.mockResolvedValueOnce(true);
    await composers.close(c);
    expect(composers.list()).toHaveLength(0);
  });

  it('saves again by itself when the connection returns', async () => {
    let recovered = () => {};
    const { composers, engine } = setup({ onRecovered: (fn: () => void) => (recovered = fn) });
    const c = composers.open('new');
    const save = vi.spyOn(engine, 'saveDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    c.update({ subject: 'later' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.status()).toBe('error');
    recovered();
    await vi.waitFor(() => expect(c.status()).toBe('saved'));
    expect(save).toHaveBeenCalledTimes(2);
  });
});
```

Engine (`src/sync/engine.test.ts`, with the fake):

```ts
describe('draftState', () => {
  it('tells a draft from a sent message from a deleted one', async () => {
    const { engine } = await startedEngine();
    const drafts = engine.mailboxByRole('drafts')!.id;
    const saved = await engine.saveDraft({ mailboxIds: { [drafts]: true }, keywords: { $draft: true }, subject: 's' }, null);
    expect(await engine.draftState(saved.id)).toBe('draft');
    await engine.setKeyword([saved.id], '$draft', false); // use the engine's or the fake's own way to clear a keyword
    expect(await engine.draftState(saved.id)).toBe('sent');
    await engine.destroyEmails([saved.id]);
    expect(await engine.draftState(saved.id)).toBe('gone');
  });
});
```

(Use whatever helper the existing engine tests use to start an engine and to change a keyword.)

- [ ] **Step 2:** run both files → FAIL.

- [ ] **Step 3: Implement.**

`engine.ts`, after `sendDraft`:

```ts
  /** Whether a message we tried to send is still a draft. A send can reach the server and still look failed here. */
  async draftState(id: Id): Promise<'draft' | 'sent' | 'gone'> {
    const b = this.client.batch();
    const call = b.call('Email/get', { accountId: this.accountId, ids: [id], properties: ['keywords'] });
    const email = (await this.client.send(b)).get(call).list[0];
    if (!email) return 'gone';
    return email.keywords?.$draft ? 'draft' : 'sent';
  }
```

`composer.ts`:
- Export `RescuedComposer` (shape above). `Restore` gains `unconfirmedSend?: boolean`.
- In `create`: `let unconfirmedSend = restore?.unconfirmedSend ?? false;` and at the top of `doSave`:

```ts
      if (unconfirmedSend && draftId()) {
        // The last send may have gone through; saving would destroy the sent copy.
        const state = await engine.draftState(draftId()!);
        if (state === 'sent') throw new AlreadySentError();
        if (state === 'gone') setDraftId(null);
        unconfirmedSend = false;
      }
```

with `class AlreadySentError extends Error {}` at module level. Expose `snapshot(): RescuedComposer` on the internal composer type (`{ mode, draft: draft(), draftId: draftId(), identityId: identityId(), threadId: composer.threadId, replyTo: composer.replyTo, signatureMode: signatureMode() }`).
- `send`: wrap the pre-send save:

```ts
    try {
      await internals(c).save();
    } catch (e) {
      if (e instanceof AlreadySentError) {
        remove(c);
        toast('Message sent.', 'success');
        return;
      }
      toast("Couldn't send. Your message is still here.", 'error', { label: 'Retry', run: () => void send(c) });
      return;
    }
```

and the delayed send's `catch`:

```ts
      } catch (e) {
        // The request may have reached the server even though we saw it fail.
        const state = await engine.draftState(draftId).catch(() => null);
        if (state === 'sent') {
          onSent(draftId, [...d.to, ...d.cc, ...d.bcc]);
          toast('Message sent.', 'success');
          return;
        }
        const reopened = create(c.mode, null, { ...snapshot, draftId: state === 'gone' ? null : draftId, unconfirmedSend: state === null });
        setList([...list(), reopened]);
        toast("Couldn't send. Your message is still here.", 'error', { label: 'Retry', run: () => void send(reopened) });
      }
```

- `close`:

```ts
  const close = async (c: Composer) => {
    if (c.status() === 'dirty' || c.status() === 'error') {
      try {
        await internals(c).save();
      } catch (e) {
        if (e instanceof AlreadySentError) return remove(c);
        const ok = await confirm({ title: 'Close without saving?', message: "The draft couldn't be saved, so your latest changes will be lost.", confirmLabel: 'Close anyway' });
        if (!ok) return;
        remove(c);
        return;
      }
      toast('Draft saved.');
    }
    remove(c);
  };
```

- `retrySave = (c) => void internals(c).save().catch(() => undefined);` and, in `createComposers`, `onRecovered?.(() => { for (const c of list()) if (c.status() === 'error') retrySave(c); });`
- `snapshot = () => list().filter((c) => c.status() !== 'idle' && c.status() !== 'saved').map((c) => internals(c).snapshot());`
- `restore = (items) => setList([...list(), ...items.map((r) => { const c = create(r.mode, null, r); internals(c).markDirty(); return c; })]);` where `markDirty` is `scheduleSave` exposed on the internal type, so a restored composer saves once it can.
- Return `{ list, open, close, discard, send, openDraft, identities, retrySave, snapshot, restore }`.

`ComposerView.tsx`: where the save status text renders (line ~22), show a Retry button when `c.status() === 'error'`:

```tsx
<Show when={c.status() === 'error'}>
  <button type="button" class="btn-text" onClick={() => composers.retrySave(c)}>Retry</button>
</Show>
```

and give the status element `role="status"` if it has none.

`index.tsx`: pass `(fn) => connection.onRecovered(fn)` as the sixth argument of `createComposers`.

- [ ] **Step 4:** `pnpm test && pnpm typecheck` → PASS. The existing compose e2e still passes: `pnpm build && pnpm exec playwright test e2e/compose.spec.ts --project=chromium`.
- [ ] **Step 5: Commit** "Beta readiness: a failed send or save keeps the composer and its text".

### Task 7: Draft rescue on sign-out

**Files:**
- Create: `src/app/rescue.ts`, `src/app/rescue.test.ts`
- Modify: `src/index.tsx`

**Interfaces:**
- Consumes: `RescuedComposer`, `Composers.snapshot()`, `Composers.restore()` (Task 6).
- Produces:

```ts
export function saveRescue(storage: Storage, accountId: string, items: RescuedComposer[], now?: number): void;
export function takeRescue(storage: Storage, accountId: string, now?: number): RescuedComposer[]; // returns and removes
export function clearRescue(storage: Storage): void; // every account
```

- [ ] **Step 1: Failing test** — `src/app/rescue.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { RescuedComposer } from './composer';
import { clearRescue, saveRescue, takeRescue } from './rescue';

const item = (subject: string): RescuedComposer => ({
  mode: 'new', draftId: null, identityId: 'i1', threadId: null, replyTo: null, signatureMode: 'auto',
  draft: { mode: 'new', to: [], cc: [], bcc: [], subject, inReplyTo: [], references: [], quoteHtml: '', signatureHtml: '', bodyHtml: '<p>x</p>', attachments: [] },
});
const DAY = 24 * 3600_000;

beforeEach(() => localStorage.clear());

describe('rescue', () => {
  it('stores one entry per composer under the account and hands them back once', () => {
    saveRescue(localStorage, 'acc1', [item('a'), item('b')], 1000);
    expect(Object.keys(localStorage).sort()).toEqual(['oinbox.rescue.acc1.0', 'oinbox.rescue.acc1.1']);
    expect(takeRescue(localStorage, 'acc1', 2000).map((r) => r.draft.subject)).toEqual(['a', 'b']);
    expect(takeRescue(localStorage, 'acc1', 2000)).toEqual([]);
  });
  it('keeps accounts apart', () => {
    saveRescue(localStorage, 'acc1', [item('mine')], 0);
    expect(takeRescue(localStorage, 'acc2', 0)).toEqual([]);
    expect(takeRescue(localStorage, 'acc1', 0)).toHaveLength(1);
  });
  it('drops entries older than 7 days, for any account', () => {
    saveRescue(localStorage, 'acc1', [item('old')], 0);
    saveRescue(localStorage, 'acc2', [item('old too')], 0);
    expect(takeRescue(localStorage, 'acc1', 7 * DAY + 1)).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
  it('clears everything on request and leaves other keys alone', () => {
    localStorage.setItem('oinbox.theme', 'dark');
    saveRescue(localStorage, 'acc1', [item('a')], 0);
    clearRescue(localStorage);
    expect(Object.keys(localStorage)).toEqual(['oinbox.theme']);
  });
  it('ignores entries it cannot read', () => {
    localStorage.setItem('oinbox.rescue.acc1.0', '{not json');
    expect(takeRescue(localStorage, 'acc1', 0)).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
  it('never throws when storage is full or blocked', () => {
    const blocked = { get length() { return 0; }, key: () => null, getItem: () => { throw new Error('denied'); }, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); }, removeItem: () => { throw new Error('denied'); }, clear: () => {} } as Storage;
    expect(() => saveRescue(blocked, 'a', [item('x')])).not.toThrow();
    expect(takeRescue(blocked, 'a')).toEqual([]);
    expect(() => clearRescue(blocked)).not.toThrow();
  });
});
```

- [ ] **Step 2:** `pnpm test src/app/rescue.test.ts` → FAIL.

- [ ] **Step 3: Implement** `src/app/rescue.ts`:

```ts
import type { RescuedComposer } from './composer';

const PREFIX = 'oinbox.rescue.';
const MAX_AGE_MS = 7 * 24 * 3600_000;

interface Stored { savedAt: number; composer: RescuedComposer }

function keys(storage: Storage): string[] {
  try {
    return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => !!k && k.startsWith(PREFIX));
  } catch {
    return [];
  }
}

function remove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Blocked storage: nothing to remove.
  }
}

/** Unsaved composer text, kept across an involuntary sign-out. Best effort: storage may be full or blocked. */
export function saveRescue(storage: Storage, accountId: string, items: RescuedComposer[], now = Date.now()): void {
  items.forEach((composer, i) => {
    try {
      storage.setItem(`${PREFIX}${accountId}.${i}`, JSON.stringify({ savedAt: now, composer } satisfies Stored));
    } catch {
      // Keep going: a smaller draft may still fit.
    }
  });
}

/** This account's rescued composers, removed as they are read. Expired entries of any account go too. */
export function takeRescue(storage: Storage, accountId: string, now = Date.now()): RescuedComposer[] {
  const out: RescuedComposer[] = [];
  for (const key of keys(storage).sort()) {
    let stored: Stored | null = null;
    try {
      stored = JSON.parse(storage.getItem(key) ?? 'null') as Stored | null;
    } catch {
      stored = null;
    }
    const mine = key.startsWith(`${PREFIX}${accountId}.`);
    const expired = !stored || now - stored.savedAt > MAX_AGE_MS;
    if (mine || expired) remove(storage, key);
    if (mine && !expired && stored) out.push(stored.composer);
  }
  return out;
}

export function clearRescue(storage: Storage): void {
  for (const key of keys(storage)) remove(storage, key);
}
```

`index.tsx`:
- In `sessionLost`, first line after the guard: `if (client.hasSession) saveRescue(localStorage, client.accountId, app.composers.snapshot());` (`app` is defined later in `boot`; declare `let app: App` before `sessionLost` or read composers through a `let composers: Composers | undefined`).
- In the explicit `signOut`: `clearRescue(localStorage);` first.
- In `start()`, after `await engine.start();`: `const rescued = takeRescue(localStorage, client.accountId); if (rescued.length) { app.composers.restore(rescued); app.toast(rescued.length === 1 ? 'Your unsent draft was restored.' : 'Your unsent drafts were restored.'); }`

- [ ] **Step 4:** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** "Beta readiness: unsaved drafts survive an involuntary sign-out".

### Task 8: Test matrix (Firefox, WebKit, phone, perf project, CI)

**Files:**
- Modify: `playwright.config.ts`, `package.json`, `.github/workflows/ci.yml`, `e2e/README.md`

**Interfaces:**
- Produces: projects `chromium`, `firefox`, `webkit`, `phone`, `perf`; tags `@phone` and `@perf`; scripts `e2e` (Chromium), `e2e:all`, `e2e:perf`.

- [ ] **Step 1: Config.** Replace `projects` in `playwright.config.ts`:

```ts
const auth = { storageState: 'e2e/.auth/alice.json' };
const desktop = { viewport: { width: 1280, height: 900 }, ...auth };
const suite = { dependencies: ['setup'], testIgnore: /auth\.setup\.ts/, grepInvert: /@perf/ };

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...desktop }, ...suite },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], ...desktop }, ...suite },
    { name: 'webkit', use: { ...devices['Desktop Safari'], ...desktop }, ...suite },
    // iPhone-sized WebKit with touch. Runs only tests tagged @phone.
    { name: 'phone', use: { ...devices['iPhone 14'], ...auth }, dependencies: ['setup'], testIgnore: /auth\.setup\.ts/, grep: /@phone/ },
    // Hand-run measurements against the 50k mailbox (deploy/seed/seed_bulk.py). Never in CI.
    { name: 'perf', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } }, grep: /@perf/, timeout: 20 * 60_000 },
  ],
```

`devices['iPhone 14']` is 390×844, WebKit, touch. The `setup` project signs in with whichever engine the dependent project uses only if given one; leave it on its default (Chromium) and confirm the saved `localStorage` tokens work in Firefox and WebKit. If they do not, give each project its own setup project and state file.

`package.json` scripts: `"e2e": "playwright test --project=chromium"`, `"e2e:all": "playwright test --project=chromium --project=firefox --project=webkit --project=phone"`, `"e2e:perf": "playwright test --project=perf"`.

- [ ] **Step 2: Run each engine** and triage: `pnpm build && pnpm exec playwright install firefox webkit && pnpm exec playwright test --project=firefox` then `--project=webkit`. For each failure decide: a real bug in oinbox (fix it now if it is small, else record it for the audit as a finding with its severity), a test that assumes Chromium (make the test engine-neutral), or something the engine cannot do (skip with `test.skip(browserName === 'webkit', '<reason>')`). Keep a list of skips and findings for `docs/beta-audit.md` (Task 13).

- [ ] **Step 3: CI matrix.** In `.github/workflows/ci.yml`, the `e2e` job becomes:

```yaml
  e2e:
    name: End-to-end (${{ matrix.project }})
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        include:
          - { project: chromium, browser: chromium }
          - { project: firefox, browser: firefox }
          - { project: webkit, browser: webkit }
          - { project: phone, browser: webkit }
    steps:
      # …checkout, pnpm, node, install, build unchanged…
      - run: pnpm exec playwright install --with-deps chromium ${{ matrix.browser }}
      # …start the stack unchanged…
      - run: pnpm exec playwright test --project=${{ matrix.project }}
      # …logs unchanged…
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: e2e-failure-${{ matrix.project }}
          # …paths unchanged…
```

(Chromium is always installed because the `setup` project uses it.) Pass `OINBOX_COMMIT: ${{ github.sha }}` in `env` for the build steps of both jobs.

- [ ] **Step 4:** `e2e/README.md`: document the projects, the tags and the three scripts; change "Playwright (Chromium)" in the first line.
- [ ] **Step 5:** `pnpm e2e` → PASS on Chromium; Firefox and WebKit pass or have explained skips. The `phone` project has no tests yet and reports "no tests found"; it gains them in Task 10 (pass `--pass-with-no-tests` in CI until then, and remove the flag in Task 10).
- [ ] **Step 6: Commit** "Beta readiness: Firefox, WebKit and phone e2e projects, in CI as a matrix".

---

# Phase 2: audits

Every audit task appends a section to `docs/beta-audit.md` in this form:

```markdown
## <Area>

**Checked:** <what, on which browsers, on what date, at which commit>
**How:** <tools and scripts>
**Exit criteria:** <from the spec> — met / not met

| # | Severity | Finding | Steps | Fix or reason deferred |
|---|---|---|---|---|
| A1 | major | … | … | … |
```

Severity uses the spec's rule. Do not fix findings during an audit task unless the fix is a line or two and plainly safe; record it either way.

### Task 9: Accessibility audit

**Files:**
- Create: `e2e/a11y.spec.ts`, `docs/beta-audit.md`, `docs/a11y-script.md`
- Modify: `package.json` (dev dependency)

- [ ] **Step 1:** `pnpm add -D @axe-core/playwright`.

- [ ] **Step 2: Write the spec** — `e2e/a11y.spec.ts`:

```ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows } from './support/app';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function check(page: Page, name: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join('\n  ')}`).join('\n');
  expect(bad, `${name}\n${report}`).toEqual([]);
}

const screens: Record<string, (page: Page) => Promise<void>> = {
  'thread list': (page) => openInbox(page),
  conversation: async (page) => {
    await openInbox(page);
    await rows(page).first().click();
    await page.locator('iframe').first().waitFor();
  },
  'new message': async (page) => {
    await openInbox(page);
    await page.getByRole('button', { name: 'Compose' }).click();
    await page.getByRole('textbox', { name: /subject/i }).waitFor();
  },
  'inline reply': async (page) => {
    await openInbox(page);
    await rows(page).first().click();
    await page.keyboard.press('r');
    await page.locator('.composer.inline').waitFor();
  },
  'search results': async (page) => {
    await page.goto('/search/from%3Abob');
    await rows(page).first().waitFor();
  },
  settings: async (page) => {
    await page.goto('/settings');
    await page.getByRole('heading', { name: 'Settings' }).waitFor();
  },
  'calendar week': async (page) => {
    await page.goto('/calendar');
    await page.locator('.fc-event').first().waitFor();
  },
  'event form': async (page) => {
    await page.goto('/calendar');
    await page.locator('.fc-event').first().waitFor();
    await page.getByRole('button', { name: /create|new event/i }).click();
    await page.getByRole('dialog').or(page.locator('.rozie-popover')).first().waitFor();
  },
  'confirm dialog': async (page) => {
    await openInbox(page);
    await page.keyboard.press('j');
    await page.keyboard.press('e');
    await page.getByRole('dialog').waitFor();
  },
  'label dialog': async (page) => {
    await openInbox(page);
    await page.getByRole('button', { name: /new label|create label/i }).click();
    await page.getByRole('dialog').waitFor();
  },
  'shortcuts dialog': async (page) => {
    await openInbox(page);
    await page.keyboard.press('?');
    await page.getByRole('dialog').waitFor();
  },
};

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const [name, open] of Object.entries(screens)) {
      test(`${name} has no serious axe violations`, async ({ page }) => {
        await open(page);
        await check(page, `${name} (${scheme})`);
        await page.keyboard.press('Escape');
      });
    }
  });
}

test('sign-in has no serious axe violations', async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  await check(page, 'sign-in');
  await context.close();
});
```

Correct each opener's locators against the real page (the names of the Compose, new-label and create-event controls). Axe scans same-origin `srcdoc` iframes by default; confirm the message iframe's nodes appear in a deliberately broken run (for example, temporarily assert `violations` is empty for the conversation and read the node targets).

- [ ] **Step 3: Run and record.** `pnpm build && pnpm exec playwright test e2e/a11y.spec.ts --project=chromium`. Every violation becomes a row in the audit table (id, impact, screen, selector). Tests that fail stay failing for now, marked `test.fail()` with the finding number, so CI stays green and the list is visible; Phase 3 removes each `test.fail()` as it fixes the finding.

- [ ] **Step 4: Write the manual script** — `docs/a11y-script.md`: the eight flows (sign in; read a thread; reply; triage; label; search; change a setting; answer an invitation), each as numbered steps with three columns to fill: "Reachable by keyboard?", "What VoiceOver says", "Where focus lands after". Add the checks from the spec: focus after dialogs, route changes, archive and delete; live-region announcements for toasts, new mail, the connection banner and save status, once each; names on icon buttons; visible focus in both themes; row count and position in the virtualised list; contrast; `prefers-reduced-motion`.

- [ ] **Step 5: Keyboard-only pass.** Drive the eight flows in a headed Chromium with the keyboard only (Playwright script or by hand through the Chrome tools), recording each step in the script's table. Assert the mechanical parts in a spec where cheap, in `e2e/a11y.spec.ts`:

```ts
test('focus returns to the thread list after archiving from the keyboard', async ({ page }) => {
  await openInbox(page);
  await page.keyboard.press('j');
  await page.keyboard.press('e');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator(':focus')).not.toHaveJSProperty('tagName', 'BODY');
});

test('toasts are announced once through a live region', async ({ page }) => {
  await openInbox(page);
  await page.keyboard.press('j');
  await page.keyboard.press('s'); // star
  const live = page.locator('[role=status], [role=alert], [aria-live]').filter({ hasText: /star/i });
  await expect(live).toHaveCount(1);
});
```

- [ ] **Step 6: VoiceOver pass.** This needs a person at a Mac with Safari. Prepare everything (stack up, script open), then ask the user to run `docs/a11y-script.md` with VoiceOver, or to say they want it deferred to the checkpoint. Record their notes as findings. Do not mark the exit criterion met without this pass; if it is deferred, the audit says so.

- [ ] **Step 7:** Write the "Accessibility" section of `docs/beta-audit.md`; add rozie findings to `docs/rozie-feedback.md`.
- [ ] **Step 8: Commit** "Beta readiness: accessibility audit (axe in e2e, keyboard script, findings)".

### Task 10: Phone audit

**Files:**
- Create: `e2e/phone.spec.ts`
- Modify: `src/ui/CalendarView.tsx`, `.github/workflows/ci.yml` (drop `--pass-with-no-tests`), `docs/beta-audit.md`, existing specs (tags only)

- [ ] **Step 1: Calendar opens in day view on phones.** In `CalendarView.tsx`, where the initial view is chosen (the stored preference in `src/calendar/prefs.ts`, or FullCalendar's `initialView`): when `matchMedia('(max-width: 800px)').matches` and the user has no stored view, use `'timeGridDay'`; on phones hide the month and week buttons from `TOOLBAR` only if they overflow at 390px (check first). Unit-test the choice as a pure function in `src/calendar/prefs.ts`:

```ts
export function initialView(stored: CalendarViewName | null, narrow: boolean): CalendarViewName {
  return stored ?? (narrow ? 'timeGridDay' : 'timeGridWeek');
}
```

```ts
it('opens in day view on a narrow screen unless the user chose a view', () => {
  expect(initialView(null, true)).toBe('timeGridDay');
  expect(initialView(null, false)).toBe('timeGridWeek');
  expect(initialView('dayGridMonth', true)).toBe('dayGridMonth');
});
```

(Use the view-name type and default that `prefs.ts` already has.)

- [ ] **Step 2: Write `e2e/phone.spec.ts`**, every test titled with `@phone`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { rows } from './support/app';

const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

/** Every visible button and link is at least 44px in its smaller dimension, or has that much hit area. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], [role=button], input, select, [role=menuitem]')]
      .filter((el) => el.offsetParent !== null && !el.closest('iframe'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
      .map(({ el, r }) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`),
  );
}

test('@phone the inbox fits the screen and the drawer switches mailbox', async ({ page }) => {
  await page.goto('/inbox');
  await expect(rows(page).first()).toBeVisible();
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: 'Menu' }).tap();
  await page.getByRole('link', { name: /^Sent/ }).tap();
  await expect(page).toHaveURL(/\/sent/);
  await expect(page.locator('.sidebar.open')).toHaveCount(0);
  await noSidewaysScroll(page);
});

test('@phone a thread opens, and reply fills the screen without hiding Send', async ({ page }) => {
  await page.goto('/inbox');
  await rows(page).first().tap();
  await page.locator('iframe').first().waitFor();
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: /^Reply$/ }).tap();
  const send = page.getByRole('button', { name: /^Send/ });
  await expect(send).toBeInViewport();
  await page.keyboard.type('On my phone');
  await expect(send).toBeInViewport();
});

test('@phone touch targets are at least 44px on the main screens', async ({ page }) => {
  const found: Record<string, string[]> = {};
  for (const path of ['/inbox', '/settings', '/calendar']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    found[path] = await smallTargets(page);
  }
  expect(found).toEqual({ '/inbox': [], '/settings': [], '/calendar': [] });
});

test('@phone the calendar opens in day view and an event opens', async ({ page }) => {
  await page.goto('/calendar');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  await noSidewaysScroll(page);
});

test('@phone settings fit the screen', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await noSidewaysScroll(page);
});
```

Add tests for the remaining checklist items in the same style: compose a new message and send it to Bob (reuse `e2e/support/compose.ts` helpers), attach a file, archive with Undo from the toast, label a thread, search, edit the signature, turn vacation on and off, answer an invitation from mail (with `futureStart`), create and edit an event by form. Tag existing tests that already work unchanged at phone size with `@phone` instead of duplicating them.

- [ ] **Step 3: Run and record.** `pnpm build && pnpm exec playwright test --project=phone`. Failures are findings; mark with `test.fail()` and the finding number as in Task 9. Then check by hand at 360×640 (Chrome tools, device toolbar) for anything the tests do not see: text clipped, dialogs and popovers off-screen, content under the composer, hover-only controls, safe-area insets. Record what you find.
- [ ] **Step 4:** Remove `--pass-with-no-tests` from CI. Write the "Phone width" section of the audit.
- [ ] **Step 5: Commit** "Beta readiness: phone audit (day view on narrow screens, @phone suite, findings)".

### Task 11: Large-mailbox audit

**Files:**
- Create: `deploy/seed/seed_bulk.py`, `e2e/perf.spec.ts`
- Modify: `deploy/stalwart/accounts.ndjson`, `deploy/README.md`, `.gitignore`, `docs/beta-audit.md`

- [ ] **Step 1: Add carol.** Append to `accounts.ndjson` a line identical to bob's with `acct-carol`, `"name":"carol"`, `"description":"Carol Example (large mailbox)"`. Run `deploy/seed.sh`; confirm `curl -u carol@example.test:oinbox-dev-pass http://localhost:8080/jmap/session` returns an account, and that alice's browser session is still signed in (the seed only creates missing accounts).

- [ ] **Step 2: Write `deploy/seed/seed_bulk.py`:**

```python
#!/usr/bin/env python3
"""Fill carol's mailbox with real mail for the large-mailbox audit. Stdlib only.

Reads an extracted copy of the CMU Enron corpus (https://www.cs.cmu.edu/~enron/, the
`maildir/` tree: maildir/<user>/<folder>/<n>.) and stores messages with Email/import.

  python3 seed_bulk.py --source /corpus/maildir --count 50000 --spread-days 730

Idempotent: a message whose Message-ID carol already has is skipped.
"""
import argparse
import base64
import email
import email.policy
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

JMAP_BASE = os.environ.get("JMAP_BASE", "http://stalwart:8080")
PASSWORD = os.environ.get("SEED_PASSWORD", "oinbox-dev-pass")
USER = "carol@example.test"
USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]
BATCH = 50
SENT_FOLDERS = {"sent", "sent_items", "_sent_mail", "sent_mail"}
INBOX_FOLDERS = {"inbox", "notes_inbox"}
MAX_LABELS = 20
AUTH = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()


def http(path, data=None, content_type="application/json"):
    req = urllib.request.Request(JMAP_BASE + path, data=data, headers={"Authorization": AUTH, "Content-Type": content_type})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.load(res)


def jmap(calls):
    body = http("/jmap/", json.dumps({"using": USING, "methodCalls": calls}).encode())
    out = {}
    for name, args, tag in body["methodResponses"]:
        if name == "error":
            raise RuntimeError(f"{tag}: {args}")
        out[tag] = args
    return out


def walk(source):
    """Yield (folder, path) for every message file, in a stable order."""
    for user in sorted(os.listdir(source)):
        user_dir = os.path.join(source, user)
        if not os.path.isdir(user_dir):
            continue
        for folder in sorted(os.listdir(user_dir)):
            folder_dir = os.path.join(user_dir, folder)
            if not os.path.isdir(folder_dir):
                continue
            for root, _dirs, files in os.walk(folder_dir):
                for name in sorted(files):
                    yield folder.lower(), os.path.join(root, name)


def existing_message_ids(account):
    seen, position = set(), 0
    while True:
        r = jmap([
            ["Email/query", {"accountId": account, "position": position, "limit": 1000}, "q"],
            ["Email/get", {"accountId": account, "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"}, "properties": ["messageId"]}, "g"],
        ])
        for e in r["g"]["list"]:
            seen.update(e.get("messageId") or [])
        if len(r["q"]["ids"]) < 1000:
            return seen
        position += 1000


def mailboxes(account):
    r = jmap([["Mailbox/get", {"accountId": account, "ids": None}, "m"]])
    by_role = {m["role"]: m["id"] for m in r["m"]["list"] if m.get("role")}
    by_name = {m["name"]: m["id"] for m in r["m"]["list"] if not m.get("role")}
    return by_role, by_name


def ensure_label(account, by_name, name):
    if name not in by_name:
        r = jmap([["Mailbox/set", {"accountId": account, "create": {"x": {"name": name}}}, "c"]])
        by_name[name] = r["c"]["created"]["x"]["id"]
    return by_name[name]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="the corpus's maildir/ directory")
    ap.add_argument("--count", type=int, default=50000)
    ap.add_argument("--spread-days", type=int, default=730)
    args = ap.parse_args()

    session = http("/jmap/session")
    account = session["primaryAccounts"]["urn:ietf:params:jmap:mail"]
    upload_path = "/jmap/upload/" + account + "/"
    by_role, by_name = mailboxes(account)
    seen = existing_message_ids(account)
    print(f"bulk: carol has {len(seen)} messages; target {args.count}", flush=True)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    step = timedelta(days=args.spread_days) / max(args.count, 1)
    pending, total, skipped, failed = {}, len(seen), 0, 0

    def flush():
        nonlocal total, failed
        if not pending:
            return
        r = jmap([["Email/import", {"accountId": account, "emails": pending}, "i"]])
        total += len(r["i"].get("created") or {})
        failed += len(r["i"].get("notCreated") or {})
        pending.clear()
        print(f"bulk: {total}/{args.count} (skipped {skipped}, failed {failed})", flush=True)

    for n, (folder, path) in enumerate(walk(args.source)):
        if total + len(pending) >= args.count:
            break
        with open(path, "rb") as f:
            raw = f.read()
        try:
            msg = email.message_from_bytes(raw, policy=email.policy.compat32)
        except Exception:
            failed += 1
            continue
        mid = (msg.get("Message-ID") or "").strip().strip("<>")
        if not mid or mid in seen:
            skipped += 1
            continue
        seen.add(mid)
        if folder in SENT_FOLDERS:
            box, keywords = by_role["sent"], {"$seen": True}
        elif folder in INBOX_FOLDERS or len(by_name) >= MAX_LABELS and folder not in by_name:
            box, keywords = by_role["inbox"], ({} if n % 5 == 0 else {"$seen": True})
        else:
            box, keywords = ensure_label(account, by_name, folder), {"$seen": True}
        # Newest first in walk order would cluster one user's mail; spread evenly across the window instead.
        received = now - step * ((n * 7919) % args.count)
        blob = http(upload_path, raw, "message/rfc822")
        pending[f"m{n}"] = {"blobId": blob["blobId"], "mailboxIds": {box: True}, "keywords": keywords, "receivedAt": received.strftime("%Y-%m-%dT%H:%M:%SZ")}
        if len(pending) >= BATCH:
            flush()
    flush()
    print(f"bulk: done, {total} messages (skipped {skipped}, failed {failed})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Take the upload path from `session["uploadUrl"]` if it differs from `/jmap/upload/{accountId}/` on this Stalwart. If `Email/import` reports a size or rate limit, lower `BATCH`, and record the limit in the memory file for Stalwart quirks.

- [ ] **Step 3: Document and run.** `deploy/README.md`, new section "Large mailbox (carol)": where to get the corpus, that it stays outside the repo, and the command:

```sh
docker run --rm --network oinbox_default -v "$PWD/seed:/seed:ro" -v "/path/to/enron/maildir:/corpus:ro" \
  python:3.13.15-alpine python3 -u /seed/seed_bulk.py --source /corpus --count 50000
```

The corpus is about 1.7 GB extracted and must be downloaded by the user or with their say-so: **ask before downloading it.** Try `--count 2000` first, then the full run. Record how long the import took and the size of the Stalwart and Meilisearch volumes.

- [ ] **Step 4: Write `e2e/perf.spec.ts`:**

```ts
import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { rows } from './support/app';
import { signInThroughStalwart } from './support/login';

const CAROL = 'carol@example.test';
const results: Record<string, { value: number; limit: number; unit: string }> = {};
const record = (name: string, value: number, limit: number, unit = 'ms') => (results[name] = { value: Math.round(value), limit, unit });

const firstRows = async (page: Page) => {
  const t = Date.now();
  await rows(page).first().waitFor({ timeout: 60_000 });
  return Date.now() - t;
};

test.describe.configure({ mode: 'serial' });
test.afterAll(() => {
  writeFileSync('test-results/perf.json', JSON.stringify(results, null, 2));
  console.table(results);
});

test('@perf 50k mailbox', async ({ page, context }) => {
  // Cold start: sign in, measure from the redirect back to the first rows.
  await signInThroughStalwart(page, CAROL);
  await page.evaluate(() => indexedDB.databases().then((dbs) => Promise.all(dbs.map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name!); q.onsuccess = q.onerror = q.onblocked = r; })))));
  await page.goto('/inbox');
  record('cold start to first rows', await firstRows(page), 3000);

  // Warm start: the snapshot is saved a moment after first sync.
  await page.waitForTimeout(5000);
  await page.reload();
  record('warm start to first rows', await firstRows(page), 1000);

  // Scroll to row 5000, sampling frames and blank rows.
  const scroll = await page.evaluate(async () => {
    const list = document.querySelector('[role=list]')!;
    const scroller = (list.closest('.thread-list') ?? list.parentElement!) as HTMLElement;
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 40;
    const target = rowH * 5000;
    const frames: number[] = [];
    let longestBlank = 0, blankSince: number | null = null, last = performance.now();
    await new Promise<void>((done) => {
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        const blank = !list.querySelector('a.row[data-thread-id]');
        if (blank && blankSince === null) blankSince = now;
        if (!blank && blankSince !== null) { longestBlank = Math.max(longestBlank, now - blankSince); blankSince = null; }
        if (scroller.scrollTop < target) { scroller.scrollTop += rowH * 30; requestAnimationFrame(tick); }
        else setTimeout(done, 1500);
      };
      requestAnimationFrame(tick);
    });
    frames.sort((a, b) => a - b);
    return { p95: frames[Math.floor(frames.length * 0.95)]!, longestBlank };
  });
  record('scroll: longest blank', scroll.longestBlank, 500);
  record('scroll: p95 frame', scroll.p95, 32);

  // Search.
  await page.goto('/inbox');
  await firstRows(page);
  const search = page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first();
  await search.fill('meeting');
  const t0 = Date.now();
  await search.press('Enter');
  await page.waitForURL(/\/search\//);
  await rows(page).first().waitFor({ timeout: 30_000 });
  record('search to first results', Date.now() - t0, 2000);

  // Heap growth over 10 minutes with a push every 10 s (deliver over SMTP from the test).
  const cdp = await context.newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  await page.goto('/inbox');
  await firstRows(page);
  await page.waitForTimeout(60_000);
  const start = await heap();
  const { sendMail } = await import('./support/mail');
  for (let i = 0; i < 54; i++) {
    await sendMail({ from: 'bob@example.test', to: CAROL, subject: `perf push ${i}`, text: 'x' });
    await page.waitForTimeout(10_000);
  }
  record('heap growth over 10 minutes', ((await heap()) / start - 1) * 100, 20, '%');

  const snapshotBytes = await page.evaluate(() => navigator.storage.estimate().then((e) => e.usage ?? 0));
  record('IndexedDB snapshot', snapshotBytes / 1e6, 20, 'MB');

  for (const [name, r] of Object.entries(results)) expect.soft(r.value, name).toBeLessThanOrEqual(r.limit);
});

test('@perf a 50-message thread opens quickly', async ({ page }) => {
  await signInThroughStalwart(page, CAROL);
  // Find the largest thread through JMAP is costly at 50k; the seed prints its subject. Search for it.
  const subject = process.env.PERF_LONG_THREAD_SUBJECT;
  test.skip(!subject, 'set PERF_LONG_THREAD_SUBJECT to the subject of a 50+ message thread in carol’s mailbox');
  await page.goto(`/search/${encodeURIComponent(`subject:"${subject}"`)}`);
  await rows(page).first().waitFor();
  const t0 = Date.now();
  await rows(page).first().click();
  await page.locator('.message').last().waitFor();
  record('open a 50-message thread', Date.now() - t0, 1500);
});
```

Correct the scroller selector, the search box locator, the `.message` class and the `sendMail` signature to the real ones (`e2e/support/mail.ts`). Finding a 50-message thread: after the import, run a small JMAP query from Node (`Thread/get` over the ids of a subject search for common Enron subjects) or add `--print-largest-thread` to the seed script; if the corpus sample has no thread that long, deliver replies over SMTP until one does.

- [ ] **Step 5: Run and record.** `pnpm build && pnpm e2e:perf`. Copy `test-results/perf.json` into the audit as a table of measure, value, threshold, verdict. While signed in as carol, scroll and open about 50 messages across folders and watch the console: sanitizer errors, blank messages, broken threading, mis-decoded headers are findings. A missed threshold is a finding rated by the severity rule.
- [ ] **Step 6:** `.gitignore`: nothing from the corpus lives in the repo; add `test-results/perf.json` is already under `test-results`. Write the "Large mailbox" section of the audit, including the machine it ran on.
- [ ] **Step 7: Commit** "Beta readiness: large-mailbox audit (bulk seed, perf spec, findings)".

### Task 12: Network audit

**Files:**
- Create: `e2e/network.spec.ts`
- Modify: `docs/beta-audit.md`

- [ ] **Step 1: Write `e2e/network.spec.ts`:**

```ts
import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows, waitLive } from './support/app';
import { ALICE, BOB, accountId, jmap } from './support/mail';

const banner = (page: Page) => page.getByRole('status').filter({ hasText: "Can't reach the server. Retrying…" });
const failJmap = (page: Page, status = 503) => page.route('**/jmap/**', (route) => route.fulfill({ status, body: 'unavailable' }));

test('offline while reading: banner, loaded mail still opens, recovery without reload', async ({ page, context }) => {
  await openInbox(page);
  await waitLive(page);
  await rows(page).first().click();
  await page.locator('iframe').first().waitFor();
  await page.goBack();
  await context.setOffline(true);
  await expect(banner(page)).toBeVisible({ timeout: 8000 });
  await rows(page).first().click();
  await expect(page.locator('iframe').first()).toBeVisible();
  await context.setOffline(false);
  await expect(banner(page)).toHaveCount(0, { timeout: 40_000 });
  await waitLive(page);
});

test('offline during archive: the row comes back and a toast says so', async ({ page, context }) => {
  await openInbox(page);
  await waitLive(page);
  const first = rows(page).first();
  const id = await first.getAttribute('data-thread-id');
  await context.setOffline(true);
  await page.keyboard.press('j');
  await page.keyboard.press('e');
  await page.getByRole('dialog').getByRole('button', { name: /archive/i }).click();
  await expect(page.locator(`a.row[data-thread-id="${id}"]`)).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('.toast[role=alert]')).toBeVisible();
  await context.setOffline(false);
});

test('offline during send: the composer returns with its text; Retry sends exactly once', async ({ page, context }) => {
  const subject = `net-${Date.now()}`;
  await openInbox(page);
  await waitLive(page);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByRole('combobox', { name: /to/i }).fill(`${BOB},`);
  await page.getByRole('textbox', { name: /subject/i }).fill(subject);
  await page.locator('.ProseMirror').fill('must not be lost');
  await expect(page.getByText('Draft saved')).toBeVisible();
  await page.getByRole('button', { name: /^Send/ }).click();
  await context.setOffline(true);
  await expect(page.getByText("Couldn't send. Your message is still here.")).toBeVisible({ timeout: 50_000 });
  await expect(page.locator('.ProseMirror')).toContainText('must not be lost');
  await context.setOffline(false);
  await expect(banner(page)).toHaveCount(0, { timeout: 40_000 });
  await page.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByText('Message sent.')).toBeVisible({ timeout: 30_000 });
  // Exactly one copy in Bob's mailbox, found by thread membership of ids, not a subject search.
  const bob = await accountId(BOB);
  await expect.poll(async () => {
    const r = await jmap([
      ['Email/query', { accountId: bob, sort: [{ property: 'receivedAt', isAscending: false }], limit: 20 }, 'q'],
      ['Email/get', { accountId: bob, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g'],
    ], BOB);
    return (r.g.list as { subject: string }[]).filter((e) => e.subject === subject).length;
  }, { timeout: 30_000 }).toBe(1);
});

test('a draft that could not be saved saves by itself after reconnect', async ({ page, context }) => {
  await openInbox(page);
  await waitLive(page);
  await page.getByRole('button', { name: 'Compose' }).click();
  await context.setOffline(true);
  await page.getByRole('textbox', { name: /subject/i }).fill(`net-draft-${Date.now()}`);
  await expect(page.getByText('Couldn’t save draft')).toBeVisible({ timeout: 45_000 });
  await context.setOffline(false);
  await expect(page.getByText('Draft saved')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
});

test('503 from JMAP for 10 seconds: one banner, no toast storm, recovery', async ({ page }) => {
  await openInbox(page);
  await waitLive(page);
  await failJmap(page);
  await page.reload();
  await expect(banner(page)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(10_000);
  expect(await page.locator('.toast').count()).toBeLessThanOrEqual(1);
  await page.unroute('**/jmap/**');
  await expect(banner(page)).toHaveCount(0, { timeout: 40_000 });
  await expect(rows(page).first()).toBeVisible();
});

test('a rejected refresh token signs out in place and brings the draft back after sign-in', async ({ page }) => {
  const subject = `net-rescue-${Date.now()}`;
  await openInbox(page);
  await waitLive(page);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.route('**/jmap/**', (route) => route.fulfill({ status: 401, body: '' }));
  await page.route('**/auth/token', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"invalid_grant"}' }));
  await page.getByRole('textbox', { name: /subject/i }).fill(subject);
  await expect(page.getByRole('status').filter({ hasText: "You've been signed out." })).toBeVisible({ timeout: 45_000 });
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('oinbox.rescue.')))).toBe(true);
  await page.unroute('**/jmap/**');
  await page.unroute('**/auth/token');
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await page.waitForURL((u) => u.pathname === '/login');
  await page.locator('#username').fill(ALICE);
  await page.locator('#password').fill('oinbox-dev-pass');
  await page.locator('#submit-btn').click();
  await expect(page.getByRole('textbox', { name: /subject/i })).toHaveValue(subject, { timeout: 30_000 });
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('oinbox.rescue.')))).toBe(false);
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
});
```

This last test signs alice in again, which issues new tokens: re-save the storage state at its end (`await page.context().storageState({ path: 'e2e/.auth/alice.json' })`) so later specs keep working, or run it in its own context created from the saved state. Add two more tests in the same style: a JMAP request that never answers (`page.route` with a handler that never fulfils; use `page.clock` to advance 30 s, or set a short timeout through a test-only query flag if the clock cannot drive `AbortSignal.timeout`), expecting the banner; and an attachment upload cut off by `setOffline(true)`, expecting the "Couldn't attach" toast, the rest of the draft intact, and a working re-attach after reconnect.

Correct locators to the real ones as in earlier tasks.

- [ ] **Step 2: Run on all three engines.** `pnpm build && pnpm exec playwright test e2e/network.spec.ts --project=chromium --project=firefox --project=webkit`. A failure is either a bug to record (and, for anything that loses composer text, a blocker) or a test fault to fix.

- [ ] **Step 3: Manual rows.** With the app open and a draft in progress:
  - `docker compose -f deploy/docker-compose.yml restart stalwart`: banner, then recovery with no reload; push resumes (deliver a message and see it arrive); no duplicate rows; the draft is intact.
  - Chromium "Slow 3G" throttling: cold start, open a thread, search, send. Note blank panes or missing progress indicators.
  Record both.

- [ ] **Step 4:** Write the "Network" section of the audit, one row per condition in the spec's table with its result.
- [ ] **Step 5: Commit** "Beta readiness: network audit (offline, 5xx, sign-out, restart; findings)".

### Task 13: Checkpoint

- [ ] **Step 1:** Complete `docs/beta-audit.md`: a summary table at the top (area, exit criteria met or not, counts of blockers, majors and minors), the engine skips from Task 8, and a proposed fix list: every blocker and major with a one-line approach and a rough size.
- [ ] **Step 2:** `pnpm test && pnpm typecheck && pnpm build && pnpm e2e:all` → record the counts in the audit.
- [ ] **Step 3: Commit** "Beta readiness: audit summary and proposed fix list".
- [ ] **Step 4: STOP.** Tell the user the audit is ready, give the summary table and the proposed fix list in a few lines, and wait. They confirm or change the list. Then append "Phase 3 fixes" tasks to this plan (one per finding or group of related findings, each with its failing test first), commit the plan change, and continue.

---

# Phase 3: fixes and release

### Task 14: Fixes

Written at the checkpoint from the confirmed fix list. Each fix: a test that fails for the finding (remove the matching `test.fail()` where one exists), the fix, the suite green, a commit named for the finding number. Minors are copied to the README's "Known limitations" in Task 16.

**Confirmed by the user on 2026-10-08** (the whole proposed list; VoiceOver verification at the end; no stops between tasks; rozie gaps are documented and oinbox is written as though they are fixed, to be closed by a rozie release before this slice completes).

- [ ] **14a E1** Safari quote toggle: `foldBehindToggle` in `src/mail/quotes.ts` (unit test first), used by `MessageBody`; drop the scripted button; `e2e/html-message.spec.ts` loses its two WebKit `test.fail`.
- [ ] **14b A5** New message takes focus: focus the To field when a `new` composer opens; give focus back to the element that had it when the composer closes. e2e in `compose.spec.ts`: `c` then typing lands in To; Escape returns focus.
- [ ] **14c A3** Message header: the expand/collapse toggle becomes its own `<button>` inside `.msg-head`, beside the actions; the header div loses `role="button"`. Remove `conversation` and `inline reply` from `KNOWN` in `e2e/a11y.spec.ts`.
- [ ] **14d A8** Focus on thread open and close: the conversation heading gets `tabindex="-1"` and focus on open; returning focuses the row; the `j`/`k` cursor row gets real focus (roving tabindex) and `aria-current`. Unit test for the focus helper; e2e in `keyboard.spec.ts`.
- [ ] **14e A6** Toasts: remove the inner role from oinbox's toast element and rely on rozie Toaster's live regions (documented gap: standing polite and assertive regions; `alert` for errors; the `toastSlot` attribute leak). e2e: exactly one live region carries a toast's text.
- [ ] **14f A2, A4, A7** Dark danger colour; FullCalendar nav icons hidden from the accessibility tree; focus outline on the search box. Remove `calendar week` from `KNOWN`; `event card` and `event form` keep A1 only (rozie).
- [ ] **14g P3, P1** Coarse-pointer minimum sizes for icon buttons, list controls, composer toolbar and links, calendar toolbar and toggles, image banner; scroll the composer's action row into view on focus. The four `@phone` target tests lose `test.fail`.
- [ ] **14h P4** Phone search: the field takes the top bar while focused.
- [ ] **14i P2** Phone event card: capped to the viewport width by oinbox CSS; staying inside the viewport is rozie Popover's job (documented gap). The `@phone` calendar test keeps `test.fail` with the rozie reason if the popover still overflows.
- [ ] **14j N3, N4** Static loading markup in `index.html`; a "Loading calendar…" fallback around the lazy view.
- [ ] **14k L1** Import 50,000 corpus messages into carol, run `pnpm e2e:perf`, record the numbers and any findings; fix blockers and majors.
- [ ] **14l** Phone tests for the four flows that had none: attach a file, edit a signature, answer an invitation, create and edit an event by form.

### Task 15: Production template

**Files:**
- Create: `deploy/routes.caddy`, `deploy/production/docker-compose.yml`, `deploy/production/Caddyfile`, `deploy/production/plan.ndjson`, `deploy/production/config.json`, `deploy/production/.env.example`, `deploy/production/ci.override.yml`, `e2e/production.spec.ts`
- Modify: `deploy/Caddyfile`, `Dockerfile`, `deploy/docker-compose.yml`, `.github/workflows/ci.yml`, `playwright.config.ts`, the spec ("Probed" section)

- [ ] **Step 1: Probes.** Against a scratch copy of the stack (a second compose project name, so the dev stack and its data are untouched):
  1. **Mail-port certificates.** Read Stalwart 0.16's docs and settings (`stalwartlabs/cli … query` on the certificate and ACME objects) for how a certificate is supplied: its own ACME client (which challenge types, and whether it needs port 80 or 443), or a certificate read from files. Find an arrangement that works with Caddy on 80 and 443: for example Stalwart ACME with a DNS-01 or TLS-ALPN challenge on another port, or Stalwart reading the certificate files Caddy obtains (shared volume, with a reload when they renew). Verify whichever you choose with `openssl s_client -connect localhost:<port> -starttls smtp` against the scratch stack using Caddy's internal CA.
  2. **CORS.** Query the `Http` settings object for origin-restricted CORS options besides `usePermissiveCors`.
  3. **Headers on Stalwart's pages.** `curl -sI http://localhost:8080/login` and `/admin/`: note which security headers Stalwart sets.
  Write the results into the spec under a new "Probed on Stalwart 0.16" section, and into the Stalwart quirks memory. If no arrangement for mail-port TLS can be verified, stop and tell the user before writing the template.

- [ ] **Step 2: Share the routing.** Move the `@stalwart` matcher, the `reverse_proxy` block and the SPA `handle` block from `deploy/Caddyfile` into `deploy/routes.caddy` as a snippet:

```
(oinbox_routes) {
	# …the two handle blocks, unchanged…
}
```

`deploy/Caddyfile` becomes its global options, `import routes.caddy`, and `:8080 { log; import oinbox_routes }`. The Dockerfile copies `deploy/routes.caddy` to `/etc/caddy/routes.caddy`; the dev compose file mounts it next to the Caddyfile. Run the Chromium e2e suite to prove nothing moved.

- [ ] **Step 3: Write the template.**

`deploy/production/Caddyfile`:

```
{
	admin off
	email {$ACME_EMAIL}
}

import routes.caddy

{$OINBOX_DOMAIN} {
	log {
		output stdout
		format json
	}
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	import oinbox_routes
}
```

`deploy/production/docker-compose.yml`: services `stalwart` (`stalwartlabs/stalwart:v0.16.23`, `STALWART_PUBLIC_URL=https://${OINBOX_DOMAIN}`, `STALWART_RECOVERY_ADMIN=${STALWART_RECOVERY_ADMIN}`, mail ports 25, 465, 587 and 993 published, the certificate arrangement from the probe, healthcheck as in dev), `meilisearch` (`MEILI_ENV: production`, key from `${MEILI_MASTER_KEY}`, no published port), `oinbox` (`ghcr.io/one-learning-community/oinbox:${OINBOX_VERSION}`, ports 80 and 443, this Caddyfile mounted, `caddy-data` and `caddy-config` volumes, `OINBOX_DOMAIN` and `ACME_EMAIL` passed in). Named volumes; `restart: unless-stopped`; no dev ports and no bind mount of the repo.

`deploy/production/plan.ndjson`: start from `deploy/stalwart/plan.ndjson` and keep only what production needs: the domain (placeholder `example.com`), the `oinbox` OAuth client with the single redirect `https://example.com/auth/callback`, `OidcProvider.requireClientRegistration=true`, the Meilisearch store. Leave out permissive CORS, console debug logging, the relaxed SMTP checks, the disabled spam filter and the disabled throttle. No accounts. A comment line at the top is not valid NDJSON; put the explanation in the operator guide instead.

`deploy/production/.env.example`:

```sh
# Copy to .env and fill in. Never commit .env.
OINBOX_DOMAIN=mail.example.com
ACME_EMAIL=postmaster@example.com
OINBOX_VERSION=0.1.0-beta.1
# Generate each with: openssl rand -hex 32
MEILI_MASTER_KEY=
# user:password for Stalwart's recovery admin. Use it to create the first accounts, then consider removing it.
STALWART_RECOVERY_ADMIN=
```

Add `deploy/production/.env` to `.gitignore`.

- [ ] **Step 4: Test it in CI.** `deploy/production/ci.override.yml` builds the `oinbox` service from the repo instead of pulling, sets `OINBOX_DOMAIN=localhost`, and mounts a Caddyfile variant that adds `tls internal`. `e2e/production.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { signInThroughStalwart } from './support/login';

test.use({ ignoreHTTPSErrors: true, baseURL: 'https://localhost' });

test('@production signs in over HTTPS and shows the inbox', async ({ page }) => {
  await signInThroughStalwart(page, 'prod-test@localhost', process.env.PROD_TEST_PASSWORD!);
  await expect(page).toHaveURL(/\/inbox/);
});

test('@production sends HSTS and the CSP, and no CORS header', async ({ request }) => {
  const home = await request.get('/');
  expect(home.headers()['strict-transport-security']).toContain('max-age=31536000');
  expect(home.headers()['content-security-policy']).toContain("default-src 'self'");
  const session = await request.get('/jmap/session', { headers: { origin: 'https://evil.example' } });
  expect(session.headers()['access-control-allow-origin']).toBeUndefined();
  const preflight = await request.fetch('/jmap/', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  expect(preflight.headers()['access-control-allow-origin']).toBeUndefined();
});

test('@production redirects HTTP to HTTPS', async ({ request }) => {
  const res = await request.get('http://localhost/', { maxRedirects: 0 });
  expect(res.status()).toBe(308);
});
```

Add a `production` project (`grep: /@production/`, no setup dependency) and exclude `@production` from the other projects' runs. New CI job `production-template`: write a `.env` with generated secrets, `docker compose -f docker-compose.yml -f ci.override.yml up -d --build --wait`, apply the plan with `stalwartlabs/cli:1.0.12 apply` (domain `localhost`), create one user with the CLI, then `pnpm exec playwright test --project=production`. Run the same steps locally first under a separate compose project name (`-p oinbox-prod`) and on ports that do not collide with the dev stack if 80 and 443 are taken.

- [ ] **Step 5:** All e2e projects still pass; the production job passes locally.
- [ ] **Step 6: Commit** "Beta readiness: production template (TLS, HSTS, CORS off), tested in CI".

### Task 16: README and operator guide

**Files:**
- Create: `docs/operating.md`
- Modify: `README.md`, `deploy/README.md`

- [ ] **Step 1: `docs/operating.md`**, sections in the spec's order: What you need; Topology (the proxy's five duties, with the full Caddy example from `deploy/routes.caddy` and an nginx equivalent); Stalwart settings (as `stalwart-cli apply` input and in words for the WebUI); Install (image with Compose from `deploy/production/`; tarball behind an existing proxy); First sign-in; Upgrade; Backup; What signs users out; Troubleshooting; Unsupported (separate-origin, with what the CORS probe found).

The nginx example must be run, not only written: start an `nginx:1.29-alpine` container in place of Caddy against the dev Stalwart with the documented config, and pass `login.spec.ts`, `push.spec.ts` and `compose.spec.ts` on Chromium against it. The config needs, at least: `proxy_buffering off` and `proxy_read_timeout 1h` for the event stream path, `proxy_hide_header WWW-Authenticate`, `try_files $uri /index.html`, the exact-match exception for `/auth/callback`, the security headers, and long cache lifetimes for `/assets/` only. Paste the config that passed.

Every command in the guide is one you ran in Task 15 or here.

- [ ] **Step 2: README.** Rewrite per the spec: features now include calendar (views, single-event create, move, resize, edit, delete, invitations with Accept, Maybe, Decline), settings (signature, identities, vacation) and labels; "Not in v1" lists contacts, a filter UI, multiple accounts, offline mode, PGP, editing recurring events, an installable app; "Install" links the operator guide; "Develop" keeps the quick start; "Browsers" lists what CI runs; "Accessibility" says what was tested and what was not (from the audit); "Known limitations" lists every minor from the audit and every engine skip; the layout table gains the new files; the test section names the projects and scripts. Remove any line that calls calendar a non-goal (`grep -n -i "non-goal\|calendar" README.md docs/superpowers/specs/2026-09-25-oinbox-design.md` to find the wording; change the README only).

- [ ] **Step 3: `deploy/README.md`:** point to `deploy/production/` and the operator guide for real installs; mention `routes.caddy`; keep the dev content.
- [ ] **Step 4:** Check every relative link in the three files resolves (`grep -o "](\([^)h][^)]*\))" …` and test each path).
- [ ] **Step 5: Commit** "Beta readiness: README for what oinbox is now, and an operator guide".

### Task 17: Release packaging

**Files:**
- Create: `.github/workflows/release.yml`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`

- [ ] **Step 1: `.github/workflows/release.yml`:**

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
      - name: The tag must match package.json
        run: test "v$(node -p "require('./package.json').version")" = "$GITHUB_REF_NAME"
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm build
        env:
          OINBOX_COMMIT: ${{ github.sha }}
      - name: Tarball and checksums
        run: |
          v="${GITHUB_REF_NAME#v}"
          tar -C dist -czf "oinbox-$v.tar.gz" .
          sha256sum "oinbox-$v.tar.gz" > SHA256SUMS
      - uses: docker/setup-qemu-action@v4
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Image for amd64 and arm64
        run: |
          v="${GITHUB_REF_NAME#v}"
          docker buildx build --platform linux/amd64,linux/arm64 --build-arg OINBOX_COMMIT=${{ github.sha }} \
            -t "ghcr.io/one-learning-community/oinbox:$v" --push .
      - name: Draft release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          v="${GITHUB_REF_NAME#v}"
          awk -v v="$v" '$0 ~ "^## " v {on=1; next} on && /^## / {exit} on' CHANGELOG.md > notes.md
          gh release create "$GITHUB_REF_NAME" "oinbox-$v.tar.gz" SHA256SUMS --draft --prerelease --title "oinbox $v" --notes-file notes.md
```

Check the action versions against the ones already pinned in `ci.yml` and what currently exists; use the same major versions the repo uses for shared actions. Validate the workflow with `actionlint` if available (`docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`). Prove the local parts work: build the tarball and check it unpacks to an `index.html` and `assets/`; `docker buildx build --platform linux/amd64,linux/arm64 .` without `--push`; run the `awk` line against the changelog and read the output.

- [ ] **Step 2: `CHANGELOG.md`** in Keep a Changelog form, one entry `## 0.1.0-beta.1` with: what oinbox does (mail, search, compose, triage, labels, keyboard, settings, calendar with invitations), what this release hardened (error boundaries, connection status, composer safety, accessibility, phone, browsers), and a pointer to Known limitations.
- [ ] **Step 3: `SECURITY.md`:** report privately through GitHub's "Report a vulnerability"; supported versions (the latest beta); in scope (HTML sanitising, the message iframe and CSP, remote-image blocking, OAuth and token storage, the proxy configuration shipped in `deploy/`); out of scope (Stalwart itself, with a link to its policy); a short description of the design: DOMPurify, a script-less sandboxed `srcdoc` iframe with its own CSP, remote images blocked until allowed, tokens in `localStorage` under a strict page CSP, no third-party requests, no telemetry.
- [ ] **Step 4: `CONTRIBUTING.md`:** run the stack and the tests (unit, `e2e`, `e2e:all`, `e2e:perf`); the e2e rules (specs arrange and clean their own state; never wait on subject searches; invited fixtures use `futureStart`); UI uses rozie components and findings go in `docs/rozie-feedback.md`; commit style; MIT.
- [ ] **Step 5:** `package.json`: keep `"private": true` (nothing here publishes to npm).
- [ ] **Step 6: Commit** "Beta readiness: release workflow, changelog, security and contributing notes".

### Task 18: Final verification and review

- [ ] **Step 1:** From a clean tree: `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm build && pnpm e2e:all`, then the production template job's steps locally. Record the counts.
- [ ] **Step 2:** Read the spec section by section and tick each requirement against the branch. Anything missing is done now or raised with the user.
- [ ] **Step 3:** Update `docs/beta-audit.md` so each fixed finding names its commit; check "Known limitations" matches the remaining minors.
- [ ] **Step 4:** Whole-branch review by a fresh reviewer (as in the calendar slices), with the spec and this plan; apply superpowers:receiving-code-review to its findings; fix, and re-run Step 1.
- [ ] **Step 5:** Update the memory files (`oinbox-pilot-slices.md`, the Stalwart quirks) with what was learned.
- [ ] **Step 6:** Hand over with the release checklist from the spec: push `main`, read the audit, make the repo public and enable private vulnerability reporting, tag `v0.1.0-beta.1`, publish the draft release and the package. The implementer does none of these.
