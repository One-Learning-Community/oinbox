import { FullCalendar, type FullCalendarHandle } from '@rozie-ui/fullcalendar-solid';
import { Popover } from '@rozie-ui/popover-solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { useApp } from '../app/context';
import { formatWhen, STATUS_LABELS } from '../calendar/format';
import { editability, hasGuests, patchForDrop } from '../calendar/edit';
import { toCalendarInput, toUtcDate, type DisplayEvent } from '../calendar/instances';
import { loadView, saveView } from '../calendar/prefs';
import { createNotifyDialog, type NotifyAnswer, type NotifyAsk } from './NotifyDialog';

const TOOLBAR = { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' };

/** Route component for /calendar: read-only month/week/day views of every visible calendar. */
export function CalendarView() {
  const { calendar, toast } = useApp();
  const [view, setView] = createSignal(loadView(window.innerWidth < 700));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const notify = createNotifyDialog();
  const [handle, setHandle] = createSignal<FullCalendarHandle>();

  const events = createMemo(() =>
    calendar.state.events.flatMap((e) => {
      const input = toCalendarInput(e, calendar.state.calendars, calendar.hidden());
      return input ? [{ ...input, editable: editability(e, calendar.state.calendars).editable }] : [];
    }),
  );

  /** A drop or resize: write it, asking about guests first; put the event back if it isn't written. */
  async function commitTimes(id: string, start: Date | null, end: Date | null, revert: () => void) {
    const ev = calendar.state.events.find((e) => e.id === id);
    const api = handle()?.getApi()?.getEventById(id);
    if (!ev || !api || !start) return revert();
    let sendMessages = false;
    if (hasGuests(ev)) {
      const answer = await notify.ask({
        title: 'Change this event?',
        message: `"${ev.title}" has guests. Email them the new time?`,
        guests: true,
        confirmLabel: 'Change',
      });
      if (answer === 'cancel') return revert();
      sendMessages = answer === 'notify';
    }
    const r = await calendar.updateEvent(ev.baseEventId, patchForDrop(ev, start, end, api.allDay, zone), sendMessages);
    if (!r.ok) {
      revert();
      toast(`Couldn't change the event: ${r.error}`, 'error');
    }
  }

  const [selected, setSelected] = createSignal<Selected | null>(null);

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
          ref={setHandle}
          editable
          onEventDrop={({ event, revert }) => void commitTimes(event.id, event.start, event.end, revert)}
          onEventResize={({ event, revert }) => void commitTimes(event.id, event.start, event.end, revert)}
          selectable={false}
          nowIndicator
          height="100%"
          defaultColor="var(--cal-default)"
          headerToolbar={TOOLBAR}
          onEventClick={({ event, el }) => {
            const ev = calendar.state.events.find((e) => e.id === event.id);
            if (ev) setSelected({ event: ev, el });
          }}
          onDatesSet={({ start, end }) => void calendar.show({ start: toUtcDate(start), end: toUtcDate(end) })}
        />
      </div>
      <EventPopover selected={selected()} onClose={() => setSelected(null)} notify={notify.ask} />
      <notify.Host />
    </section>
  );
}

/** The event whose details are showing, and its element in the calendar. */
interface Selected {
  event: DisplayEvent;
  el: HTMLElement;
}

/**
 * Read-only event details, placed beside the clicked event's element. One Popover serves every
 * event: it decides an outside click a tick after the press, and by then a click on another
 * event has pointed `reference` at that event, so the card moves there instead of closing.
 */
function EventPopover(props: { selected: Selected | null; onClose: () => void; notify: (a: NotifyAsk) => Promise<NotifyAnswer> }) {
  return (
    <Popover open={!!props.selected} bare onOpenChange={(open) => !open && props.onClose()} trigger="manual" strategy="fixed" placement="right-start" reference={props.selected?.el ?? null}>
      <Show when={props.selected?.event} keyed>
        {(event) => <EventCard event={event} notify={props.notify} onClose={props.onClose} />}
      </Show>
    </Popover>
  );
}

function EventCard(props: { event: DisplayEvent; notify: (a: NotifyAsk) => Promise<NotifyAnswer>; onClose: () => void }) {
  const { calendar, toast } = useApp();
  const state = () => editability(props.event, calendar.state.calendars);

  async function remove() {
    const ev = props.event;
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
    props.event.calendarIds.map((id) => calendar.state.calendars[id]?.name).find((n) => n) ?? '';
  return (
    <div class="event-card" role="dialog" aria-label={props.event.title}>
      <h3>{props.event.title}</h3>
      <p class="when">{formatWhen(props.event)}</p>
      <Show when={props.event.location}>{(l) => <p class="where">{l()}</p>}</Show>
      <Show when={props.event.description}>{(d) => <p class="description">{d()}</p>}</Show>
      <Show when={props.event.participants.length}>
        <ul class="participants">
          <For each={props.event.participants}>
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
              <button class="danger-link" onClick={() => void remove()}>Delete</button>
            </div>
          ) : (
            <p class="why-readonly">{s.reason}</p>
          )
        }
      </Show>
    </div>
  );
}
