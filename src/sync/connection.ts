import { createSignal, type Accessor } from 'solid-js';
import { RequestError, UnauthorizedError } from '../jmap/client';

export type ConnectionState = 'ok' | 'retrying' | 'signed-out';
export type ConnectionSource = 'request' | 'push';

const GRACE_MS = 3000;
const FAILURES_TO_SHOW = 2;
const RETRY_CAP_MS = 30_000;
/** Back from a hidden tab (often a sleeping computer), the network can take a few seconds to return. */
export const WAKE_GRACE_MS = 10_000;

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
  /** `manual` is true when a person (or the browser coming back online) asked, false for the timed retries. */
  onRetry(fn: (manual: boolean) => void): () => void;
  onRecovered(fn: () => void): () => void;
  retryNow(): void;
  /** The tab was hidden or shown again (document.visibilityState). */
  setVisible(visible: boolean): void;
}

export function createConnection(opts: { graceMs?: number; failuresToShow?: number } = {}): Connection {
  const graceMs = opts.graceMs ?? GRACE_MS;
  const failuresToShow = opts.failuresToShow ?? FAILURES_TO_SHOW;
  const [state, setState] = createSignal<ConnectionState>('ok');
  const retryFns = new Set<(manual: boolean) => void>();
  /** Sources whose last report was a failure. The banner goes only when there are none. */
  const failing = new Set<ConnectionSource>();
  const recoveredFns = new Set<() => void>();
  let failures = 0;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let hidden = false;
  /** Back from hidden, and the wake grace is still running: only it may show the banner. */
  let waking = false;

  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      attempt++;
      for (const fn of retryFns) fn(false);
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
    waking = false;
  };

  const retryAll = () => {
    attempt = 0;
    for (const fn of retryFns) fn(true);
  };

  return {
    state,
    reportFailure(source, error) {
      if (state() === 'signed-out') return;
      // A dropped push stream is a transport failure whatever the error looks like.
      if (source === 'request' && !isTransportFailure(error)) return;
      failing.add(source);
      // Nobody is looking; the return to the tab decides (setVisible).
      if (hidden || waking) return;
      failures++;
      if (failures >= failuresToShow) show();
      else grace ??= setTimeout(show, graceMs);
    },
    reportSuccess(source) {
      if (state() === 'signed-out') return;
      failing.delete(source);
      // One source answering says nothing about the other: requests can work while push cannot.
      if (failing.size) return;
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
      retryAll();
      scheduleRetry();
    },
    setVisible(visible) {
      if (hidden === !visible) return;
      hidden = !visible;
      if (!visible) {
        // A grace timer would fire unseen, or late in a throttled background tab.
        clearTimeout(grace);
        grace = undefined;
        waking = false;
        return;
      }
      if (state() === 'retrying') {
        retryAll();
        scheduleRetry();
      } else if (state() === 'ok' && failing.size) {
        failures = 0;
        waking = true;
        grace = setTimeout(() => {
          waking = false;
          if (failing.size) show();
        }, WAKE_GRACE_MS);
        retryAll();
      }
    },
  };
}
