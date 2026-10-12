import { parseSearch, tokenize, type SearchContext } from './search';

/** One term of a simple search, as the search box shows it. */
export interface Pill {
  /** An operator name, or 'word' for a negated plain word. */
  name: string;
  value: string;
  negated: boolean;
}

/** A search whose terms are all joined by the implied AND. */
export interface SimpleQuery {
  pills: Pill[];
  /** The plain words, as typed, quotes kept. */
  words: string;
}

export const EMPTY_QUERY: SimpleQuery = { pills: [], words: '' };

// The tokenizer has no way to escape a quote, so one inside a value cannot be written.
const quoted = (v: string, always = false): string => {
  const clean = v.replace(/"/g, '');
  return always || clean === '' || /[\s(){}]/.test(clean) ? `"${clean}"` : clean;
};

/** The pill as query text: `from:bob`, `-label:"Client work"`, `-draft`. */
export function pillText(p: Pill): string {
  if (p.name !== 'word') return (p.negated ? '-' : '') + `${p.name}:${quoted(p.value)}`;
  // A word is written bare only when the tokenizer reads it back as that one plain word.
  const toks = tokenize(p.value);
  const bare = !p.value.includes('"') && toks.length === 1 && toks[0]!.t === 'word' && toks[0]!.v === p.value;
  return (p.negated ? '-' : '') + quoted(p.value, !bare);
}

/** The pills without any that says what an earlier one says. */
export function uniquePills(pills: Pill[]): Pill[] {
  const seen = new Set<string>();
  return pills.filter((p) => {
    const key = pillText(p);
    return !seen.has(key) && !!seen.add(key);
  });
}

/** The pills and words of a simple query, or null when the query uses OR or brackets. */
export function readQuery(input: string): SimpleQuery | null {
  const pills: Pill[] = [];
  const words: string[] = [];
  let negated = false;
  for (const tok of tokenize(input)) {
    if (tok.t === '-') {
      negated = !negated;
      continue;
    }
    if (tok.t === 'op') {
      // Nothing after the colon yet: text the user is still typing.
      if (tok.v) pills.push({ name: tok.name, value: tok.v, negated });
      else words.push(`${negated ? '-' : ''}${tok.name}:`);
    } else if (tok.t === 'word') {
      if (negated) pills.push({ name: 'word', value: tok.v, negated: true });
      // A word that was quoted may be an OR or an operator in disguise: it goes back quoted.
      else if (tok.v) words.push(quoted(tok.v, tok.quoted));
    } else {
      return null;
    }
    negated = false;
  }
  return { pills: uniquePills(pills), words: words.join(' ') };
}

/** The query string for these pills and words: pills first. */
export function writeQuery(q: SimpleQuery): string {
  return [...q.pills.map(pillText), q.words.trim()].filter(Boolean).join(' ');
}

/** Why the search cannot use this pill (a label that does not exist, a date it cannot read), or null. */
export function pillError(p: Pill, ctx: SearchContext): string | null {
  if (p.name === 'word') return null;
  return parseSearch(pillText({ ...p, negated: false }), ctx).errors[0] ?? null;
}

const PEOPLE = new Set(['from', 'to', 'cc', 'bcc', 'deliveredto']);
const DATES = new Set(['before', 'after', 'older', 'newer']);
const PLACES: Record<string, string> = {
  inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', draft: 'Drafts', archive: 'Archive', trash: 'Trash', bin: 'Trash', spam: 'Spam', junk: 'Spam',
  anywhere: 'All mail', all: 'All mail',
};
const UNITS: Record<string, string> = { d: 'day', m: 'month', y: 'year' };

function valueLabel(p: Pill, opts: { person?: (address: string) => string | undefined; locale?: string }): string {
  if (PEOPLE.has(p.name)) return opts.person?.(p.value) ?? p.value;
  if (p.name === 'in') return PLACES[p.value.toLowerCase()] ?? p.value;
  if (p.name === 'older_than' || p.name === 'newer_than') {
    const m = /^(\d+)([dmy])$/i.exec(p.value);
    if (!m) return p.value;
    const n = Number(m[1]);
    return `${n} ${UNITS[m[2]!.toLowerCase()]}${n === 1 ? '' : 's'}`;
  }
  if (DATES.has(p.name)) {
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(p.value);
    if (!m) return p.value;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(opts.locale, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return p.value;
}

/** The pill as the box shows it: `from: Nora Quinn`, `not: draft`, `newer than: 7 days`. */
export function pillLabel(p: Pill, opts: { person?: (address: string) => string | undefined; locale?: string } = {}): string {
  const name = p.name === 'word' ? '' : p.name.replace(/_/g, ' ');
  const lead = p.negated ? (name ? `not ${name}` : 'not') : name;
  return `${lead}: ${valueLabel(p, opts)}`;
}
