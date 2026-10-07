import { createSignal, For, onMount, Show } from 'solid-js';
import type { Calendar, Id } from '../jmap/types';

export interface EventFormProps {
  when: string;
  calendars: Calendar[];
  title: string;
  calendarId: Id;
  saveLabel: string;
  /** Resolve with an error message to show, or null when saved. */
  onSave: (title: string, calendarId: Id) => Promise<string | null>;
  onCancel: () => void;
  /** Tells the host while a save is in flight, so it can keep the card from being dismissed. */
  onBusy?: (busy: boolean) => void;
}

/** Title and calendar of one event, in a card. Enter saves; the card stays open until the server answers. */
export function EventForm(props: EventFormProps) {
  const [title, setTitle] = createSignal(props.title);
  const [calendarId, setCalendarId] = createSignal(props.calendarId);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;
  onMount(() =>
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    }),
  );

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    props.onBusy?.(true);
    setError('');
    try {
      const message = await props.onSave(title().trim(), calendarId());
      if (message) setError(message);
    } finally {
      setBusy(false);
      props.onBusy?.(false);
    }
  };

  return (
    <form class="event-card event-form" aria-label="Event" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && !busy() && props.onCancel()}>
      <input ref={input} type="text" aria-label="Title" placeholder="Add a title" autocomplete="off" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
      <p class="when">{props.when}</p>
      <Show when={props.calendars.length > 1}>
        <select aria-label="Calendar" value={calendarId()} onChange={(e) => setCalendarId(e.currentTarget.value)}>
          <For each={props.calendars}>{(c) => <option value={c.id}>{c.name}</option>}</For>
        </select>
      </Show>
      <p class="form-error" role="alert">{error()}</p>
      <div class="dialog-actions">
        <button type="button" disabled={busy()} onClick={props.onCancel}>Cancel</button>
        <button type="submit" class="primary" disabled={busy()}>{busy() ? 'Saving…' : props.saveLabel}</button>
      </div>
    </form>
  );
}
