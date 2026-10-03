// Rules for identities, signatures and the vacation responder, matched to what Stalwart 0.16.23
// accepts (see "Server facts" in docs/superpowers/specs/2026-10-02-settings-design.md).
import type { Identity, VacationResponse } from '../jmap/types';
import { htmlToText } from './compose';
import { plainTextToHtml, sanitizeEmailHtml } from './sanitize';

/** Server limits, in UTF-8 bytes. */
export const LIMITS = { name: 254, signature: 2047, vacationSubject: 511, vacationBody: 2047, identities: 20 } as const;

const encoder = new TextEncoder();
export const utf8Length = (s: string): number => encoder.encode(s).length;

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** True for what an empty TipTap editor produces (`<p></p>`), or markup with no text and no image. */
export function isBlankHtml(html: string): boolean {
  return !/<img\b/i.test(html) && htmlToText(html).trim() === '';
}

export function signatureText(html: string): string {
  return htmlToText(html).trimEnd();
}

/** The signature to put in a new message: sanitized HTML, the text signature as HTML, or ''. */
export function signatureForCompose(i: Identity): string {
  if (i.htmlSignature && !isBlankHtml(i.htmlSignature)) return sanitizeEmailHtml(i.htmlSignature, { allowRemote: true }).html;
  if (i.textSignature?.trim()) return plainTextToHtml(i.textSignature.trimEnd()).replace(/\n/g, '<br>');
  return '';
}

export type IdentityField = 'name' | 'email' | 'signature';
export interface IdentityInput {
  name: string;
  email: string;
  signatureHtml: string;
}
export interface IdentityValue {
  name: string;
  email: string;
  htmlSignature: string;
  textSignature: string;
}
export type IdentityCheck = { ok: true; value: IdentityValue } | { ok: false; field: IdentityField; error: string };

export function checkIdentity(input: IdentityInput, creating: boolean): IdentityCheck {
  const name = collapse(input.name);
  if (utf8Length(name) > LIMITS.name) return { ok: false, field: 'name', error: 'The name is too long.' };
  const email = input.email.trim();
  if (creating) {
    if (!email) return { ok: false, field: 'email', error: 'Enter the address to send from.' };
    if (!EMAIL_RE.test(email)) return { ok: false, field: 'email', error: `'${email}' isn't an email address.` };
  }
  const blank = isBlankHtml(input.signatureHtml);
  const htmlSignature = blank ? '' : sanitizeEmailHtml(input.signatureHtml, { allowRemote: true }).html;
  const textSignature = blank ? '' : signatureText(htmlSignature);
  const size = Math.max(utf8Length(htmlSignature), utf8Length(textSignature));
  if (size > LIMITS.signature) {
    return { ok: false, field: 'signature', error: `The signature is too long (${size} of ${LIMITS.signature} bytes). Shorten it or remove some formatting.` };
  }
  return { ok: true, value: { name, email, htmlSignature, textSignature } };
}

// ---- Days and instants -------------------------------------------------------

export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Milliseconds `tz` is ahead of UTC at `instant`. */
function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(instant / 1000) * 1000;
}

/** The instant 00:00 on `day` (YYYY-MM-DD) begins in `tz`. */
export function startOfDay(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  // Two passes: the offset at the guess may differ from the offset at the answer (DST).
  let t = wall - offsetMs(wall, tz);
  t = wall - offsetMs(t, tz);
  return new Date(t);
}

/** The calendar day (YYYY-MM-DD) that `d` falls in, in `tz`. */
export function localDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- Vacation -----------------------------------------------------------------

export type VacationField = 'dates' | 'subject' | 'message';
export interface VacationInput {
  enabled: boolean;
  /** YYYY-MM-DD, or null for "starting now". */
  firstDay: string | null;
  /** YYYY-MM-DD, or null for "no end date". */
  lastDay: string | null;
  subject: string;
  message: string;
}
export type VacationPatch = Omit<VacationResponse, 'id'>;
export type VacationCheck = { ok: true; patch: VacationPatch } | { ok: false; field: VacationField; error: string };

