// Recipient suggestions from mail history: a per-address contact count and its ranking.
// Pure: no Solid, no JMAP.
import type { EmailAddress } from '../jmap/types';
import { parseAddressList } from './compose';

export interface Recipient {
  /** As first seen, original case. */
  email: string;
  /** The most recent non-empty display name, else ''. */
  name: string;
  /** Messages the user sent to this address. */
  sent: number;
  /** Messages received from this address. */
  received: number;
  /** ISO time of the most recent contact in either direction. */
  last: string;
}

/** Keyed by the lower-cased address. */
export type RecipientIndex = Record<string, Recipient>;
export type ContactKind = 'sent' | 'received';

/** What is kept in IndexedDB: the index and the ids of the emails already counted into it. */
export interface RecipientCache {
  index: RecipientIndex;
  counted: string[];
}

const ROBOT = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+\-.].*)?$/i;

const mailbox = (email: string) => email.slice(0, email.lastIndexOf('@'));
const domain = (email: string) => email.slice(email.lastIndexOf('@') + 1);

export function isRobot(email: string): boolean {
  return ROBOT.test(mailbox(email));
}

/**
 * Count one contact with each address of one message. Mutates and returns `index`.
 * Robots and malformed addresses are skipped; an address listed twice counts once.
 */
export function add(index: RecipientIndex, addresses: EmailAddress[], kind: ContactKind, at: string): RecipientIndex {
  const seen = new Set<string>();
  for (const a of addresses) {
    const email = a.email.trim();
    const key = email.toLowerCase();
    if (key.lastIndexOf('@') < 1 || !domain(key) || isRobot(key) || seen.has(key)) continue;
    seen.add(key);
    const cur = (index[key] ??= { email, name: '', sent: 0, received: 0, last: '' });
    cur[kind] += 1;
    const name = a.name?.trim() ?? '';
    if (name && (at >= cur.last || !cur.name)) cur.name = name;
    if (at > cur.last) cur.last = at;
  }
  return index;
}

/** Best first: people written to, then the most recent contact, then the most frequent. */
export function compareRecipients(a: Recipient, b: Recipient): number {
  return (
    Number(b.sent > 0) - Number(a.sent > 0) ||
    (a.last === b.last ? 0 : a.last < b.last ? 1 : -1) ||
    b.sent + b.received - (a.sent + a.received) ||
    (a.email === b.email ? 0 : a.email < b.email ? -1 : 1)
  );
}

function tokens(r: Recipient): string[] {
  const email = r.email.toLowerCase();
  const local = mailbox(email);
  const labels = domain(email).split('.');
  return [
    ...r.name.toLowerCase().split(/[^\p{L}\p{N}]+/u),
    local,
    ...local.split(/[._+-]/),
    ...labels.map((_, i) => labels.slice(i).join('.')),
    email,
  ].filter(Boolean);
}

/** People matching `query`: every query word must be a prefix of one of the person's tokens. */
export function suggest(index: RecipientIndex, query: string, opts: { exclude: Set<string>; limit: number }): Recipient[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: Recipient[] = [];
  for (const [key, r] of Object.entries(index)) {
    if (opts.exclude.has(key)) continue;
    const t = tokens(r);
    if (words.every((w) => t.some((x) => x.startsWith(w)))) out.push(r);
  }
  return out.sort(compareRecipients).slice(0, opts.limit);
}

/** A stored cache, if it has the shape this version writes; anything else is ignored. */
export function parseRecipientCache(value: unknown): RecipientCache | undefined {
  const c = value as Partial<RecipientCache> | null | undefined;
  if (!c || typeof c !== 'object' || !c.index || typeof c.index !== 'object' || Array.isArray(c.index)) return undefined;
  if (!Array.isArray(c.counted) || !c.counted.every((id) => typeof id === 'string')) return undefined;
  const ok = Object.values(c.index).every(
    (r) => r && typeof r.email === 'string' && typeof r.name === 'string' && typeof r.sent === 'number' && typeof r.received === 'number' && typeof r.last === 'string',
  );
  return ok ? { index: c.index, counted: c.counted } : undefined;
}

export function toAddress(r: Recipient): EmailAddress {
  return { name: r.name || null, email: r.email };
}

/** The address `text` spells out, if it is exactly one. */
export function completeAddress(text: string): EmailAddress | null {
  const parsed = parseAddressList(text);
  return parsed.length === 1 ? parsed[0]! : null;
}

/** `list` followed by the people in `more` it doesn't hold yet (addresses compared without case). */
export function addUnique(list: EmailAddress[], more: EmailAddress[]): EmailAddress[] {
  const seen = new Set(list.map((a) => a.email.toLowerCase()));
  const out = [...list];
  for (const a of more) {
    const key = a.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
