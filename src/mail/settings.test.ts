import { describe, expect, it } from 'vitest';
import type { Identity, VacationResponse } from '../jmap/types';
import {
  addDays, bannerText, checkIdentity, checkVacation, describeVacation, localDay, signatureForCompose,
  signatureText, startOfDay, utf8Length, vacationInput, vacationStatus,
} from './settings';

const identity = (over: Partial<Identity> = {}): Identity => ({
  id: 'i1', name: 'Alice', email: 'alice@example.test', replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: true, ...over,
});
const vacation = (over: Partial<VacationResponse> = {}): VacationResponse => ({
  id: 'singleton', isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null, ...over,
});

describe('utf8Length', () => {
  it('counts bytes, not characters', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('😀')).toBe(4);
  });
});

describe('checkIdentity', () => {
  const input = { name: '  Alice   Example ', email: ' alice@example.test ', signatureHtml: '<p><b>Alice</b></p>' };

  it('normalizes the name and address and derives the text signature', () => {
    const r = checkIdentity(input, true);
    expect(r).toEqual({ ok: true, value: { name: 'Alice Example', email: 'alice@example.test', htmlSignature: '<p><b>Alice</b></p>', textSignature: 'Alice' } });
  });

  it('treats an empty editor as no signature', () => {
    for (const signatureHtml of ['', '<p></p>', '<p> </p><p></p>']) {
      const r = checkIdentity({ ...input, signatureHtml }, false);
      expect(r.ok && r.value.htmlSignature).toBe('');
      expect(r.ok && r.value.textSignature).toBe('');
    }
  });

  it('allows an empty name', () => {
    expect(checkIdentity({ ...input, name: '' }, false).ok).toBe(true);
  });

  it('refuses a name over 254 bytes', () => {
    expect(checkIdentity({ ...input, name: 'é'.repeat(128) }, false)).toEqual({ ok: false, field: 'name', error: 'The name is too long.' });
    expect(checkIdentity({ ...input, name: 'x'.repeat(254) }, false).ok).toBe(true);
  });

  it('checks the address only when creating', () => {
    expect(checkIdentity({ ...input, email: ' ' }, true)).toEqual({ ok: false, field: 'email', error: 'Enter the address to send from.' });
    expect(checkIdentity({ ...input, email: 'not an address' }, true)).toEqual({ ok: false, field: 'email', error: "'not an address' isn't an email address." });
    expect(checkIdentity({ ...input, email: 'whatever' }, false).ok).toBe(true);
  });

  it('refuses a signature over 2047 bytes, naming the size', () => {
    const r = checkIdentity({ ...input, signatureHtml: `<p>${'x'.repeat(2050)}</p>` }, false);
    expect(r).toEqual({ ok: false, field: 'signature', error: 'The signature is too long (2057 of 2047 bytes). Shorten it or remove some formatting.' });
  });

  it('strips active content from the signature', () => {
    const r = checkIdentity({ ...input, signatureHtml: '<p>Hi</p><script>alert(1)</script><img src=x onerror="alert(1)">' }, false);
    expect(r.ok && r.value.htmlSignature).not.toMatch(/script|onerror/);
  });
});

describe('signatureText', () => {
  it('keeps line breaks and trims the end', () => {
    expect(signatureText('<p>Alice</p><p>OLC</p>')).toBe('Alice\nOLC');
  });
});

describe('signatureForCompose', () => {
  it('prefers the HTML signature, sanitized', () => {
    expect(signatureForCompose(identity({ htmlSignature: '<b>A</b><script>x()</script>', textSignature: 'A' }))).toBe('<b>A</b>');
  });
  it('falls back to the text signature as HTML', () => {
    expect(signatureForCompose(identity({ textSignature: 'Alice & co' }))).toBe('Alice &amp; co');
  });
  it('is empty without either', () => {
    expect(signatureForCompose(identity())).toBe('');
  });
});

