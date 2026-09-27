import { Dialog } from '@rozie-ui/dialog-solid';
import { createSignal, Show, type JSX } from 'solid-js';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
}

export interface ConfirmFn {
  (opts: ConfirmOptions): Promise<boolean>;
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/** A single blocking confirm dialog, queued one at a time via `confirm()`. */
export function createConfirmDialog(): { confirm: ConfirmFn; Host: () => JSX.Element } {
  const [pending, setPending] = createSignal<Pending | null>(null);

  const confirm: ConfirmFn = (opts) => new Promise((resolve) => setPending({ opts, resolve }));

  const finish = (ok: boolean) => {
    pending()?.resolve(ok);
    setPending(null);
  };

  const Host = () => (
    <Show when={pending()}>
      {(p) => (
        <Dialog open onOpenChange={(open) => !open && finish(false)} ariaLabelledby="confirm-title">
          <h2 id="confirm-title">{p().opts.title}</h2>
          <p>{p().opts.message}</p>
          <div class="dialog-actions">
            <button onClick={() => finish(false)}>Cancel</button>
            <button class="danger" onClick={() => finish(true)} autofocus>
              {p().opts.confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </Dialog>
      )}
    </Show>
  );

  return { confirm, Host };
}
