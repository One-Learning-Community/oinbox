import { Dialog } from '@rozie-ui/dialog-solid';
import { createEffect, createSignal, onMount, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { GroupDialogState } from '../app/contacts';
import { checkGroupName, groupName } from '../contacts/groups';

/** Create and rename share one dialog, as for labels: a single name, checked by the same rules. */
export function GroupDialog() {
  const { contacts } = useApp();
  return (
    <Show when={contacts.groupDialog()} keyed>
      {(state) => <GroupForm state={state} />}
    </Show>
  );
}

function GroupForm(props: { state: GroupDialogState }) {
  const { contacts, toast } = useApp();
  const renaming = props.state.kind === 'rename' ? props.state.id : undefined;
  const then = props.state.kind === 'create' ? (props.state.then ?? []) : [];
  const current = renaming ? contacts.state.cards[renaming] : undefined;
  const [text, setText] = createSignal(current ? groupName(current) : '');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;

  // The dialog focuses its first field as it opens; a name being renamed starts selected.
  onMount(() => input?.select());

  // The group was deleted elsewhere while its rename dialog was open.
  createEffect(() => {
    if (renaming && !contacts.state.cards[renaming]) contacts.closeGroupDialog();
  });

  const close = () => {
    if (!busy()) contacts.closeGroupDialog();
  };

  const onInput = (value: string) => {
    setText(value);
    // Correct the message as the user types, but only once one is showing.
    if (error()) setError(checkGroupName(value, contacts.groups(), renaming) ?? '');
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy()) return;
    const wrong = checkGroupName(text(), contacts.groups(), renaming);
    if (wrong) return void setError(wrong);
    setBusy(true);
    try {
      const name = text().trim();
      const saved = renaming ? await contacts.renameGroup(renaming, name) : await contacts.createGroup(name);
      if (!saved.ok) return void setError(saved.error);
      if (then.length) {
        const filled = await contacts.addToGroup(saved.id, then);
        if (filled.ok) toast(`Added ${then.length} to ${name}.`, 'info');
        else toast(`Couldn't add to ${name}: ${filled.error}`, 'error');
      }
      contacts.closeGroupDialog();
    } finally {
      setBusy(false);
    }
  };

  const action = () => (renaming ? (busy() ? 'Saving…' : 'Save') : busy() ? 'Creating…' : 'Create');

  return (
    <Dialog open onOpenChange={(open) => !open && close()} ariaLabelledby="group-dialog-title">
      <form class="label-form" onSubmit={submit}>
        <h2 id="group-dialog-title">{renaming ? 'Rename group' : 'New group'}</h2>
        <input
          ref={input}
          type="text"
          aria-label="Group name"
          aria-invalid={!!error()}
          aria-describedby="group-dialog-error"
          autocomplete="off"
          maxLength={120}
          value={text()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
        <p id="group-dialog-error" class="label-error" role="alert">{error()}</p>
        <div class="dialog-actions">
          <button type="button" disabled={busy()} onClick={close}>Cancel</button>
          <button type="submit" class="primary" disabled={busy()}>{action()}</button>
        </div>
      </form>
    </Dialog>
  );
}
