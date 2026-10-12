import type { Mailbox } from '../jmap/types';
import type { Recipient } from '../mail/recipients';
import type { Pill } from '../mail/searchQuery';
import { isLabel } from '../sync/selectors';

/** The operator being typed at the end of the search box's text. */
export interface Suggesting {
  /** The text in front of the operator, kept when a suggestion replaces the rest. */
  before: string;
  name: string;
  negated: boolean;
  partial: string;
}

export interface Suggestion {
  pill: Pill;
  label: string;
  detail?: string;
}

export interface Place {
  pill: Pill;
  label: string;
}

export interface SuggestSources {
  people: (query: string) => Recipient[];
  mailboxes: Mailbox[];
  path: (m: Mailbox) => string;
}

const PEOPLE = new Set(['from', 'to', 'cc', 'bcc']);
const FIXED: Record<string, string[]> = { has: ['attachment'], is: ['unread', 'read', 'starred', 'unstarred', 'important'] };
const LISTED = new Set([...PEOPLE, 'in', 'label', 'has', 'is']);
// An operator at the end of the text, its value not yet finished: unquoted, or inside quotes still open.
const TAIL = /(?:^|\s)(-?)([a-z_]+):(?:"([^"]*)|([^\s"(){}]*))$/i;

/** Which list the text asks for, or null when it ends in plain words or in an operator that has none. */
export function suggesting(text: string): Suggesting | null {
  const m = TAIL.exec(text);
  if (!m) return null;
  const name = m[2]!.toLowerCase();
  if (!LISTED.has(name)) return null;
  const start = m.index + (/^\s/.test(m[0]) ? 1 : 0);
  return { before: text.slice(0, start), name, negated: m[1] === '-', partial: m[3] ?? m[4] ?? '' };
}

/** In sidebar order; `in:spam` is the junk mailbox. */
const SYSTEM: [value: string, role: string, label: string][] = [
  ['inbox', 'inbox', 'Inbox'], ['sent', 'sent', 'Sent'], ['drafts', 'drafts', 'Drafts'], ['archive', 'archive', 'Archive'], ['spam', 'junk', 'Spam'], ['trash', 'trash', 'Trash'],
];

/** Where a search can look: the system mailboxes this account has, all mail, then its labels by path. */
export function places(mailboxes: Mailbox[], path: (m: Mailbox) => string): Place[] {
  const roles = new Set<string | null>(mailboxes.map((m) => m.role));
  const system = SYSTEM.filter(([, role]) => roles.has(role)).map(([value, , label]) => ({ pill: { name: 'in', value, negated: false }, label }));
  const labels = mailboxes.filter(isLabel).map((m) => path(m)).sort((a, b) => a.localeCompare(b)).map((p) => ({ pill: { name: 'label', value: p, negated: false }, label: p }));
  return [...system, { pill: { name: 'in', value: 'anywhere', negated: false }, label: 'All mail' }, ...labels];
}

/** What to offer for the operator being typed. Every pill carries the negation that was typed. */
export function suggestions(at: Suggesting, src: SuggestSources, limit = 8): Suggestion[] {
  const { name, negated } = at;
  const typed = at.partial.toLowerCase();
  let found: Suggestion[];
  if (PEOPLE.has(name)) {
    // A group is not an address a message can be from or to.
    found = src.people(at.partial).filter((r) => !r.list && r.email).map((r) => ({ pill: { name, value: r.email, negated }, label: r.name || r.email, ...(r.name ? { detail: r.email } : {}) }));
  } else if (name === 'in' || name === 'label') {
    found = places(src.mailboxes, src.path)
      .filter((p) => (name === 'in' || p.pill.name === 'label') && (p.label.toLowerCase().includes(typed) || p.pill.value.toLowerCase().includes(typed)))
      .map((p) => ({ pill: { ...p.pill, negated }, label: p.label }));
  } else {
    found = (FIXED[name] ?? []).filter((v) => v.startsWith(typed)).map((v) => ({ pill: { name, value: v, negated }, label: v }));
  }
  return found.slice(0, limit);
}
