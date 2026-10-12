import { tokenize } from './search';
import { pillText, uniquePills, type Pill, type SimpleQuery } from './searchQuery';
import { addDays } from './settings';

/** The search panel's form. */
export interface SearchForm {
  from: string;
  to: string;
  subject: string;
  words: string;
  without: string;
  /** '' for everywhere but Spam and Trash, or a pill's text: 'in:inbox', 'label:"Client work"'. */
  where: string;
  date: 'any' | '7d' | '1m' | '1y' | 'custom';
  /** First and last day of a custom range, YYYY-MM-DD, or '' for open. Both are included. */
  first: string;
  last: string;
  attachment: boolean;
  unread: boolean;
  starred: boolean;
  /** Pills the form has no field for; written back as they are. */
  rest: Pill[];
}

export const EMPTY_FORM: SearchForm = {
  from: '', to: '', subject: '', words: '', without: '', where: '', date: 'any', first: '', last: '', attachment: false, unread: false, starred: false, rest: [],
};

const PRESETS = new Set(['7d', '1m', '1y']);
/** `2026/9/1` or `2026-09-01` as `2026-09-01`, or null. */
const day = (v: string): string | null => {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : null;
};
const slashed = (d: string) => d.replace(/-/g, '/');
const phrase = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

/** The form for a simple query. The first pill of a kind fills its field; the rest are kept aside. */
export function formFromQuery(q: SimpleQuery): SearchForm {
  const f: SearchForm = { ...EMPTY_FORM, words: q.words, rest: [] };
  const without: string[] = [];
  for (const p of q.pills) {
    const d = day(p.value);
    if (p.negated) {
      if (p.name === 'word') without.push(phrase(p.value));
      else f.rest.push(p);
    } else if ((p.name === 'from' || p.name === 'to' || p.name === 'subject') && !f[p.name]) f[p.name] = p.value;
    else if ((p.name === 'in' || p.name === 'label') && !f.where) f.where = pillText(p);
    else if (p.name === 'newer_than' && PRESETS.has(p.value) && f.date === 'any') f.date = p.value as SearchForm['date'];
    else if (p.name === 'after' && d && !f.first && (f.date === 'any' || f.date === 'custom')) (f.date = 'custom'), (f.first = d);
    // before: leaves its own day out, so the last day shown is the one before it.
    else if (p.name === 'before' && d && !f.last && (f.date === 'any' || f.date === 'custom')) (f.date = 'custom'), (f.last = addDays(d, -1));
    else if (p.name === 'has' && p.value === 'attachment' && !f.attachment) f.attachment = true;
    else if (p.name === 'is' && p.value === 'unread' && !f.unread) f.unread = true;
    else if (p.name === 'is' && p.value === 'starred' && !f.starred) f.starred = true;
    else f.rest.push(p);
  }
  f.without = without.join(' ');
  return f;
}

/** The query the form asks for. */
export function queryFromForm(f: SearchForm): SimpleQuery {
  const pills: Pill[] = [];
  const add = (name: string, value: string) => value.trim() && pills.push({ name, value: value.trim(), negated: false });
  add('from', f.from);
  add('to', f.to);
  add('subject', f.subject);
  if (f.where) {
    const m = /^(in|label):"?([^"]*)"?$/.exec(f.where);
    if (m) add(m[1]!, m[2]!);
  }
  if (PRESETS.has(f.date)) add('newer_than', f.date);
  if (f.date === 'custom') {
    if (f.first) add('after', slashed(f.first));
    if (f.last) add('before', slashed(addDays(f.last, 1)));
  }
  if (f.attachment) add('has', 'attachment');
  if (f.unread) add('is', 'unread');
  if (f.starred) add('is', 'starred');
  // A minus typed in "doesn't have" changes nothing: the field already negates. OR and brackets there are dropped.
  for (const tok of tokenize(f.without)) {
    if (tok.t === 'word' && tok.v) pills.push({ name: 'word', value: tok.v, negated: true });
    else if (tok.t === 'op' && tok.v) pills.push({ name: tok.name, value: tok.v, negated: true });
  }
  return { pills: uniquePills([...pills, ...f.rest]), words: f.words.trim().replace(/\s+/g, ' ') };
}

/** What is wrong with the form, or null. */
export function formError(f: SearchForm): string | null {
  return f.date === 'custom' && f.first && f.last && f.last < f.first ? 'The last day is before the first.' : null;
}

/** Whether the form asks for nothing. */
export function isEmptyForm(f: SearchForm): boolean {
  const q = queryFromForm(f);
  return !q.pills.length && !q.words;
}
