import { Toaster, type ToasterHandle } from '@rozie-ui/toast-solid';
import { Show } from 'solid-js';
import type { ToastFn } from '../app/actions';

/**
 * Announcing toasts is rozie Toaster's job: it writes each `message` into a standing live region,
 * assertive for errors and polite for the rest.
 * rozie Toast can't carry an action (docs/rozie-feedback.md), so actions live in a
 * side map keyed by toast id and render through toastSlot.
 */
export function createToasts() {
  let handle: ToasterHandle | undefined;
  const actions = new Map<string, { label: string; run: () => void }>();
  let seq = 0;

  const toast: ToastFn = (message, type = 'info', action) => {
    const id = `oinbox-${++seq}`;
    if (action) actions.set(id, action);
    handle?.show({ id, message, type, duration: action ? (action.forMs ?? 8000) : 5000 });
  };

  const Host = () => (
    <Toaster
      ref={(h) => (handle = h)}
      position="bottom-left"
      max={3}
      onDismissed={(...args: unknown[]) => {
        const e = args[0] as { toast?: { id?: string } } | undefined;
        if (e?.toast?.id) actions.delete(e.toast.id);
      }}
      toastSlot={({ toast: t, dismiss }) => {
        const action = () => actions.get(t.id);
        return (
          // No role here: the toaster announces the message itself. A live role on the row would read it twice.
          <div class="toast" data-type={t.type}>
            <span class="toast-msg">{t.message}</span>
            <Show when={action()}>
              {(a) => (
                <button
                  type="button"
                  class="toast-action"
                  onClick={() => {
                    a().run();
                    actions.delete(t.id);
                    dismiss(t.id);
                  }}
                >
                  {a().label}
                </button>
              )}
            </Show>
            <button type="button" class="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        );
      }}
    />
  );

  return { toast, Host };
}
