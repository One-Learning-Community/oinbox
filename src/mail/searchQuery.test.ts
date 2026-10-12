import { describe, expect, it } from 'vitest';
import { parseSearch, type SearchContext } from './search';
import { pillError, pillLabel, pillText, readQuery, uniquePills, writeQuery } from './searchQuery';

const ctx: SearchContext = {
  mailboxIdByRole: (role) => ({ inbox: 'I', sent: 'S', trash: 'T', junk: 'J', drafts: 'D', archive: 'A' })[role],
  mailboxIdByName: (name) => ({ work: 'W', 'client work': 'CW' })[name.toLowerCase()],
  now: new Date(2026, 8, 25, 12, 0, 0),
};
const pill = (name: string, value: string, negated = false) => ({ name, value, negated });

/** The same conditions in any order: the box puts pills before words. */
const conditions = (q: string) => {
  const f = parseSearch(q, ctx).filter;
  const list = f && 'operator' in f && f.operator === 'AND' ? f.conditions : f ? [f] : [];
  return list.map((c) => JSON.stringify(c)).sort();
};

describe('readQuery', () => {
  it('reads operators as pills and leaves plain words as words', () => {
    expect(readQuery('invoice from:bob urgent has:attachment')).toEqual({
      pills: [pill('from', 'bob'), pill('has', 'attachment')],
      words: 'invoice urgent',
    });
  });
  it('reads a negated operator and a negated word as pills', () => {
    expect(readQuery('-from:bob -draft report')).toEqual({ pills: [pill('from', 'bob', true), pill('word', 'draft', true)], words: 'report' });
  });
  it('keeps a quoted phrase quoted, and reads a quoted value without its quotes', () => {
    expect(readQuery('"quarterly report" label:"Client work"')).toEqual({ pills: [pill('label', 'Client work')], words: '"quarterly report"' });
  });
  it('leaves an operator with nothing after it in the words, to go on typing', () => {
    expect(readQuery('invoice from:')).toEqual({ pills: [], words: 'invoice from:' });
    expect(readQuery('-from:')).toEqual({ pills: [], words: '-from:' });
  });
  it('is an empty query for nothing', () => {
    expect(readQuery('   ')).toEqual({ pills: [], words: '' });
  });
  it('keeps one of two pills that say the same', () => {
    expect(readQuery('from:bob from:bob is:unread')!.pills).toEqual([pill('from', 'bob'), pill('is', 'unread')]);
  });
  it.each(['from:bob OR from:nora', 'a | b', '(a b)', '{a b}', 'a )', 'from:bob -(x)'])('says %s is not simple', (q) => {
    expect(readQuery(q)).toBeNull();
  });
  it.each(['ab"cd', 'foo"bar baz" from:bob', 'from:a"b', '-ab"cd'])('says %s is not simple: a quote inside a word cannot be written back', (q) => {
    expect(readQuery(q)).toBeNull();
  });
  it('still reads a quoted phrase and a quoted value as simple', () => {
    expect(readQuery('"quoted phrase"')).toEqual({ pills: [], words: '"quoted phrase"' });
    expect(readQuery('subject:"lunch plans"')).toEqual({ pills: [pill('subject', 'lunch plans')], words: '' });
  });
  it('makes no pill of a negation with nothing in it', () => {
    expect(readQuery('-""')).toEqual({ pills: [], words: '' });
    expect(readQuery('-"" from:bob lunch')).toEqual({ pills: [pill('from', 'bob')], words: 'lunch' });
  });
  it('keeps a negated word that only looks like syntax a negated word', () => {
    expect(readQuery('-"OR" -"from:bob"')).toEqual({ pills: [pill('word', 'OR', true), pill('word', 'from:bob', true)], words: '' });
  });
  it('keeps words that only look like syntax', () => {
    expect(readQuery('"OR" "from:bob" follow-up -')).toEqual({ pills: [], words: '"OR" "from:bob" follow-up -' });
  });
});

describe('writeQuery', () => {
  it('puts the pills first, then the words', () => {
    expect(writeQuery({ pills: [pill('from', 'bob'), pill('word', 'draft', true)], words: 'invoice urgent' })).toBe('from:bob -draft invoice urgent');
  });
  it('quotes a value with a space and drops a quote inside one', () => {
    expect(pillText(pill('label', 'Client work'))).toBe('label:"Client work"');
    expect(pillText(pill('subject', 'the "big" one'))).toBe('subject:"the big one"');
    expect(pillText(pill('word', 'two words', true))).toBe('-"two words"');
  });
  it('quotes a negated word that would otherwise read as syntax', () => {
    expect(pillText(pill('word', 'OR', true))).toBe('-"OR"');
    expect(pillText(pill('word', 'from:bob', true))).toBe('-"from:bob"');
    expect(pillText(pill('word', '-x', true))).toBe('-"-x"');
    expect(pillText(pill('word', 'draft', true))).toBe('-draft');
  });
  it('writes nothing for an empty query', () => {
    expect(writeQuery({ pills: [], words: '  ' })).toBe('');
  });
});

