import { Dialog } from '@rozie-ui/dialog-solid';
import { createSignal, Show, type JSX } from 'solid-js';

export type NotifyAnswer = 'notify' | 'silent' | 'cancel';

export interface NotifyAsk {
  title: string;
  message: string;
  /** With guests: Notify guests / Don't notify / Cancel. Without: Cancel and the action (answers 'silent'). */
  guests: boolean;
  confirmLabel: string;
  danger?: boolean;
}

interface Pending {
  ask: NotifyAsk;
  resolve: (a: NotifyAnswer) => void;
}

/** A blocking dialog that asks whether to email an event's guests about a change. */
export function createNotifyDialog(): { ask: (a: NotifyAsk) => Promise<NotifyAnswer>; Host: () => JSX.Element } {
  const [pending, setPending] = createSignal<Pending | null>(null);
  const ask = (a: NotifyAsk) => new Promise<NotifyAnswer>((resolve) => setPending({ ask: a, resolve }));
  const answer = (a: NotifyAnswer) => {
    pending()?.resolve(a);
    setPending(null);
  };

  const Host = () => (
    <Show when={pending()}>
      {(p) => (
        <Dialog open onOpenChange={(open) => !open && answer('cancel')} ariaLabelledby="notify-title">
          <h2 id="notify-title">{p().ask.title}</h2>
          <p>{p().ask.message}</p>
          <div class="dialog-actions">
            <button onClick={() => answer('cancel')}>Cancel</button>
            <Show
              when={p().ask.guests}
              fallback={
                <button class={p().ask.danger ? 'danger' : 'primary'} onClick={() => answer('silent')} autofocus>
                  {p().ask.confirmLabel}
                </button>
              }
            >
              <button onClick={() => answer('silent')}>Don't notify</button>
              <button class="primary" onClick={() => answer('notify')} autofocus>Notify guests</button>
            </Show>
          </div>
        </Dialog>
      )}
    </Show>
  );

  return { ask, Host };
}
