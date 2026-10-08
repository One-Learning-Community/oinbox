import type { ToastFn } from './actions';
import { versionLabel } from './version';

const TOAST_EVERY_MS = 10_000;

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || 'Unknown error';
  if (typeof e === 'string' && e) return e;
  return 'Unknown error';
}

/** What a user can paste into a bug report: the message, the top of the stack, the build. */
export function errorDetails(e: unknown): string {
  const stack = e instanceof Error && e.stack ? e.stack.split('\n').slice(1, 6).map((l) => l.trim()) : [];
  return [errorMessage(e), ...stack, versionLabel()].join('\n');
}

/** A lazy chunk that is gone, usually because the server was upgraded under an open tab. */
export function isChunkLoadError(e: unknown): boolean {
  return /dynamically imported module|Importing a module script failed/i.test(errorMessage(e));
}

/** Errors are shown and logged here and go nowhere else: oinbox sends no telemetry. */
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
      if (isHandled(reason)) {
        ev.preventDefault();
        return;
      }
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
