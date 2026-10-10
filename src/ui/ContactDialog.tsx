import { Dialog } from '@rozie-ui/dialog-solid';
import { useLocation, useNavigate } from '@solidjs/router';
import { For, Show, createEffect, createSignal } from 'solid-js';
import { createStore, unwrap } from 'solid-js/store';
import type { ContactDialogState } from '../app/contacts';
import { useApp } from '../app/context';
import { MAX_CARD_BYTES, cardBytes, newCard, patchFor, toForm, validateForm, type AddressLabel, type ContactForm, type EmailLabel, type FormErrors, type PhoneLabel } from '../contacts/card';
import { photoDataUri } from '../contacts/photo';
import { Avatar } from './Avatar';
import { Icon } from './icons';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** New, edit and add-from-mail share one dialog, opened through `contacts.openDialog`. */
export function ContactDialog() {
  const { contacts } = useApp();
  return (
    <Show when={contacts.dialog()} keyed>
      {(state) => <ContactFormView state={state} />}
    </Show>
  );
}

/** The form a dialog starts with: the card's, with an empty row where a new person would want one. */
function startForm(state: ContactDialogState, card: Parameters<typeof toForm>[0]): ContactForm {
  const form = state.kind === 'edit' ? toForm(card) : toForm(undefined, state.seed);
  if (!form.emails.length) form.emails.push({ address: '', label: 'other', preferred: true });
  if (!form.phones.length) form.phones.push({ number: '', label: 'mobile' });
  return form;
}

