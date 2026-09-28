import type { DisplayEvent } from './instances';

export const STATUS_LABELS: Record<string, string> = {
  'needs-action': 'Awaiting reply',
  accepted: 'Accepted',
  declined: 'Declined',
  tentative: 'Maybe',
  delegated: 'Delegated',
};

/** "Mon, Oct 5, 9:00 – 9:30 AM" / "Thu, Oct 8 – Fri, Oct 9" (all-day ends are exclusive). */
export function formatWhen(ev: Pick<DisplayEvent, 'start' | 'end' | 'allDay'>, opts: { locale?: string; timeZone?: string } = {}): string {
  if (ev.allDay) {
    // Dates, not instants: format in UTC so no time zone can shift the day.
    const f = new Intl.DateTimeFormat(opts.locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const first = new Date(`${ev.start}T00:00:00Z`);
    const last = new Date(`${ev.end}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    return last <= first ? f.format(first) : f.formatRange(first, last);
  }
  const f = new Intl.DateTimeFormat(opts.locale, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: opts.timeZone,
  });
  return f.formatRange(new Date(ev.start), new Date(ev.end));
}
