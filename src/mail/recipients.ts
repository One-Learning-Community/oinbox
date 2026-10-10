// Recipient suggestions: a per-address count of contact from mail history, and the ranking that puts
// it together with saved contacts and the organisation's directory.
// Pure: no Solid, no JMAP.
import type { SavedEntry } from '../contacts/saved';
import type { EmailAddress, Id } from '../jmap/types';
import { parseAddressList } from './compose';
import type { DirectoryEntry } from './directory';

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
  /** Set on a suggestion from the organisation's directory: whether it is a group. Never stored. */
  group?: boolean;
  /** Set on a suggestion for a saved contact. Never stored. */
  saved?: boolean;
  /** The saved contact's card. Never stored. */
  contactId?: Id;
  /** Set on a saved contact's preferred address. Never stored. */
  preferred?: boolean;
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

/** Lower case, without accents: "zoe" finds Zoë, as it does on the Contacts page. */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function tokens(r: Recipient): string[] {
  const email = r.email.toLowerCase();
  const local = mailbox(email);
  const labels = domain(email).split('.');
  return [
    ...fold(r.name).split(/[^\p{L}\p{N}]+/u),
    local,
    ...local.split(/[._+-]/),
    ...labels.map((_, i) => labels.slice(i).join('.')),
    email,
  ].filter(Boolean);
}

/** A suggestion's rank: people written to, then saved contacts, then the organisation, then everyone else. */
const sortName = (r: Recipient) => (r.name || r.email).toLowerCase();
const tier = (r: Recipient) => (r.sent > 0 ? 0 : r.saved ? 1 : r.group !== undefined ? 2 : 3);

/** As `compareRecipients`, with saved people and colleagues not yet written to ahead of strangers, by name. */
function compareSuggestions(a: Recipient, b: Recipient): number {
  const rank = tier(a) - tier(b);
  if (rank) return rank;
  if (tier(a) === 1 || tier(a) === 2) {
    const byName = sortName(a) < sortName(b) ? -1 : sortName(a) > sortName(b) ? 1 : 0;
    return byName || Number(!!b.preferred) - Number(!!a.preferred) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
  }
  return compareRecipients(a, b);
}

/**
 * People matching `query`: every query word must be a prefix of one of the person's tokens.
 * With a `directory`, the organisation's people and groups are offered too, under the names it gives them;
 * with `saved`, so are saved contacts, under the names they were saved with, whatever else knows the address.
 */
export function suggest(
  index: RecipientIndex,
  query: string,
  opts: { exclude: Set<string>; limit: number; directory?: DirectoryEntry[]; saved?: SavedEntry[] },
): Recipient[] {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: Recipient[] = [];
  const offer = (key: string, r: Recipient, more: string[] = []) => {
    if (opts.exclude.has(key)) return;
    const t = more.length ? [...tokens(r), ...more] : tokens(r);
    if (words.every((w) => t.some((x) => x.startsWith(w)))) out.push(r);
  };
  const listed = new Set<string>();
  const inDirectory = new Map((opts.directory ?? []).map((d) => [d.email.toLowerCase(), d]));
  for (const entry of opts.saved ?? []) {
    const key = entry.email.toLowerCase();
    if (listed.has(key)) continue;
    listed.add(key);
    const known = index[key];
    const colleague = inDirectory.get(key);
    offer(
      key,
      {
        ...(known ?? { sent: 0, received: 0, last: '' }),
        email: entry.email,
        name: entry.name || colleague?.name || known?.name || '',
        saved: true,
        contactId: entry.contactId,
        preferred: entry.preferred,
        ...(colleague ? { group: colleague.group } : {}),
      },
      entry.words.flatMap((w) => fold(w).split(/[^\p{L}\p{N}]+/u)).filter(Boolean),
    );
  }
  for (const entry of opts.directory ?? []) {
    const key = entry.email.toLowerCase();
    if (listed.has(key)) continue;
    listed.add(key);
    const known = index[key];
    offer(key, known ? { ...known, name: entry.name || known.name, group: entry.group } : { email: entry.email, name: entry.name, sent: 0, received: 0, last: '', group: entry.group });
  }
  for (const [key, r] of Object.entries(index)) if (!listed.has(key)) offer(key, r);
  return out.sort(compareSuggestions).slice(0, opts.limit);
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

/**
 * What a field offers for `text`: the ranked suggestions, led by the address the user has typed
 * in full. Matching is by prefix, so without this "ann@corp.co" would offer only ann@corp.com
 * and Enter would send to someone the user didn't type.
 */
export function offer(suggestions: Recipient[], text: string): Recipient[] {
  const typed = completeAddress(text);
  // A dotted domain with a top-level label: an address someone has finished typing.
  if (!typed || !/@[^@\s]+\.[^@\s.]{2,}$/.test(typed.email)) return suggestions;
  const key = typed.email.toLowerCase();
  const exact = suggestions.find((r) => r.email.toLowerCase() === key);
  const first = exact ?? { email: typed.email, name: typed.name ?? '', sent: 0, received: 0, last: '' };
  return [first, ...suggestions.filter((r) => r !== exact)];
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
