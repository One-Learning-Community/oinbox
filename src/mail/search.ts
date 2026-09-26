import type { EmailFilter, EmailFilterCondition, Id } from '../jmap/types';

// Gmail-style search operators → JMAP Email FilterCondition (RFC 8621 §4.4.1).

export interface SearchContext {
  mailboxIdByRole: (role: string) => Id | undefined;
  mailboxIdByName: (name: string) => Id | undefined;
  now: Date;
}

export interface ParsedSearch {
  filter: EmailFilter | null;
  errors: string[];
  /** Positive free-text terms, for highlighting. */
  textTerms: string[];
}

type Token =
  | { t: 'word'; v: string; quoted: boolean }
  | { t: 'op'; name: string; v: string }
  | { t: '(' | ')' | '{' | '}' | '-' | 'OR' };

const OPERATORS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'has', 'is', 'in', 'label', 'before', 'after', 'older', 'newer',
  'older_than', 'newer_than', 'larger', 'smaller', 'size', 'deliveredto', 'list', 'filename',
]);

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const readValue = (): string => {
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      const v = input.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? input.length : end + 1;
      return v;
    }
    const m = /^[^\s(){}]*/.exec(input.slice(i))![0];
    i += m.length;
    return m;
  };
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if ('(){}'.includes(c)) {
      out.push({ t: c as '(' | ')' | '{' | '}' });
      i++;
    } else if (c === '-' && i + 1 < input.length && !/\s/.test(input[i + 1]!)) {
      out.push({ t: '-' });
      i++;
    } else if (c === '"') {
      out.push({ t: 'word', v: readValue(), quoted: true });
    } else {
      const m = /^([a-z_]+):/i.exec(input.slice(i));
      if (m && OPERATORS.has(m[1]!.toLowerCase())) {
        i += m[0].length;
        out.push({ t: 'op', name: m[1]!.toLowerCase(), v: readValue() });
      } else {
        const v = readValue();
        if (v === 'OR' || v === '|') out.push({ t: 'OR' });
        else if (v) out.push({ t: 'word', v, quoted: false });
      }
    }
  }
  return out;
}

const SIZE_RE = /^(\d+(?:\.\d+)?)([kmg]b?|b)?$/i;

function parseSize(v: string): number | null {
  const m = SIZE_RE.exec(v);
  if (!m) return null;
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]?.[0]?.toLowerCase() ?? ''] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

function parseDate(v: string): string | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString();
}

function parseAge(v: string, now: Date): string | null {
  const m = /^(\d+)([dmy])$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const d = new Date(now);
  const unit = m[2]!.toLowerCase();
  if (unit === 'd') d.setDate(d.getDate() - n);
  else if (unit === 'm') d.setMonth(d.getMonth() - n);
  else d.setFullYear(d.getFullYear() - n);
  return d.toISOString();
}

const IN_ROLES: Record<string, string> = {
  inbox: 'inbox', sent: 'sent', trash: 'trash', bin: 'trash', spam: 'junk', junk: 'junk', drafts: 'drafts', draft: 'drafts', archive: 'archive',
};

