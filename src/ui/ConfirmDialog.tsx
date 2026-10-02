import { Dialog } from '@rozie-ui/dialog-solid';
import { createSignal, Show, type JSX } from 'solid-js';
import { restoreFocus } from './focus';

export interface ConfirmOptions {
  title: string;
  /** A function is read reactively, so the text can change while the dialog is open. */
  message: string | (() => string);
  confirmLabel?: string;
  /** Work to do on confirm. The dialog stays open, showing `pendingLabel`, until it settles. */
  run?: () => Promise<void>;
  pendingLabel?: string;
}

export interface ConfirmFn {
  /** Resolves whether the user confirmed. With `run`, resolves after it finished and rejects if it failed. */
  (opts: ConfirmOptions): Promise<boolean>;
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
  reject: (e: unknown) => void;
}

/** A single blocking confirm dialog, queued one at a time via `confirm()`. */
export function createConfirmDialog(): { confirm: ConfirmFn; Host: () => JSX.Element } {
  const [pending, setPending] = createSignal<Pending | null>(null);
  const [busy, setBusy] = createSignal(false);

  const confirm: ConfirmFn = (opts) => new Promise((resolve, reject) => setPending({ opts, resolve, reject }));

  const finish = (ok: boolean) => {
    const p = pending();
    if (!p || busy()) return;
    if (ok && p.opts.run) {
      setBusy(true);
      p.opts.run().then(() => p.resolve(true), p.reject).finally(() => {
        setBusy(false);
        setPending(null);
      });
      return;
    }
    p.resolve(ok);
    setPending(null);
  };

  const Host = () => (
    <Show when={pending()}>
      {(p) => {
        restoreFocus();
        const message = () => {
          const m = p().opts.message;
          return typeof m === 'function' ? m() : m;
        };
        return (
          <Dialog open onOpenChange={(open) => !open && finish(false)} ariaLabelledby="confirm-title">
            <h2 id="confirm-title">{p().opts.title}</h2>
            <p>{message()}</p>
            <div class="dialog-actions">
              <button disabled={busy()} onClick={() => finish(false)}>Cancel</button>
              <button class="danger" disabled={busy()} onClick={() => finish(true)} autofocus>
                {busy() ? (p().opts.pendingLabel ?? p().opts.confirmLabel ?? 'Confirm') : (p().opts.confirmLabel ?? 'Confirm')}
              </button>
            </div>
          </Dialog>
        );
      }}
    </Show>
  );

  return { confirm, Host };
}