function ContactFormView(props: { state: ContactDialogState }) {
  const { contacts, toast, confirm } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const editing = props.state.kind === 'edit' ? props.state.id : undefined;
  const stored = () => (editing ? contacts.state.cards[editing] : undefined);
  const first = stored();
  const initial = startForm(props.state, first ? structuredClone(unwrap(first)) : undefined);
  const pristine = JSON.stringify(initial);
  const [form, setForm] = createStore<ContactForm>(structuredClone(initial));
  const [errors, setErrors] = createSignal<FormErrors>({});
  const [failure, setFailure] = createSignal('');
  const [photoError, setPhotoError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [gone, setGone] = createSignal(false);
  let root: HTMLFormElement | undefined;
  let file: HTMLInputElement | undefined;

  // The card was deleted on another device while it was being edited here.
  createEffect(() => {
    if (editing && !stored() && !busy()) setGone(true);
  });

  const snapshot = (): ContactForm => structuredClone(unwrap(form));

  const requestClose = async () => {
    if (busy()) return;
    if (JSON.stringify(snapshot()) !== pristine) {
      const ok = await confirm({ title: 'Discard changes?', message: 'What you changed in this contact will be lost.', confirmLabel: 'Discard' });
      if (!ok) return;
    }
    contacts.closeDialog();
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy() || gone()) return;
    const values = snapshot();
    const found = validateForm(values);
    const card = stored();
    const next = card ? { ...unwrap(card), ...patchFor(unwrap(card), values, '') } : newCard(values, 'b', '', 'urn:uuid:00000000-0000-0000-0000-000000000000');
    if (cardBytes(next) > MAX_CARD_BYTES) found.size = 'This contact is too large to save. Try a smaller photo or shorter notes.';
    setErrors(found);
    setFailure('');
    if (Object.keys(found).length) {
      queueMicrotask(() => root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      const result = editing ? await contacts.update(editing, values) : await contacts.create(values);
      if (!result.ok) {
        setFailure(result.error);
        return;
      }
      contacts.closeDialog();
      if (editing) return;
      if (/(^|\/)contacts(\/|$)/.test(location.pathname)) navigate(`/contacts/${result.id}`);
      else toast('Saved to contacts.');
    } finally {
      setBusy(false);
    }
  };

  const pickPhoto = async (picked: File | undefined) => {
    if (!picked) return;
    setPhotoError('');
    try {
      setForm('photo', await photoDataUri(picked));
    } catch {
      setPhotoError('That file is not a picture this browser can read.');
    }
  };

  const setPreferred = (index: number) => setForm('emails', (rows) => rows.map((r, i) => ({ ...r, preferred: i === index })));
  const removeEmail = (index: number) =>
    setForm('emails', (rows) => {
      const left = rows.filter((_, i) => i !== index);
      return left.some((r) => r.preferred) ? left : left.map((r, i) => ({ ...r, preferred: i === 0 }));
    });
  const several = () => form.emails.filter((e) => e.address.trim()).length > 1 || form.emails.length > 1;
  const disabled = () => busy() || gone();
  const shownName = () => `${form.given} ${form.surname}`.trim() || form.organization.trim() || '?';

  return (
    <Dialog open class="contact-dialog" onOpenChange={(open) => !open && void requestClose()} ariaLabelledby="contact-dialog-title" initialFocus="#contact-given">
      <form ref={root} class="contact-form" novalidate onSubmit={(e) => void submit(e)}>
        <h2 id="contact-dialog-title">{editing ? 'Edit contact' : 'New contact'}</h2>
        <div class="contact-form-body">
          <div class="contact-form-photo">
            <Avatar name={shownName()} seed={form.emails[0]?.address || shownName()} photo={form.photo} size={64} />
            <div class="contact-form-photo-actions">
              <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void pickPhoto(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
              <button type="button" disabled={disabled()} onClick={() => file?.click()}>Choose photo</button>
              <Show when={form.photo}>
                <button type="button" disabled={disabled()} onClick={() => setForm('photo', null)}>Remove photo</button>
              </Show>
              <p class="contact-error" role="alert">{photoError()}</p>
            </div>
          </div>

          <div class="contact-form-pair">
            <label>
              <span>Given name</span>
              <input id="contact-given" type="text" autocomplete="off" disabled={disabled()} aria-invalid={!!errors().name} aria-describedby="contact-name-error" value={form.given} onInput={(e) => setForm('given', e.currentTarget.value)} />
            </label>
            <label>
              <span>Surname</span>
              <input type="text" autocomplete="off" disabled={disabled()} value={form.surname} onInput={(e) => setForm('surname', e.currentTarget.value)} />
            </label>
          </div>
          <p id="contact-name-error" class="contact-error" role="alert">{errors().name ?? ''}</p>

          <fieldset>
            <legend>Email</legend>
            <For each={form.emails}>
              {(row, i) => (
                <>
                  <div class="contact-form-row">
                    <input
                      type="email"
                      aria-label={`Email ${i() + 1}`}
                      aria-invalid={!!errors()[`emails.${i()}`]}
                      aria-describedby={`contact-email-error-${i()}`}
                      autocomplete="off"
                      spellcheck={false}
                      disabled={disabled()}
                      value={row.address}
                      onInput={(e) => setForm('emails', i(), 'address', e.currentTarget.value)}
                    />
                    <select aria-label={`Email ${i() + 1} type`} disabled={disabled()} value={row.label} onChange={(e) => setForm('emails', i(), 'label', e.currentTarget.value as EmailLabel)}>
                      <option value="work">Work</option>
                      <option value="personal">Personal</option>
                      <option value="other">Other</option>
                    </select>
                    <Show when={several()}>
                      <label class="contact-form-preferred">
                        <input type="radio" name="contact-preferred-email" disabled={disabled()} checked={row.preferred} onChange={() => setPreferred(i())} />
                        <span>Preferred</span>
                      </label>
                    </Show>
                    <button type="button" class="icon-btn" aria-label={`Remove email ${i() + 1}`} title="Remove" disabled={disabled()} onClick={() => removeEmail(i())}>
                      <Icon name="close" />
                    </button>
                  </div>
                  <p id={`contact-email-error-${i()}`} class="contact-error" role="alert">{errors()[`emails.${i()}`] ?? ''}</p>
                </>
              )}
            </For>
            <button type="button" class="contact-form-add" disabled={disabled()} onClick={() => setForm('emails', form.emails.length, { address: '', label: 'other', preferred: !form.emails.length })}>
              Add email
            </button>
          </fieldset>

          <fieldset>
            <legend>Phone</legend>
            <For each={form.phones}>
              {(row, i) => (
                <div class="contact-form-row">
                  <input type="tel" aria-label={`Phone ${i() + 1}`} autocomplete="off" disabled={disabled()} value={row.number} onInput={(e) => setForm('phones', i(), 'number', e.currentTarget.value)} />
                  <select aria-label={`Phone ${i() + 1} type`} disabled={disabled()} value={row.label} onChange={(e) => setForm('phones', i(), 'label', e.currentTarget.value as PhoneLabel)}>
                    <option value="mobile">Mobile</option>
                    <option value="work">Work</option>
                    <option value="home">Home</option>
                    <option value="other">Other</option>
                  </select>
                  <button type="button" class="icon-btn" aria-label={`Remove phone ${i() + 1}`} title="Remove" disabled={disabled()} onClick={() => setForm('phones', (rows) => rows.filter((_, x) => x !== i()))}>
                    <Icon name="close" />
                  </button>
                </div>
              )}
            </For>
            <button type="button" class="contact-form-add" disabled={disabled()} onClick={() => setForm('phones', form.phones.length, { number: '', label: 'mobile' })}>
              Add phone
            </button>
          </fieldset>

          <fieldset>
            <legend>Work</legend>
            <label>
              <span>Organisation</span>
              <input type="text" autocomplete="off" disabled={disabled()} value={form.organization} onInput={(e) => setForm('organization', e.currentTarget.value)} />
            </label>
            <div class="contact-form-pair">
              <label>
                <span>Department</span>
                <input type="text" autocomplete="off" disabled={disabled()} value={form.department} onInput={(e) => setForm('department', e.currentTarget.value)} />
              </label>
              <label>
                <span>Job title</span>
                <input type="text" autocomplete="off" disabled={disabled()} value={form.title} onInput={(e) => setForm('title', e.currentTarget.value)} />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Address</legend>
            <For each={form.addresses}>
              {(row, i) => (
                <div class="contact-form-row top">
                  <textarea aria-label={`Address ${i() + 1}`} rows={3} autocomplete="off" disabled={disabled()} value={row.text} onInput={(e) => setForm('addresses', i(), 'text', e.currentTarget.value)} />
                  <select aria-label={`Address ${i() + 1} type`} disabled={disabled()} value={row.label} onChange={(e) => setForm('addresses', i(), 'label', e.currentTarget.value as AddressLabel)}>
                    <option value="work">Work</option>
                    <option value="home">Home</option>
                    <option value="other">Other</option>
                  </select>
                  <button type="button" class="icon-btn" aria-label={`Remove address ${i() + 1}`} title="Remove" disabled={disabled()} onClick={() => setForm('addresses', (rows) => rows.filter((_, x) => x !== i()))}>
                    <Icon name="close" />
                  </button>
                </div>
              )}
            </For>
            <button type="button" class="contact-form-add" disabled={disabled()} onClick={() => setForm('addresses', form.addresses.length, { text: '', label: 'home' })}>
              Add address
            </button>
          </fieldset>

          <fieldset>
            <legend>Birthday</legend>
            <div class="contact-form-row birthday">
              <input type="text" inputmode="numeric" aria-label="Birthday day" placeholder="Day" autocomplete="off" disabled={disabled()} aria-invalid={!!errors().birthday} aria-describedby="contact-birthday-error" value={form.birthday.day} onInput={(e) => setForm('birthday', 'day', e.currentTarget.value)} />
              <select aria-label="Birthday month" disabled={disabled()} value={form.birthday.month} onChange={(e) => setForm('birthday', 'month', e.currentTarget.value)}>
                <option value="">Month</option>
                <For each={MONTHS}>{(m, i) => <option value={String(i() + 1)}>{m}</option>}</For>
              </select>
              <input type="text" inputmode="numeric" aria-label="Birthday year" placeholder="Year (optional)" autocomplete="off" disabled={disabled()} value={form.birthday.year} onInput={(e) => setForm('birthday', 'year', e.currentTarget.value)} />
            </div>
            <p id="contact-birthday-error" class="contact-error" role="alert">{errors().birthday ?? ''}</p>
          </fieldset>

          <label>
            <span>Notes</span>
            <textarea rows={3} disabled={disabled()} value={form.notes} onInput={(e) => setForm('notes', e.currentTarget.value)} />
          </label>
        </div>
        <p class="contact-error contact-form-foot" role="alert">
          {gone() ? 'This contact was deleted elsewhere.' : (errors().size ?? failure())}
        </p>
        <div class="dialog-actions">
          <button type="button" disabled={busy()} onClick={() => void requestClose()}>Cancel</button>
          <button type="submit" class="primary" disabled={disabled()}>{busy() ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}