export function checkVacation(input: VacationInput, tz = browserTimeZone(), now = new Date()): VacationCheck {
  const { firstDay, lastDay } = input;
  if (firstDay && lastDay && lastDay < firstDay) return { ok: false, field: 'dates', error: 'The last day is before the first day.' };
  const toDate = lastDay ? startOfDay(addDays(lastDay, 1), tz) : null;
  if (input.enabled && toDate && toDate <= now) return { ok: false, field: 'dates', error: 'The last day has already passed.' };
  const subject = input.subject.trim();
  if (utf8Length(subject) > LIMITS.vacationSubject) return { ok: false, field: 'subject', error: 'The subject is too long.' };
  const message = input.message.trimEnd();
  if (input.enabled && !message.trim()) return { ok: false, field: 'message', error: 'Write a message for the auto-reply.' };
  const size = utf8Length(message);
  if (size > LIMITS.vacationBody) return { ok: false, field: 'message', error: `The message is too long (${size} of ${LIMITS.vacationBody} bytes).` };
  return {
    ok: true,
    patch: {
      isEnabled: input.enabled,
      fromDate: firstDay ? utc(startOfDay(firstDay, tz)) : null,
      toDate: toDate ? utc(toDate) : null,
      subject: subject || null,
      textBody: message || null,
      htmlBody: null,
    },
  };
}

export function vacationInput(v: VacationResponse | null, tz = browserTimeZone()): VacationInput {
  if (!v) return { enabled: false, firstDay: null, lastDay: null, subject: '', message: '' };
  return {
    enabled: v.isEnabled,
    firstDay: v.fromDate ? localDay(new Date(v.fromDate), tz) : null,
    lastDay: v.toDate ? localDay(new Date(Date.parse(v.toDate) - 1), tz) : null,
    subject: v.subject ?? '',
    message: v.textBody ?? (v.htmlBody ? htmlToText(v.htmlBody).trimEnd() : ''),
  };
}

export type VacationStatus =
  | { kind: 'off' }
  | { kind: 'scheduled'; from: Date; until: Date | null }
  | { kind: 'on'; until: Date | null }
  | { kind: 'ended'; until: Date };

export function vacationStatus(v: VacationResponse | null, now: Date): VacationStatus {
  if (!v?.isEnabled) return { kind: 'off' };
  const from = v.fromDate ? new Date(v.fromDate) : null;
  const until = v.toDate ? new Date(v.toDate) : null;
  if (until && until <= now) return { kind: 'ended', until };
  if (from && from > now) return { kind: 'scheduled', from, until };
  return { kind: 'on', until };
}

/** "Fri 9 Oct" for the day an instant falls in (an end instant counts as the day before it). */
function day(d: Date, locale: string | undefined, tz: string, isEnd = false): string {
  const t = isEnd ? new Date(d.getTime() - 1) : d;
  return t.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).replace(',', '');
}

export function describeVacation(s: VacationStatus, locale?: string, tz = browserTimeZone()): string {
  switch (s.kind) {
    case 'off':
      return 'Off.';
    case 'on':
      return s.until ? `On. Replying until ${day(s.until, locale, tz, true)}.` : 'On. Replying until you turn it off.';
    case 'scheduled':
      return s.until ? `Scheduled from ${day(s.from, locale, tz)} to ${day(s.until, locale, tz, true)}.` : `Scheduled from ${day(s.from, locale, tz)}.`;
    case 'ended':
      return `Ended on ${day(s.until, locale, tz, true)}.`;
  }
}

/** The reminder banner's text, or null when no banner should show. */
export function bannerText(s: VacationStatus, locale?: string, tz = browserTimeZone()): string | null {
  if (s.kind !== 'on') return null;
  return s.until ? `Your vacation responder is on until ${day(s.until, locale, tz, true)}.` : 'Your vacation responder is on.';
}
