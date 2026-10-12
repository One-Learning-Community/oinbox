import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, formError, formFromQuery, isEmptyForm, queryFromForm } from './searchForm';
import { readQuery, writeQuery } from './searchQuery';

const form = (q: string) => formFromQuery(readQuery(q)!);
const back = (q: string) => writeQuery(queryFromForm(form(q)));

describe('formFromQuery', () => {
  it('fills each field from its pill', () => {
    expect(form('from:nora@customer.test to:bob subject:"lunch plans" in:inbox has:attachment is:unread is:starred invoice -draft -spam')).toEqual({
      ...EMPTY_FORM,
      from: 'nora@customer.test', to: 'bob', subject: 'lunch plans', words: 'invoice', without: 'draft spam', where: 'in:inbox',
      attachment: true, unread: true, starred: true,
    });
  });
  it('reads the presets and a custom range, whose last day is the day before before:', () => {
    expect(form('newer_than:7d').date).toBe('7d');
    expect(form('newer_than:1m').date).toBe('1m');
    expect(form('newer_than:1y').date).toBe('1y');
    expect(form('after:2026/09/01 before:2026/10/01')).toMatchObject({ date: 'custom', first: '2026-09-01', last: '2026-09-30' });
    expect(form('after:2026/09/01')).toMatchObject({ date: 'custom', first: '2026-09-01', last: '' });
  });
  it('keeps what it has no field for', () => {
    const f = form('larger:5M cc:carol -from:bob newer_than:3d from:a from:b is:read');
    expect(f.from).toBe('a');
    expect(f.rest.map((p) => `${p.negated ? '-' : ''}${p.name}:${p.value}`)).toEqual(['larger:5M', 'cc:carol', '-from:bob', 'newer_than:3d', 'from:b', 'is:read']);
  });
  it('quotes a "doesn\'t have" word that would read as something else', () => {
    expect(form('-"OR" -"from:bob" -"(a)" -"-x" -"out of office" -draft').without).toBe('"OR" "from:bob" "(a)" "-x" "out of office" draft');
  });
  it('reads a label with a space', () => {
    expect(form('label:"Client work"').where).toBe('label:"Client work"');
  });
});

describe('queryFromForm', () => {
  it.each([
    'from:nora@customer.test', 'to:bob', 'subject:"lunch plans"', 'in:inbox', 'label:"Client work"', 'in:anywhere', 'has:attachment', 'is:unread', 'is:starred',
    'newer_than:7d', 'newer_than:1m', 'newer_than:1y', 'after:2026/09/01 before:2026/10/01', 'after:2026/09/01', 'before:2026/10/01',
    '-draft -spam', 'invoice "exact phrase"',
    '-"OR" -"from:bob" lunch', '-"OR"', '-"from:bob"', '-"(a)"', '-"-x"',
    'from:a larger:5M cc:carol -from:bob invoice',
  ])('writes back what it was given: %s', (q) => {
    expect(readQuery(back(q))).toEqual(readQuery(q));
  });
  it('writes a name with a space as a quoted value', () => {
    expect(writeQuery(queryFromForm({ ...EMPTY_FORM, from: 'Nora Quinn' }))).toBe('from:"Nora Quinn"');
  });
  it('writes each word of "doesn\'t have" as its own negation, and a quoted phrase as one', () => {
    expect(writeQuery(queryFromForm({ ...EMPTY_FORM, without: 'draft "out of office"' }))).toBe('-draft -"out of office"');
  });
  it('writes nothing for dates when the range is custom but empty', () => {
    expect(writeQuery(queryFromForm({ ...EMPTY_FORM, date: 'custom' }))).toBe('');
  });
  it('includes the last day of a custom range, and reads it back as the same day', () => {
    const f = { ...EMPTY_FORM, date: 'custom' as const, first: '2026-09-01', last: '2026-09-30' };
    expect(writeQuery(queryFromForm(f))).toBe('after:2026/09/01 before:2026/10/01');
    expect(formFromQuery(readQuery(writeQuery(queryFromForm(f)))!)).toMatchObject({ first: '2026-09-01', last: '2026-09-30' });
  });
  it('writes a "doesn\'t have" word that looks like syntax so that it still reads as a simple query', () => {
    const q = readQuery(writeQuery(queryFromForm({ ...EMPTY_FORM, without: '"OR"' })));
    expect(q).toEqual({ pills: [{ name: 'word', value: 'OR', negated: true }], words: '' });
  });
  it('trims the fields', () => {
    expect(writeQuery(queryFromForm({ ...EMPTY_FORM, from: '  bob ', words: ' invoice  ' }))).toBe('from:bob invoice');
  });
});

describe('formError and isEmptyForm', () => {
  it('refuses a range that ends before it starts', () => {
    expect(formError({ ...EMPTY_FORM, date: 'custom', first: '2026-09-10', last: '2026-09-01' })).toBe('The last day is before the first.');
    expect(formError({ ...EMPTY_FORM, date: 'custom', first: '2026-09-10', last: '2026-09-10' })).toBeNull();
    expect(formError({ ...EMPTY_FORM, date: '7d', first: '2026-09-10', last: '2026-09-01' })).toBeNull();
  });
  it('knows a form with nothing to search for', () => {
    expect(isEmptyForm(EMPTY_FORM)).toBe(true);
    expect(isEmptyForm({ ...EMPTY_FORM, from: '  ' })).toBe(true);
    expect(isEmptyForm({ ...EMPTY_FORM, date: 'custom' })).toBe(true);
    expect(isEmptyForm({ ...EMPTY_FORM, unread: true })).toBe(false);
    expect(isEmptyForm(form('larger:5M'))).toBe(false);
  });
});