describe('round trip', () => {
  const SIMPLE = [
    'from:bob', 'to:nora@customer.test', 'cc:carol', 'bcc:dan', 'subject:"lunch plans"', 'has:attachment', 'is:unread', 'is:starred',
    'in:inbox', 'in:anywhere', 'label:work', 'label:"Client work"', 'before:2026/09/01', 'after:2026/08/01', 'older:2026/09/01', 'newer:2026/08/01',
    'older_than:7d', 'newer_than:1m', 'larger:5M', 'smaller:100K', 'size:1M', 'deliveredto:alice', 'list:announce', 'filename:report.pdf',
    '-from:bob', '-is:unread', '-draft', '-"OR"', '-"|"', '-"from:bob"', '-"-x"', 'invoice', '"quarterly report"',
    'invoice from:bob urgent -label:work has:attachment "exact phrase" -spam',
  ];
  it.each(SIMPLE)('reads back what it wrote: %s', (q) => {
    const read = readQuery(q)!;
    expect(readQuery(writeQuery(read))).toEqual(read);
  });
  it.each(SIMPLE)('searches for the same thing after the trip: %s', (q) => {
    expect(conditions(writeQuery(readQuery(q)!))).toEqual(conditions(q));
  });
});

describe('uniquePills', () => {
  it('drops a pill that says what an earlier one says', () => {
    expect(uniquePills([pill('is', 'unread'), pill('from', 'bob'), pill('is', 'unread')])).toEqual([pill('is', 'unread'), pill('from', 'bob')]);
  });
});

describe('pillError', () => {
  it('is what the parser says of a value it cannot use', () => {
    expect(pillError(pill('label', 'nowhere'), ctx)).toBe('No mailbox named "nowhere"');
    expect(pillError(pill('after', 'tuesday'), ctx)).toMatch(/Can't read the date/);
    expect(pillError(pill('label', 'nowhere', true), ctx)).toBe('No mailbox named "nowhere"');
  });
  it('is null for a pill the parser accepts', () => {
    expect(pillError(pill('label', 'Client work'), ctx)).toBeNull();
    expect(pillError(pill('word', 'draft', true), ctx)).toBeNull();
  });
});

describe('pillLabel', () => {
  const person = (a: string) => (a === 'nora@customer.test' ? 'Nora Quinn' : undefined);
  const say = (name: string, value: string, negated = false) => pillLabel(pill(name, value, negated), { person, locale: 'en-GB' });

  it('names a person the app knows, and shows the address of one it does not', () => {
    expect(say('from', 'nora@customer.test')).toBe('from: Nora Quinn');
    expect(say('to', 'who@elsewhere.test')).toBe('to: who@elsewhere.test');
    expect(say('cc', 'NORA@customer.test')).toBe('cc: NORA@customer.test');
  });
  it('names the system mailboxes', () => {
    expect(say('in', 'inbox')).toBe('in: Inbox');
    expect(say('in', 'bin')).toBe('in: Trash');
    expect(say('in', 'spam')).toBe('in: Spam');
    expect(say('in', 'anywhere')).toBe('in: All mail');
    expect(say('in', 'Finance/2026')).toBe('in: Finance/2026');
    expect(say('label', 'Finance/2026')).toBe('label: Finance/2026');
  });
  it('spells out an age and a date', () => {
    expect(say('newer_than', '7d')).toBe('newer than: 7 days');
    expect(say('older_than', '1m')).toBe('older than: 1 month');
    expect(say('newer_than', '2y')).toBe('newer than: 2 years');
    expect(say('after', '2026/09/01')).toBe('after: 1 Sept 2026');
    expect(say('before', '2026-9-1')).toBe('before: 1 Sept 2026');
  });
  it('shows a value it cannot read as it was typed', () => {
    expect(say('after', 'tuesday')).toBe('after: tuesday');
    expect(say('newer_than', 'soon')).toBe('newer than: soon');
  });
  it('says not for a negated pill', () => {
    expect(say('from', 'bob', true)).toBe('not from: bob');
    expect(say('word', 'draft', true)).toBe('not: draft');
  });
  it('shows other operators as they are', () => {
    expect(say('has', 'attachment')).toBe('has: attachment');
    expect(say('larger', '5M')).toBe('larger: 5M');
  });
});
