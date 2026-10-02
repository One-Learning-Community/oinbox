import { Dialog } from '@rozie-ui/dialog-solid';
import { createEffect, createSignal, onMount, Show } from 'solid-js';
import { useApp } from '../app/context';
import { labelPath } from '../sync/selectors';
import type { LabelDialogState } from './nav';

/** Create and rename share one dialog: a single path field, checked by the same rules. */
export function LabelDialog() {
  const { nav } = useApp();
  return (
    <Show when={nav.labelDialog()} keyed>
      {(state) => <LabelForm state={state} />}
    </Show>
  );
}

function LabelForm(props: { state: LabelDialogState }) {
  const { engine, labels, nav } = useApp();
  const renaming = props.state.kind === 'rename' ? props.state.id : undefined;
  const current = renaming ? engine.state.mailboxes[renaming] : undefined;
  const [text, setText] = createSignal(current ? labelPath(current, engine.state.mailboxes) : '');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;

  // The dialog focuses its first field as it opens; a name being renamed starts selected.
  onMount(() => input?.select());

  // The label was deleted elsewhere while its rename dialog was open.
  createEffect(() => {
    if (renaming && !engine.state.mailboxes[renaming]) nav.setLabelDialog(null);
  });

  const close = () => {
    if (!busy()) nav.setLabelDialog(null);
  };

  const onInput = (value: string) => {
    setText(value);
    // Correct the message as the user types, but only once one is showing.
    if (!error()) return;
    const check = labels.validate(value, renaming);
    setError(check.ok ? '' : check.error);
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    try {
      if (renaming) await labels.rename(renaming, text());
      else await labels.create(text());
      nav.setLabelDialog(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const action = () => (renaming ? (busy() ? 'Saving…' : 'Save') : busy() ? 'Creating…' : 'Create');

  return (
    <Dialog open onOpenChange={(open) => !open && close()} ariaLabelledby="label-dialog-title">
      <form class="label-form" onSubmit={submit}>
        <h2 id="label-dialog-title">{renaming ? 'Rename label' : 'New label'}</h2>
        <input
          ref={input}
          type="text"
          aria-label="Label name"
          aria-invalid={!!error()}
          aria-describedby="label-dialog-hint label-dialog-error"
          autocomplete="off"
          spellcheck={false}
          value={text()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
        <p id="label-dialog-hint" class="label-hint">Use / to nest, e.g. Clients/Acme</p>
        <p id="label-dialog-error" class="label-error" role="alert">{error()}</p>
        <div class="dialog-actions">
          <button type="button" disabled={busy()} onClick={close}>Cancel</button>
          <button type="submit" class="primary" disabled={busy()}>{action()}</button>
        </div>
      </form>
    </Dialog>
  );
}