export function parseSearch(input: string, ctx: SearchContext): ParsedSearch {
  const tokens = tokenize(input);
  const errors: string[] = [];
  const textTerms: string[] = [];
  let mailboxScoped = false;
  let pos = 0;

  const condition = (tok: Token & { t: 'op' }): EmailFilter | null => {
    const v = tok.v;
    switch (tok.name) {
      case 'from':
      case 'to':
      case 'cc':
      case 'bcc':
      case 'subject':
        return v ? { [tok.name]: v } : null;
      case 'deliveredto':
        return v ? { to: v } : null;
      case 'list':
        return v ? { header: ['List-Id', v] } : null;
      case 'filename':
        return v ? { text: v } : null;
      case 'has':
        if (v === 'attachment') return { hasAttachment: true };
        if (v === 'userlabels' || v === 'nouserlabels') return null;
        return { text: `has:${v}` };
      case 'is':
        if (v === 'unread') return { notKeyword: '$seen' };
        if (v === 'read') return { hasKeyword: '$seen' };
        if (v === 'starred') return { hasKeyword: '$flagged' };
        if (v === 'unstarred') return { notKeyword: '$flagged' };
        if (v === 'draft') return { hasKeyword: '$draft' };
        if (v === 'important') return { hasKeyword: '$important' };
        return { text: `is:${v}` };
      case 'in':
      case 'label': {
        mailboxScoped = true;
        const lower = v.toLowerCase();
        if (lower === 'anywhere' || lower === 'all') return null;
        const role = tok.name === 'in' ? IN_ROLES[lower] : undefined;
        const id = (role && ctx.mailboxIdByRole(role)) || ctx.mailboxIdByName(v);
        if (!id) {
          errors.push(`No mailbox named "${v}"`);
          return null;
        }
        return { inMailbox: id };
      }
      case 'before':
      case 'older':
      case 'after':
      case 'newer': {
        const d = parseDate(v);
        if (!d) {
          errors.push(`Can't read the date "${v}" (use YYYY/MM/DD)`);
          return null;
        }
        return tok.name === 'before' || tok.name === 'older' ? { before: d } : { after: d };
      }
      case 'older_than':
      case 'newer_than': {
        const d = parseAge(v, ctx.now);
        if (!d) {
          errors.push(`Can't read the age "${v}" (use e.g. 7d, 2m, 1y)`);
          return null;
        }
        return tok.name === 'older_than' ? { before: d } : { after: d };
      }
      case 'larger':
      case 'size':
      case 'smaller': {
        const n = parseSize(v);
        if (n === null) {
          errors.push(`Can't read the size "${v}" (use e.g. 5M, 100K)`);
          return null;
        }
        return tok.name === 'smaller' ? { maxSize: n } : { minSize: n };
      }
    }
    return null;
  };

  const and = (conds: EmailFilter[]): EmailFilter | null =>
    conds.length === 0 ? null : conds.length === 1 ? conds[0]! : { operator: 'AND', conditions: conds };
  const or = (conds: EmailFilter[]): EmailFilter | null =>
    conds.length === 0 ? null : conds.length === 1 ? conds[0]! : { operator: 'OR', conditions: conds };

  // Gmail precedence: OR binds tighter than the implied AND.
  // andExpr := orExpr+
  // orExpr  := unary ('OR' unary)*
  // unary   := '-' unary | '(' andExpr ')' | '{' unary* '}' | term
  const parseAnd = (negated: boolean, closer?: ')' | '}'): EmailFilter | null => {
    const conds: EmailFilter[] = [];
    while (pos < tokens.length) {
      const tok = tokens[pos]!;
      if (closer && tok.t === closer) break;
      if (tok.t === ')' || tok.t === '}' || tok.t === 'OR') {
        pos++; // stray closer or dangling OR
        continue;
      }
      const alts: EmailFilter[] = [];
      const first = parseUnary(negated);
      if (first) alts.push(first);
      while (tokens[pos]?.t === 'OR') {
        pos++;
        if (pos >= tokens.length || (closer && tokens[pos]!.t === closer)) break;
        const next = parseUnary(negated);
        if (next) alts.push(next);
      }
      const o = or(alts);
      if (o) conds.push(o);
    }
    return and(conds);
  };

  const parseUnary = (negated: boolean): EmailFilter | null => {
    const tok = tokens[pos++]!;
    switch (tok.t) {
      case '-': {
        if (pos >= tokens.length) return null;
        const inner = parseUnary(!negated);
        return inner ? { operator: 'NOT', conditions: [inner] } : null;
      }
      case '(': {
        const inner = parseAnd(negated, ')');
        if (tokens[pos]?.t === ')') pos++;
        return inner;
      }
      case '{': {
        const alts: EmailFilter[] = [];
        while (pos < tokens.length && tokens[pos]!.t !== '}') {
          if (tokens[pos]!.t === 'OR') {
            pos++;
            continue;
          }
          const u = parseUnary(negated);
          if (u) alts.push(u);
        }
        if (tokens[pos]?.t === '}') pos++;
        return or(alts);
      }
      case 'op':
        return condition(tok);
      case 'word':
        if (!negated) textTerms.push(tok.v);
        return tok.v ? { text: tok.v } : null;
      default:
        return null;
    }
  };

  const parsed = pos < tokens.length ? parseAnd(false) : null;
  const conds: EmailFilter[] = [];
  if (parsed) {
    if ('operator' in parsed && parsed.operator === 'AND') conds.push(...parsed.conditions);
    else conds.push(parsed);
  }
  if (!parsed && !mailboxScoped) return { filter: null, errors, textTerms };

  // Gmail leaves Trash and Spam out of searches unless the query names a mailbox.
  if (!mailboxScoped) {
    const hidden = ['trash', 'junk'].map((r) => ctx.mailboxIdByRole(r)).filter((x): x is Id => !!x);
    if (hidden.length) conds.push({ inMailboxOtherThan: hidden } satisfies EmailFilterCondition);
  }
  return { filter: and(conds), errors, textTerms };
}
