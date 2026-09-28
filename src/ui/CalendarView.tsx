import { FullCalendar } from '@rozie-ui/fullcalendar-solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { useApp } from '../app/context';
import { toCalendarInput, toUtcDate, type CalendarInput } from '../calendar/instances';
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
          onDatesSet={(info) => {
            const { start, end } = info as { start: Date; end: Date };
            void calendar.show({ start: toUtcDate(start), end: toUtcDate(end) });
          }}
        />
      </div>
    </section>
  );
}
