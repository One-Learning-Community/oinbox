import { FullCalendar } from '@rozie-ui/fullcalendar-solid';
import { Popover } from '@rozie-ui/popover-solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { useApp } from '../app/context';
import { formatWhen, STATUS_LABELS } from '../calendar/format';
import { toCalendarInput, toUtcDate, type CalendarInput, type DisplayEvent } from '../calendar/instances';
import { loadView, saveView } from '../calendar/prefs';

const TOOLBAR = { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' };

/** Route component for /calendar: read-only month/week/day views of every visible calendar. */
export function CalendarView() {
  const { calendar } = useApp();
  const [view, setView] = createSignal(loadView(window.innerWidth < 700));

  const events = createMemo(() =>
    calendar.state.events
      .map((e) => toCalendarInput(e, calendar.state.calendars, calendar.hidden()))
      .filter((e): e is CalendarInput => e !== null),
  );

  const [selected, setSelected] = createSignal<{ event: DisplayEvent; el: HTMLElement } | null>(null);

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
          editable={false}
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
      <Show when={selected()} keyed>
        {(s) => <EventPopover event={s.event} anchor={s.el} onClose={() => setSelected(null)} />}
      </Show>
    </section>
  );
}

/** Read-only event details, placed beside the clicked event's element. */
function EventPopover(props: { event: DisplayEvent; anchor: HTMLElement; onClose: () => void }) {
  const { calendar } = useApp();
  const calendarName = () =>
    props.event.calendarIds.map((id) => calendar.state.calendars[id]?.name).find((n) => n) ?? '';
  return (
    <Popover open bare onOpenChange={(open) => !open && props.onClose()} trigger="manual" strategy="fixed" placement="right-start" reference={props.anchor}>
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
      </div>
    </Popover>
  );
}
