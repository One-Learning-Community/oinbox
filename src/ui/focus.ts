import { onCleanup } from 'solid-js';

/**
 * When the calling component goes away, give the focus back to whatever had it when the
 * component was created. A <dialog> does this itself only when it is closed; ours are
 * removed from the page while open, which leaves the focus on the page body.
 */
export function restoreFocus(): void {
  const before = document.activeElement as HTMLElement | null;
  // A microtask later the dialog is out of the page; until then everything outside it is inert.
  onCleanup(() => queueMicrotask(() => {
    if (before?.isConnected && document.activeElement === document.body) before.focus({ preventScroll: true });
  }));
}