describe('days and instants', () => {
  it('finds local midnight in a zone west and east of UTC', () => {
    expect(startOfDay('2026-10-05', 'Europe/London').toISOString()).toBe('2026-10-04T23:00:00.000Z');
    expect(startOfDay('2026-10-05', 'Asia/Tokyo').toISOString()).toBe('2026-10-04T15:00:00.000Z');
    expect(startOfDay('2026-10-05', 'America/New_York').toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });
  it('handles the day the clocks go back', () => {
    // Europe/London leaves BST at 01:00 UTC on 2026-10-25.
    expect(startOfDay('2026-10-25', 'Europe/London').toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(startOfDay('2026-10-26', 'Europe/London').toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
  it('reads the local day of an instant', () => {
    expect(localDay(new Date('2026-10-04T23:30:00Z'), 'Europe/London')).toBe('2026-10-05');
    expect(localDay(new Date('2026-10-04T23:30:00Z'), 'America/New_York')).toBe('2026-10-04');
  });
  it('adds days across month ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('checkVacation', () => {
  const tz = 'Europe/London';
  const now = new Date('2026-10-02T12:00:00Z');
  const base = { enabled: true, firstDay: '2026-10-05', lastDay: '2026-10-09', subject: ' Away ', message: 'Back on Monday.\n\n' };

  it('turns days into local midnights, the end exclusive', () => {
    expect(checkVacation(base, tz, now)).toEqual({
      ok: true,
      patch: { isEnabled: true, fromDate: '2026-10-04T23:00:00Z', toDate: '2026-10-09T23:00:00Z', subject: 'Away', textBody: 'Back on Monday.', htmlBody: null },
    });
  });

  it('leaves open ends null and an empty subject null', () => {
    const r = checkVacation({ ...base, firstDay: null, lastDay: null, subject: '  ' }, tz, now);
    expect(r.ok && r.patch).toMatchObject({ fromDate: null, toDate: null, subject: null });
  });

  it('refuses a last day before the first', () => {
    expect(checkVacation({ ...base, lastDay: '2026-10-04' }, tz, now)).toEqual({ ok: false, field: 'dates', error: 'The last day is before the first day.' });
  });

  it('refuses turning it on with a last day already past, but not saving it off', () => {
    const past = { ...base, firstDay: null, lastDay: '2026-10-01' };
    expect(checkVacation(past, tz, now)).toEqual({ ok: false, field: 'dates', error: 'The last day has already passed.' });
    expect(checkVacation({ ...past, enabled: false }, tz, now).ok).toBe(true);
  });

  it('accepts today as the last day', () => {
    expect(checkVacation({ ...base, firstDay: null, lastDay: '2026-10-02' }, tz, now).ok).toBe(true);
  });

  it('refuses a long subject', () => {
    expect(checkVacation({ ...base, subject: 'x'.repeat(512) }, tz, now)).toEqual({ ok: false, field: 'subject', error: 'The subject is too long.' });
  });

  it('needs a message when on, and keeps it under 2047 bytes', () => {
    expect(checkVacation({ ...base, message: ' \n' }, tz, now)).toEqual({ ok: false, field: 'message', error: 'Write a message for the auto-reply.' });
    expect(checkVacation({ ...base, enabled: false, message: '' }, tz, now).ok).toBe(true);
    expect(checkVacation({ ...base, message: 'é'.repeat(1024) }, tz, now)).toEqual({ ok: false, field: 'message', error: 'The message is too long (2048 of 2047 bytes).' });
  });
});

describe('vacationInput', () => {
  it('turns instants back into days', () => {
    const v = vacation({ isEnabled: true, fromDate: '2026-10-04T23:00:00Z', toDate: '2026-10-09T23:00:00Z', subject: 'Away', textBody: 'Back soon' });
    expect(vacationInput(v, 'Europe/London')).toEqual({ enabled: true, firstDay: '2026-10-05', lastDay: '2026-10-09', subject: 'Away', message: 'Back soon' });
  });
  it('shows an end that is not midnight as the day it falls in', () => {
    expect(vacationInput(vacation({ toDate: '2026-10-09T15:00:00Z' }), 'Europe/London').lastDay).toBe('2026-10-09');
  });
  it('fills a blank form from an empty response, and reads an HTML-only message as text', () => {
    expect(vacationInput(vacation(), 'UTC')).toEqual({ enabled: false, firstDay: null, lastDay: null, subject: '', message: '' });
    expect(vacationInput(vacation({ htmlBody: '<p>Away</p>' }), 'UTC').message).toBe('Away');
  });
});

describe('vacationStatus and its wording', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const opts = ['en-GB', 'Europe/London'] as const;
  it('is off when disabled or unknown', () => {
    expect(vacationStatus(null, now)).toEqual({ kind: 'off' });
    expect(vacationStatus(vacation({ fromDate: '2026-10-04T23:00:00Z' }), now)).toEqual({ kind: 'off' });
    expect(describeVacation({ kind: 'off' }, ...opts)).toBe('Off.');
  });
  it('is on inside the window, with or without an end', () => {
    const s = vacationStatus(vacation({ isEnabled: true, toDate: '2026-10-09T23:00:00Z' }), now);
    expect(s.kind).toBe('on');
    expect(describeVacation(s, ...opts)).toBe('On. Replying until Fri 9 Oct.');
    expect(bannerText(s, ...opts)).toBe('Your vacation responder is on until Fri 9 Oct.');
    const open = vacationStatus(vacation({ isEnabled: true }), now);
    expect(describeVacation(open, ...opts)).toBe('On. Replying until you turn it off.');
    expect(bannerText(open, ...opts)).toBe('Your vacation responder is on.');
  });
  it('is scheduled before the start and ended after the end', () => {
    const later = vacationStatus(vacation({ isEnabled: true, fromDate: '2026-10-11T23:00:00Z', toDate: '2026-10-16T23:00:00Z' }), now);
    expect(describeVacation(later, ...opts)).toBe('Scheduled from Mon 12 Oct to Fri 16 Oct.');
    expect(bannerText(later, ...opts)).toBeNull();
    const ended = vacationStatus(vacation({ isEnabled: true, toDate: '2026-10-02T23:00:00Z' }), now);
    expect(describeVacation(ended, ...opts)).toBe('Ended on Fri 2 Oct.');
    expect(bannerText(ended, ...opts)).toBeNull();
  });
});
