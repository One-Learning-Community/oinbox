import { describe, expect, it } from 'vitest';
import { formatWhen, STATUS_LABELS } from './format';

// ICU puts narrow/thin spaces in ranges; compare with plain spaces.
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('formatWhen', () => {
  const opts = { locale: 'en-US', timeZone: 'America/New_York' };

  it('formats a same-day timed event as one date and a time range', () => {
    expect(plain(formatWhen({ allDay: false, start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T13:30:00.000Z' }, opts))).toBe('Mon, Oct 5, 9:00 – 9:30 AM');
  });

  it('formats a timed event across days with both dates', () => {
    expect(plain(formatWhen({ allDay: false, start: '2026-10-05T13:00:00.000Z', end: '2026-10-06T15:00:00.000Z' }, opts))).toBe('Mon, Oct 5, 9:00 AM – Tue, Oct 6, 11:00 AM');
  });

  it('formats all-day events by date, treating the end as exclusive', () => {
    expect(plain(formatWhen({ allDay: true, start: '2026-10-06', end: '2026-10-07' }, opts))).toBe('Tue, Oct 6');
    expect(plain(formatWhen({ allDay: true, start: '2026-10-08', end: '2026-10-10' }, opts))).toBe('Thu, Oct 8 – Fri, Oct 9');
  });

  it('labels RSVP states', () => {
    expect(STATUS_LABELS['needs-action']).toBe('Awaiting reply');
    expect(STATUS_LABELS.accepted).toBe('Accepted');
  });
});
