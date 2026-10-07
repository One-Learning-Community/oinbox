import { FullCalendar, type FullCalendarHandle } from '@rozie-ui/fullcalendar-solid';
import { Popover } from '@rozie-ui/popover-solid';
import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { useApp } from '../app/context';
import { formatWhen, STATUS_LABELS } from '../calendar/format';
import { calendarPatch, defaultCalendarId, editability, hasGuests, initialCalendarId, localDate, newEventFromSelection, patchForDrop, writableCalendars } from '../calendar/edit';
import { toCalendarInput, toUtcDate, type DisplayEvent } from '../calendar/instances';
import { loadView, saveView } from '../calendar/prefs';
import { EventForm } from './EventForm';
import { createNotifyDialog, type NotifyAnswer, type NotifyAsk } from './NotifyDialog';

/** FullCalendar re-creates every event element on a refetch; the id on the element lets a card find its event again. */
const CALENDAR_OPTIONS = {
  eventDidMount: ({ event, el }: { event: { id: string }; el: HTMLElement }) => {
    el.dataset.eventId = event.id;
  },
};
const eventElement = (id: string) => document.querySelector<HTMLElement>(`.calendar-host [data-event-id="${CSS.escape(id)}"]`);

const TOOLBAR = { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' };

/** Route component for /calendar: read-only month/week/day views of every visible calendar. */
export function CalendarView() {
  const { calendar, toast } = useApp();
  const [view, setView] = createSignal(loadView(window.innerWidth < 700));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const notify = createNotifyDialog();
  // The popovers dismiss on any click outside them, and the notify dialog is outside them.
  const [dialogs, setDialogs] = createSignal(0);
  const [formBusy, setFormBusy] = createSignal(0);
  const keepOpen = () => dialogs() > 0 || formBusy() > 0;
  const ask = async (a: NotifyAsk): Promise<NotifyAnswer> => {
    setDialogs((n) => n + 1);
    try {
      return await notify.ask(a);
    } finally {
      setDialogs((n) => n - 1);
    }
  };
  const trackBusy = (busy: boolean) => setFormBusy((n) => n + (busy ? 1 : -1));
  /** Bumped whenever the events handed to FullCalendar change; its source is then swapped. */
  let eventsGeneration = 0;
  const [handle, setHandle] = createSignal<FullCalendarHandle>();

  const events = createMemo(() => {
    eventsGeneration++;
    return calendar.state.events.flatMap((e) => {
      const input = toCalendarInput(e, calendar.state.calendars, calendar.hidden());
      return input ? [{ ...input, editable: editability(e, calendar.state.calendars).editable }] : [];
    });
  });

  interface Draft {
    start: Date;
    end: Date;
    allDay: boolean;
    anchor: HTMLElement;
  }
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const closeDraft = () => {
    setDraft(null);
    handle()?.clearSelection();
  };

  /** A drop or resize: write it, asking about guests first; put the event back if it isn't written. */
  async function commitTimes(id: string, start: Date | null, end: Date | null, revert: () => void) {
    const ev = calendar.state.events.find((e) => e.id === id);
    const api = handle()?.getApi()?.getEventById(id);
    if (!ev || !api || !start) return revert();
    // A refetch while we wait swaps FullCalendar's event source; reverting the old event then
    // would add a second copy next to the fresh one, and the fresh one already shows the server's state.
    const generation = eventsGeneration;
    const undo = () => {
      if (generation === eventsGeneration) revert();
    };
    let sendMessages = false;
    if (hasGuests(ev)) {
      const answer = await ask({
        title: 'Change this event?',
        message: `"${ev.title}" has guests. Email them the new time?`,
        guests: true,
        confirmLabel: 'Change',
      });
      if (answer === 'cancel') return undo();
      sendMessages = answer === 'notify';
    }
    const r = await calendar.updateEvent(ev.baseEventId, patchForDrop(ev, start, end, api.allDay, zone), sendMessages);
    if (!r.ok) {
      undo();
      toast(`Couldn't change the event: ${r.error}`, 'error');
    }
  }

  const [selected, setSelected] = createSignal<Selected | null>(null);
  /** The selected event as the store has it now: the card follows refetches. */
  const selectedEvent = createMemo(() => {
    const id = selected()?.id;
    return id ? (calendar.state.events.find((e) => e.id === id) ?? null) : null;
  });

  // A refetch replaces the event elements, so the card's anchor is looked up again once they exist.
  createEffect(
    on(events, () =>
      requestAnimationFrame(() => {
        const s = selected();
        const el = s && eventElement(s.id);
        if (s && el && el !== s.el) setSelected({ id: s.id, el });
      }),
    { defer: true }),
  );

  // The event was deleted (here or elsewhere) while its card was open.
  createEffect(() => {
    if (selected() && !calendar.state.loading && !selectedEvent()) {
      setSelected(null);
      toast('That event no longer exists.');
    }
  });

  const closeSelected = () => {
    const s = selected();
    setSelected(null);
    // Focus was inside the card; give it back to the event unless the user already moved it.
    if (s) queueMicrotask(() => {
      if (!document.activeElement || document.activeElement === document.body) (eventElement(s.id) ?? s.el).focus();
    });
  };

  return (
    <section class="calendar-view" aria-label="Calendar">
      <div class="calendar-progress" classList={{ active: calendar.state.loading }} />
      <div class="calendar-host">
        <FullCalendar
          view={view()}
          onViewChange={(v) => {
            setView(v);
            saveView(v);
          }}
          events={events()}
          options={CALENDAR_OPTIONS}
          ref={setHandle}
          editable
          onEventDrop={({ event, revert }) => void commitTimes(event.id, event.start, event.end, revert)}
          onEventResize={({ event, revert }) => void commitTimes(event.id, event.start, event.end, revert)}
          selectable
          onSelect={({ start, end, allDay }) => {
            if (!defaultCalendarId(calendar.state.calendars)) {
              handle()?.clearSelection();
              return toast('No calendar here accepts new events.', 'error');
            }
            // After the click that ends the drag (the popover would count it as an outside click),
            // when FullCalendar has also drawn the highlight element the form anchors to.
            setTimeout(() => {
              const anchor = document.querySelector<HTMLElement>('.calendar-host .fc-highlight') ?? document.querySelector<HTMLElement>('.calendar-host')!;
              setDraft({ start, end, allDay, anchor });
            }, 0);
          }}
          nowIndicator
          height="100%"
          defaultColor="var(--cal-default)"
          headerToolbar={TOOLBAR}
          onEventClick={({ event, el }) => {
            if (calendar.state.events.some((e) => e.id === event.id)) setSelected({ id: event.id, el });
          }}
          onDatesSet={({ start, end }) => void calendar.show({ start: toUtcDate(start), end: toUtcDate(end) })}
        />
      </div>
      <EventPopover selected={selected()} event={selectedEvent()} onClose={closeSelected} notify={ask} keepOpen={keepOpen} onBusy={trackBusy} />
      <Popover open={!!draft()} disableDismiss={keepOpen()} bare onOpenChange={(open) => !open && closeDraft()} trigger="manual" strategy="fixed" placement="right-start" reference={draft()?.anchor ?? null}>
        <Show when={draft()} keyed>
          {(d) => (
            <EventForm
              when={formatWhen({ start: d.allDay ? localDate(d.start) : d.start.toISOString(), end: d.allDay ? localDate(d.end) : d.end.toISOString(), allDay: d.allDay })}
              calendars={writableCalendars(calendar.state.calendars)}
              title=""
              calendarId={defaultCalendarId(calendar.state.calendars)!}
              saveLabel="Create"
              onCancel={closeDraft}
              onBusy={trackBusy}
              onSave={async (title, calendarId) => {
                const r = await calendar.createEvent(newEventFromSelection(d, calendarId, title, zone));
                if (r.ok) closeDraft();
                return r.ok ? null : r.error;
              }}
            />
          )}
        </Show>
      </Popover>
      <notify.Host />
    </section>
  );
}

/** The event whose details are showing, and its element in the calendar. */
interface Selected {
  id: string;
  el: HTMLElement;
}

/**
 * Read-only event details, placed beside the clicked event's element. One Popover serves every
 * event: it decides an outside click a tick after the press, and by then a click on another
 * event has pointed `reference` at that event, so the card moves there instead of closing.
 */
function EventPopover(props: { selected: Selected | null; event: DisplayEvent | null; onClose: () => void; notify: (a: NotifyAsk) => Promise<NotifyAnswer>; keepOpen: () => boolean; onBusy: (busy: boolean) => void }) {
  return (
    <Popover open={!!props.selected} disableDismiss={props.keepOpen()} bare onOpenChange={(open) => !open && props.onClose()} trigger="manual" strategy="fixed" placement="right-start" reference={props.selected?.el ?? null}>
      {/* Keyed by id, not by the event object: a refetch must not reset an open form. */}
      <Show when={props.selected?.id} keyed>
        {(_id) => <EventCard event={props.event} notify={props.notify} onClose={props.onClose} onBusy={props.onBusy} />}
      </Show>
    </Popover>
  );
}

function EventCard(props: { event: DisplayEvent | null; notify: (a: NotifyAsk) => Promise<NotifyAnswer>; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const { calendar, toast } = useApp();
  // The last event the store had, so the card still renders for the moment before it closes itself.
  const event = createMemo<DisplayEvent>((previous) => props.event ?? previous, props.event!);
  const state = () => editability(event(), calendar.state.calendars);
  const [editing, setEditing] = createSignal(false);
  let editButton: HTMLButtonElement | undefined;

  const cancelEdit = () => {
    setEditing(false);
    queueMicrotask(() => editButton?.focus());
  };

  // The event changed under an open form: it can't be edited any more.
  createEffect(() => {
    const s = state();
    if (editing() && !s.editable) {
      setEditing(false);
      toast(s.reason);
    }
  });

  async function save(title: string, calendarId: string): Promise<string | null> {
    const ev = event();
    const patch: Record<string, unknown> = {};
    if (title !== ev.title && !(ev.title === '(No title)' && title === '')) patch.title = title;
    if (calendarId !== initialCalendarId(ev, calendar.state.calendars)) Object.assign(patch, calendarPatch(ev.calendarIds, calendarId));
    if (!Object.keys(patch).length) {
      setEditing(false);
      return null;
    }
    let sendMessages = false;
    if (patch.title !== undefined && hasGuests(ev)) {
      const answer = await props.notify({ title: 'Rename this event?', message: `"${ev.title}" has guests. Email them the change?`, guests: true, confirmLabel: 'Rename' });
      if (answer === 'cancel') return null;
      sendMessages = answer === 'notify';
    }
    const r = await calendar.updateEvent(ev.baseEventId, patch, sendMessages);
    if (r.ok) {
      setEditing(false);
      props.onClose();
      return null;
    }
    return r.error;
  }

  async function remove() {
    const ev = event();
    const guests = hasGuests(ev);
    const answer = await props.notify({
      title: 'Delete this event?',
      message: guests ? `"${ev.title}" has guests. Email them that it is cancelled?` : `"${ev.title}" will be deleted.`,
      guests,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (answer === 'cancel') return;
    const r = await calendar.deleteEvent(ev.baseEventId, answer === 'notify');
    if (r.ok) props.onClose();
    else toast(`Couldn't delete the event: ${r.error}`, 'error');
  }

  const calendarName = () =>
    event().calendarIds.map((id) => calendar.state.calendars[id]?.name).find((n) => n) ?? '';
  return (
    <Show
      when={!editing()}
      fallback={
        <EventForm
          when={formatWhen(event())}
          calendars={writableCalendars(calendar.state.calendars)}
          title={event().title === '(No title)' ? '' : event().title}
          calendarId={initialCalendarId(event(), calendar.state.calendars)}
          saveLabel="Save"
          onCancel={cancelEdit}
          onBusy={props.onBusy}
          onSave={save}
        />
      }
    >
    <div class="event-card" role="dialog" aria-label={event().title}>
      <h3>{event().title}</h3>
      <p class="when">{formatWhen(event())}</p>
      <Show when={event().location}>{(l) => <p class="where">{l()}</p>}</Show>
      <Show when={event().description}>{(d) => <p class="description">{d()}</p>}</Show>
      <Show when={event().participants.length}>
        <ul class="participants">
          <For each={event().participants}>
            {(p) => (
              <li>
                <span class="who" title={p.address}>{p.name}</span>
                <span class="rsvp">{STATUS_LABELS[p.status] ?? p.status}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="calendar-name">{calendarName()}</p>
      <Show when={state()} keyed>
        {(s) =>
          s.editable ? (
            <div class="card-actions">
              <button ref={editButton} onClick={() => setEditing(true)}>Edit</button>
              <button class="danger-link" onClick={() => void remove()}>Delete</button>
            </div>
          ) : (
            <p class="why-readonly">{s.reason}</p>
          )
        }
      </Show>
    </div>
    </Show>
  );
}
