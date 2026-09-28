import { FullCalendar } from '@rozie-ui/fullcalendar-solid';
import { Popover } from '@rozie-ui/popover-solid';
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useApp } from '../app/context';
import { formatWhen, STATUS_LABELS } from '../calendar/format';
import { toCalendarInput, toUtcDate, type CalendarInput, type DisplayEvent } from '../calendar/instances';
import { loadView, saveView } from '../calendar/prefs';

const TOOLBAR = { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' };

/** Route component for /calendar: read-only month/week/day views of every visible calendar. */
export function CalendarView() {
  const { calendar } = useApp();
  const [view, setView] = createSignal(loadView(window.innerWidth < 700));
  // The wrapper's `height` is pixels only (see docs/rozie-feedback.md), so track the host's size.
  const [height, setHeight] = createSignal(600);
  let host!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(Math.max(320, host.clientHeight)));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const events = createMemo(() =>
    calendar.state.events
      .map((e) => toCalendarInput(e, calendar.state.calendars, calendar.hidden()))
      .filter((e): e is CalendarInput => e !== null),
  );

  const [selected, setSelected] = createSignal<{ event: DisplayEvent; rect: DOMRect } | null>(null);

  return (
    <section class="calendar-view" aria-label="Calendar">
      <div class="calendar-progress" classList={{ active: calendar.state.loading }} />
      <div class="calendar-host" ref={host}>
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
          height={height()}
          defaultColor="var(--cal-default)"
          headerToolbar={TOOLBAR}
          onEventClick={(info) => {
            const { event, jsEvent } = info as { event: { id: string }; jsEvent: MouseEvent };
            const el = (jsEvent.target as Element | null)?.closest('.fc-event');
            const ev = calendar.state.events.find((e) => e.id === event.id);
            if (el && ev) setSelected({ event: ev, rect: el.getBoundingClientRect() });
          }}
          onDatesSet={(info) => {
            const { start, end } = info as { start: Date; end: Date };
            void calendar.show({ start: toUtcDate(start), end: toUtcDate(end) });
          }}
        />
      </div>
      <Show when={selected()} keyed>
        {(s) => <EventPopover event={s.event} rect={s.rect} onClose={() => setSelected(null)} />}
      </Show>
    </section>
  );
}

/**
 * Read-only event details. Popover can only anchor to an element it renders itself, so it sits
 * in a fixed-position box laid over the clicked event, and its (empty) anchor fills that box.
 * (Popover's props don't accept class/style, hence the wrapper div.)
 */
function EventPopover(props: { event: DisplayEvent; rect: DOMRect; onClose: () => void }) {
  const { calendar } = useApp();
  const calendarName = () =>
    props.event.calendarIds.map((id) => calendar.state.calendars[id]?.name).find((n) => n) ?? '';
  return (
    <div class="event-anchor" style={{ left: `${props.rect.left}px`, top: `${props.rect.top}px`, width: `${props.rect.width}px`, height: `${props.rect.height}px` }}>
      <Popover open bare onOpenChange={(open) => !open && props.onClose()} trigger="manual" placement="right-start" anchorSlot={() => <span />}>
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
    </div>
  );
}
