import { createSignal, Show } from 'solid-js';
import { PASSWORD_LENGTH, type Password, type PasswordField, type PasswordInput } from '../app/password';
import { FieldError, type Field } from '../app/settings';

const EMPTY: PasswordInput = { current: '', next: '', confirm: '' };

export function PasswordSection(props: { password: Password }) {
  const [form, setForm] = createSignal<PasswordInput>(EMPTY);
  const [errors, setErrors] = createSignal<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = createSignal(false);

  const update = (patch: Partial<PasswordInput>) => {
    setForm({ ...form(), ...patch });
    if (Object.keys(errors()).length) setErrors({});
  };

  const save = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    try {
      await props.password.change(form());
      // Changed: the app is signing out. The form stays locked until the page goes.
    } catch (err) {
      const f = err instanceof FieldError ? err : new FieldError('form', (err as Error).message);
      setErrors({ [f.field]: f.message });
      setBusy(false);
    }
  };

  const err = (f: Field) => errors()[f] ?? '';
  const field = (name: PasswordField, label: string, autocomplete: string, describedBy = '') => (
    <>
      <label class="field">
        <span>{label}</span>
        <input type="password" autocomplete={autocomplete} value={form()[name]} disabled={busy()}
          aria-invalid={err(name) ? 'true' : undefined} aria-describedby={`${describedBy} password-${name}-error`.trim()}
          onInput={(e) => update({ [name]: e.currentTarget.value })} />
      </label>
      <p id={`password-${name}-error`} class="field-error" role="alert">{err(name)}</p>
    </>
  );

  return (
    <section class="settings-section" aria-labelledby="password-heading">
      <h2 id="password-heading">Password</h2>
      <Show when={props.password.supported()} fallback={<p class="settings-note">Your password can't be changed here. Ask your administrator.</p>}>
        <form class="settings-form password-form" onSubmit={save}>
          {field('current', 'Current password', 'current-password')}
          {field('next', 'New password', 'new-password', 'password-next-hint')}
          <p id="password-next-hint" class="settings-note">{PASSWORD_LENGTH.min} to {PASSWORD_LENGTH.max} characters. Several uncommon words work well.</p>
          {field('confirm', 'Confirm new password', 'new-password')}
          <p class="field-error" role="alert">{err('form')}</p>
          <div class="dialog-actions">
            <button type="submit" class="primary" disabled={busy()}>{busy() ? 'Changing…' : 'Change password'}</button>
          </div>
        </form>
        <p class="settings-note">Changing your password signs you out everywhere, this browser included. Other mail apps will need the new one.</p>
      </Show>
    </section>
  );
}
