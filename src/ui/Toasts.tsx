import { Toaster, type ToasterHandle } from '@rozie-ui/toast-solid';
import { Show } from 'solid-js';
import type { ToastFn } from '../app/actions';

/**
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
          <div class="toast" role={t.type === 'error' ? 'alert' : 'status'}>
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
