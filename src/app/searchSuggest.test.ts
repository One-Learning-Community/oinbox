import { describe, expect, it } from 'vitest';
import type { Mailbox } from '../jmap/types';
import type { Recipient } from '../mail/recipients';
import { places, suggesting, suggestions, type SuggestSources } from './searchSuggest';

const mb = (id: string, name: string, role: string | null = null) => ({ id, name, role, parentId: null }) as unknown as Mailbox;
const MAILBOXES = [mb('I', 'Inbox', 'inbox'), mb('S', 'Sent', 'sent'), mb('T', 'Trash', 'trash'), mb('J', 'Junk', 'junk'), mb('F', 'Finance'), mb('C', 'Client work')];
const person = (name: string, email: string): Recipient => ({ name, email, sent: 0, received: 0, last: '' });
const src: SuggestSources = {
  people: (q) => (q.toLowerCase().startsWith('no') ? [person('Nora Quinn', 'nora@customer.test'), { ...person('Team', ''), list: { id: 'g', count: 3 } }] : []),
  mailboxes: MAILBOXES,
  path: (m) => m.name,
};
const pill = (name: string, value: string, negated = false) => ({ name, value, negated });

describe('suggesting', () => {
  it('finds the operator being typed at the end of the text', () => {
    expect(suggesting('invoice from:no')).toEqual({ before: 'invoice ', name: 'from', negated: false, partial: 'no' });
    expect(suggesting('is:')).toEqual({ before: '', name: 'is', negated: false, partial: '' });
    expect(suggesting('a -label:fin')).toEqual({ before: 'a ', name: 'label', negated: true, partial: 'fin' });
    expect(suggesting('label:"Client wo')).toEqual({ before: '', name: 'label', negated: false, partial: 'Client wo' });
    expect(suggesting('FROM:no')).toEqual({ before: '', name: 'from', negated: false, partial: 'no' });
  });
  it('is nothing for plain words, a finished value, or an operator with no list', () => {
    expect(suggesting('invoice')).toBeNull();
    expect(suggesting('from:nora ')).toBeNull();
    expect(suggesting('subject:lun')).toBeNull();
    expect(suggesting('after:2026')).toBeNull();
    expect(suggesting('xfrom:no')).toBeNull();
    expect(suggesting('label:"Client work"')).toBeNull();
  });
});

describe('suggestions', () => {
  it('offers people by address, and no groups', () => {
    expect(suggestions(suggesting('from:no')!, src)).toEqual([{ pill: pill('from', 'nora@customer.test'), label: 'Nora Quinn', detail: 'nora@customer.test' }]);
  });
  it('keeps the negation of what was typed', () => {
    expect(suggestions(suggesting('-to:no')!, src)[0]!.pill).toEqual(pill('to', 'nora@customer.test', true));
  });
  it('offers the mailboxes this account has, then All mail, then labels, for in:', () => {
    expect(suggestions(suggesting('in:')!, src).map((s) => s.label)).toEqual(['Inbox', 'Sent', 'Spam', 'Trash', 'All mail', 'Client work', 'Finance']);
  });
  it('narrows by what was typed, whatever its case', () => {
    expect(suggestions(suggesting('in:FIN')!, src).map((s) => s.pill)).toEqual([pill('label', 'Finance')]);
    expect(suggestions(suggesting('in:tr')!, src).map((s) => s.pill)).toEqual([pill('in', 'trash')]);
  });
  it('offers only labels for label:', () => {
    expect(suggestions(suggesting('label:')!, src).map((s) => s.pill)).toEqual([pill('label', 'Client work'), pill('label', 'Finance')]);
  });
  it('offers the fixed lists for has: and is:', () => {
    expect(suggestions(suggesting('has:')!, src).map((s) => s.pill.value)).toEqual(['attachment']);
    expect(suggestions(suggesting('is:un')!, src).map((s) => s.pill.value)).toEqual(['unread', 'unstarred']);
    expect(suggestions(suggesting('is:')!, src).map((s) => s.pill.value)).toEqual(['unread', 'read', 'starred', 'unstarred', 'important']);
  });
  it('stops at the limit', () => {
    expect(suggestions(suggesting('in:')!, src, 3)).toHaveLength(3);
  });
});

describe('places', () => {
  it('leaves out a system mailbox the account does not have', () => {
    expect(places([mb('I', 'Inbox', 'inbox')], (m) => m.name).map((p) => p.label)).toEqual(['Inbox', 'All mail']);
  });
});
