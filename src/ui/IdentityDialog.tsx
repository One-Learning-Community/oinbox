import { Dialog } from '@rozie-ui/dialog-solid';
import { TipTap, type TipTapHandle } from '@rozie-ui/tiptap-solid';
import { createEffect, createSignal, Show } from 'solid-js';
import { useApp } from '../app/context';
import { FieldError, type Field } from '../app/settings';
import type { Id } from '../jmap/types';
import { checkIdentity, signatureForCompose } from '../mail/settings';
import { FormatToolbar } from './FormatToolbar';

/** Add (id null) or edit an identity: name, address (fixed once created) and signature. */
export function IdentityDialog(props: { id: Id | null; onClose: () => void }) {
  const { engine, settings, client, toast } = useApp();
  const creating = props.id === null;
  const editing = props.id ? engine.state.identities.find((i) => i.id === props.id) : undefined;
  const [name, setName] = createSignal(editing?.name ?? '');
  const [email, setEmail] = createSignal(editing?.email ?? client.session.username);
  const [signature, setSignature] = createSignal(editing ? signatureForCompose(editing) : '');
  const [errors, setErrors] = createSignal<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = createSignal(false);
  let editor: TipTapHandle | undefined;

  // Deleted elsewhere while the dialog was open.
  createEffect(() => {
    if (props.id && !engine.state.identities.some((i) => i.id === props.id)) {
      toast('This identity was deleted elsewhere.', 'info');
      props.onClose();
    }
  });

  const input = () => ({ name: name(), email: email(), signatureHtml: signature() });

  /** After a failed submit, correct the messages as the user types. */
  const recheck = () => {
    if (!Object.keys(errors()).length) return;
    const r = checkIdentity(input(), creating);
    setErrors(r.ok ? {} : { [r.field]: r.error });
  };

  const close = () => {
    if (!busy()) props.onClose();
  };

  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (busy()) return;
    setBusy(true);
    try {
      await settings.saveIdentity(props.id, input());
      props.onClose();
    } catch (err) {
      const f = err instanceof FieldError ? err : new FieldError('form', (err as Error).message);
      setErrors({ [f.field]: f.message });
    } finally {
      setBusy(false);
    }
  };

  const err = (f: Field) => errors()[f] ?? '';
  const action = () => (creating ? (busy() ? 'Adding…' : 'Add') : busy() ? 'Saving…' : 'Save');

  return (
    <Dialog open onOpenChange={(open) => !open && close()} ariaLabelledby="identity-dialog-title">
      <form
        class="settings-form identity-form"
        onSubmit={submit}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit(e);
          // ProseMirror prevents Escape in the editor, so the dialog's own cancel never fires from there.
          else if (e.key === 'Escape' && (e.target as HTMLElement).isContentEditable) close();
        }}
      >
        <h2 id="identity-dialog-title">{creating ? 'Add identity' : 'Edit identity'}</h2>

        <label class="field">
          <span>Name</span>
          <input type="text" autocomplete="name" value={name()} aria-invalid={!!err('name')} aria-describedby="identity-name-error"
            onInput={(e) => { setName(e.currentTarget.value); recheck(); }} />
        </label>
        <p id="identity-name-error" class="field-error" role="alert">{err('name')}</p>

        <Show
          when={creating}
          fallback={
            <div class="field">
              <span>Address</span>
              <p class="field-static" id="identity-address-hint">{email()} <small>The address can't be changed.</small></p>
            </div>
          }
        >
          <label class="field">
            <span>Address</span>
            <input type="email" autocomplete="email" spellcheck={false} value={email()} aria-invalid={!!err('email')} aria-describedby="identity-email-error"
              onInput={(e) => { setEmail(e.currentTarget.value); recheck(); }} />
          </label>
          <p id="identity-email-error" class="field-error" role="alert">{err('email')}</p>
        </Show>

        <div class="field">
          <span id="identity-signature-label">Signature</span>
          <div class="signature-editor" aria-describedby="identity-signature-error">
            <TipTap
              ref={(h: TipTapHandle) => (editor = h)}
              html={signature()}
              onHtmlChange={(html: string) => { setSignature(html === '<p></p>' ? '' : html); recheck(); }}
              ariaLabel="Signature"
              editorClass="compose-editor"
              toolbarSlot={() => <FormatToolbar editor={() => editor} />}
            />
          </div>
        </div>
        <p id="identity-signature-error" class="field-error" role="alert">{err('signature')}</p>

        <p class="field-error" role="alert">{err('form')}</p>
        <div class="dialog-actions">
          <button type="button" disabled={busy()} onClick={close}>Cancel</button>
          <button type="submit" class="primary" disabled={busy()}>{action()}</button>
        </div>
      </form>
    </Dialog>
  );
}
