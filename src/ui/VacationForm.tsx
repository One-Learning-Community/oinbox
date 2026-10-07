import { DatePicker, type DatePickerHandle } from '@rozie-ui/date-picker-solid';
import { Popover } from '@rozie-ui/popover-solid';
import { Switch } from '@rozie-ui/switch-solid';
import { createEffect, createMemo, createSignal, on, Show } from 'solid-js';
import { useApp } from '../app/context';
import { FieldError, type Field } from '../app/settings';
import { browserTimeZone, describeVacation, LIMITS, localDay, utf8Length, vacationInput, vacationStatus, type VacationInput } from '../mail/settings';

const sameInput = (a: VacationInput, b: VacationInput) => JSON.stringify(a) === JSON.stringify(b);
const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function VacationForm() {
  const { engine, settings } = useApp();
  const server = () => vacationInput(engine.state.vacation);
  const [form, setForm] = createSignal<VacationInput>(server());
  const [base, setBase] = createSignal<VacationInput>(server());
  const [errors, setErrors] = createSignal<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = createSignal(false);
  const dirty = () => !sameInput(form(), base());
  const [stale, setStale] = createSignal(false);

  // Follow changes from elsewhere unless the user is in the middle of editing.
  createEffect(on(() => JSON.stringify(engine.state.vacation), () => {
    const next = server();
    if (sameInput(next, base())) return;
    if (dirty()) setStale(true);
    else {
      setForm(next);
      setBase(next);
    }
  }, { defer: true }));

  const update = (patch: Partial<VacationInput>) => {
    setForm({ ...form(), ...patch });
    if (Object.keys(errors()).length) setErrors({});
  };

  const revert = () => {
    setForm(server());
    setBase(server());
    setErrors({});
    setStale(false);
  };

  const save = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    try {
      await settings.saveVacation(form());
      revert();
    } catch (err) {
      const f = err instanceof FieldError ? err : new FieldError('form', (err as Error).message);
      setErrors({ [f.field]: f.message });
    } finally {
      setBusy(false);
    }
  };

  const status = createMemo(() => describeVacation(vacationStatus(engine.state.vacation, new Date())));
  const bytes = () => utf8Length(form().message);
  const today = () => localDay(new Date(), browserTimeZone());
  const err = (f: Field) => errors()[f] ?? '';

  return (
    <section class="settings-section" aria-labelledby="vacation-heading">
      <h2 id="vacation-heading">Vacation responder</h2>
      <Show when={engine.state.vacationLoad === 'ready'} fallback={<VacationUnavailable />}>
        <p class="vacation-status">{status()}</p>
        <form class="settings-form vacation-form" onSubmit={save}>
          <div class="switch-row">
            <Switch id="vacation-enabled" modelValue={form().enabled} onModelValueChange={(v: boolean) => update({ enabled: v })} />
            <label for="vacation-enabled">Send automatic replies</label>
          </div>
          <div class="day-row">
            <DayField label="First day" value={form().firstDay} empty="Starting now" min={form().firstDay && form().firstDay! < today() ? form().firstDay! : today()} onChange={(v) => update({ firstDay: v })} />
            <DayField label="Last day" value={form().lastDay} empty="No end date" min={form().firstDay ?? today()} onChange={(v) => update({ lastDay: v })} />
          </div>
          <p class="field-error" role="alert">{err('dates')}</p>
          <label class="field">
            <span>Subject</span>
            <input type="text" placeholder="Auto: (their subject)" value={form().subject} aria-describedby="vacation-subject-error"
              onInput={(e) => update({ subject: e.currentTarget.value })} />
          </label>
          <p id="vacation-subject-error" class="field-error" role="alert">{err('subject')}</p>
          <label class="field">
            <span>Message</span>
            <textarea rows={6} value={form().message} aria-describedby="vacation-message-count vacation-message-error"
              onInput={(e) => update({ message: e.currentTarget.value })} />
          </label>
          <p id="vacation-message-count" class="settings-note">
            {bytes() > LIMITS.vacationBody * 0.8 ? `${bytes().toLocaleString()} of ${LIMITS.vacationBody.toLocaleString()}` : ''}
          </p>
          <p id="vacation-message-error" class="field-error" role="alert">{err('message')}</p>
          <p class="field-error" role="alert">{err('form')}</p>
          <Show when={stale()}>
            <p class="settings-note">Changed on another device. Revert to see the new settings.</p>
          </Show>
          <div class="dialog-actions">
            <button type="button" disabled={busy() || (!dirty() && !stale())} onClick={revert}>Revert</button>
            <button type="submit" class="primary" disabled={busy()}>{busy() ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
        <p class="settings-note">Turning this on replaces any mail filter (Sieve script) set up elsewhere.</p>
      </Show>
    </section>
  );
}

function VacationUnavailable() {
  const { engine } = useApp();
  return (
    <Show when={engine.state.vacationLoad !== 'idle' && engine.state.vacationLoad !== 'loading'} fallback={<p class="settings-note">Loading…</p>}>
      <Show when={engine.state.vacationLoad === 'failed'} fallback={<p class="settings-note">This server doesn't offer a vacation responder.</p>}>
        <p class="settings-note">The vacation responder couldn't be loaded.</p>
        <button type="button" class="btn tonal" onClick={() => void engine.loadVacation().catch(() => undefined)}>Retry</button>
      </Show>
    </Show>
  );
}

/** A day, or the open choice (`empty`), picked from a calendar in a popover. */
function DayField(props: { label: string; value: string | null; empty: string; min: string; onChange: (day: string | null) => void }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let picker: DatePickerHandle | undefined;

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => picker?.focus());
  }, { defer: true }));

  const close = () => {
    setOpen(false);
    button?.focus();
  };

  const text = () => (props.value ? dayLabel(props.value) : props.empty);

  return (
    <div class="day-field">
      <span class="day-label">{props.label}</span>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="manual"
        placement="bottom-start"
        strategy="fixed"
        offset={4}
        anchorSlot={() => (
          <button ref={button} type="button" class="btn tonal day-button" aria-label={`${props.label}: ${text()}`} aria-haspopup="dialog" aria-expanded={open()}
            onClick={() => setOpen(!open())}>
            {text()}
          </button>
        )}
      >
        <div
          class="day-popover"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        >
          <DatePicker
            ref={(h: DatePickerHandle) => (picker = h)}
            value={props.value ?? ''}
            min={props.min}
            showFooter
            locale={navigator.language}
            labels={{ clear: props.empty, root: props.label }}
            onChange={(e: { value: string }) => {
              props.onChange(e.value || null);
              close();
            }}
          />
        </div>
      </Popover>
    </div>
  );
}
