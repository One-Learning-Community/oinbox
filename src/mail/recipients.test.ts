import { describe, expect, it } from 'vitest';
import {
  add,
  addUnique,
  completeAddress,
  isRobot,
  parseRecipientCache,
  suggest,
  toAddress,
  type Recipient,
  type RecipientIndex,
} from './recipients';

const bob = { name: 'Bob Example', email: 'bob@example.test' };
const none = { exclude: new Set<string>(), limit: 6 };
const emails = (list: Recipient[]) => list.map((r) => r.email);

function indexOf(...entries: Recipient[]): RecipientIndex {
  return Object.fromEntries(entries.map((r) => [r.email.toLowerCase(), r]));
}
const person = (email: string, name: string, sent: number, received: number, last: string): Recipient => ({ email, name, sent, received, last });

describe('add', () => {
  it('counts one contact per address and keeps the newest name and time', () => {
    const index: RecipientIndex = {};
    add(index, [{ name: 'Bob', email: 'bob@example.test' }], 'received', '2026-09-01T00:00:00Z');
    add(index, [bob], 'sent', '2026-09-03T00:00:00Z');
    add(index, [{ name: 'Old Name', email: 'bob@example.test' }], 'sent', '2026-09-02T00:00:00Z');
    expect(index).toEqual({ 'bob@example.test': { email: 'bob@example.test', name: 'Bob Example', sent: 2, received: 1, last: '2026-09-03T00:00:00Z' } });
  });

  it('keeps a name when a newer contact has none', () => {
    const index: RecipientIndex = {};
    add(index, [bob], 'sent', '2026-09-01T00:00:00Z');
    add(index, [{ name: null, email: 'bob@example.test' }], 'sent', '2026-09-02T00:00:00Z');
    expect(index['bob@example.test']!.name).toBe('Bob Example');
  });

  it('treats letter case as the same address and keeps the first spelling', () => {
    const index: RecipientIndex = {};
    add(index, [{ name: null, email: 'Bob@Example.test' }], 'sent', '2026-09-01T00:00:00Z');
    add(index, [{ name: null, email: 'bob@example.test' }], 'sent', '2026-09-02T00:00:00Z');
    expect(Object.keys(index)).toEqual(['bob@example.test']);
    expect(index['bob@example.test']).toMatchObject({ email: 'Bob@Example.test', sent: 2 });
  });

  it('counts a person once per message, even when listed twice', () => {
    const index: RecipientIndex = {};
    add(index, [bob, { name: null, email: 'BOB@example.test' }], 'sent', '2026-09-01T00:00:00Z');
    expect(index['bob@example.test']!.sent).toBe(1);
  });

  it('never indexes robots or malformed addresses', () => {
    const index: RecipientIndex = {};
    const robots = ['no-reply@x.test', 'noreply@x.test', 'NoReply+abc@x.test', 'do-not-reply@x.test', 'donotreply@x.test', 'mailer-daemon@x.test', 'postmaster@x.test', 'bounce@x.test', 'bounces-123@x.test'];
    add(index, [...robots, 'not-an-address', '@x.test'].map((email) => ({ name: null, email })), 'received', '2026-09-01T00:00:00Z');
    expect(index).toEqual({});
    expect(isRobot('norman@x.test')).toBe(false);
    expect(isRobot('bouncer@x.test')).toBe(false);
  });
});

describe('suggest', () => {
  const index = indexOf(
    person('bob@example.test', 'Bob Example', 2, 2, '2026-09-10T00:00:00Z'),
    person('carol.nguyen@mail.partner.test', 'Carol Nguyen', 1, 5, '2026-09-12T00:00:00Z'),
    person('ci@builds.test', 'CI Bot', 0, 4, '2026-09-20T00:00:00Z'),
    person('zed@nowhere.test', '', 0, 1, '2026-09-01T00:00:00Z'),
  );

  it('returns nothing for an empty query', () => {
    expect(suggest(index, '', none)).toEqual([]);
    expect(suggest(index, '   ', none)).toEqual([]);
  });

  it('matches a prefix of a name word, in any letter case', () => {
    expect(emails(suggest(index, 'EXA', none))).toEqual(['bob@example.test']);
    expect(emails(suggest(index, 'ngu', none))).toEqual(['carol.nguyen@mail.partner.test']);
  });

  it('matches the mailbox part, whole and by its tokens', () => {
    expect(emails(suggest(index, 'carol.n', none))).toEqual(['carol.nguyen@mail.partner.test']);
    expect(emails(suggest(index, 'nguyen', none))).toEqual(['carol.nguyen@mail.partner.test']);
    expect(emails(suggest(index, 'zed', none))).toEqual(['zed@nowhere.test']);
  });

  it('matches the domain, whole and from each label', () => {
    expect(emails(suggest(index, 'mail.partner', none))).toEqual(['carol.nguyen@mail.partner.test']);
    expect(emails(suggest(index, 'partner', none))).toEqual(['carol.nguyen@mail.partner.test']);
  });

  it('matches the whole address as typed', () => {
    expect(emails(suggest(index, 'bob@ex', none))).toEqual(['bob@example.test']);
  });

  it('requires every query word to match', () => {
    expect(emails(suggest(index, 'bob exam', none))).toEqual(['bob@example.test']);
    expect(suggest(index, 'bob nguyen', none)).toEqual([]);
  });

  it('does not match in the middle of a token', () => {
    expect(suggest(index, 'xample', none)).toEqual([]);
  });

  it('ranks people written to first, then newest, then most frequent, then by address', () => {
    const ranked = indexOf(
      person('a@t.test', '', 0, 9, '2026-09-30T00:00:00Z'), // never written to: last tier
      person('b@t.test', '', 1, 0, '2026-09-01T00:00:00Z'), // written to, oldest
      person('c@t.test', '', 1, 0, '2026-09-05T00:00:00Z'), // written to, newest, fewer contacts
      person('d@t.test', '', 3, 0, '2026-09-05T00:00:00Z'), // written to, newest, more contacts
      person('e@t.test', '', 3, 0, '2026-09-05T00:00:00Z'), // tie with d: address order
    );
    expect(emails(suggest(ranked, 't.test', none))).toEqual(['d@t.test', 'e@t.test', 'c@t.test', 'b@t.test', 'a@t.test']);
  });

  it('leaves out excluded addresses and respects the limit', () => {
    expect(emails(suggest(index, 'b', { exclude: new Set(['bob@example.test']), limit: 6 }))).toEqual(['ci@builds.test']);
    expect(suggest(index, 'test', { exclude: new Set(), limit: 2 })).toHaveLength(2);
  });
});

describe('parseRecipientCache', () => {
  it('accepts a well-formed cache', () => {
    const cache = { index: indexOf(person('bob@example.test', 'Bob', 1, 0, '2026-09-01T00:00:00Z')), counted: ['e1'] };
    expect(parseRecipientCache(cache)).toEqual(cache);
  });

  it('rejects anything else', () => {
    for (const bad of [undefined, null, 'x', 42, [], {}, { index: {} }, { index: [], counted: [] }, { index: {}, counted: 'e1' }, { index: { a: { email: 'a@b.test' } }, counted: [] }, { index: {}, counted: [1] }]) {
      expect(parseRecipientCache(bad)).toBeUndefined();
    }
  });
});

describe('field helpers', () => {
  it('toAddress turns an empty name into null', () => {
    expect(toAddress(person('zed@nowhere.test', '', 0, 1, ''))).toEqual({ name: null, email: 'zed@nowhere.test' });
    expect(toAddress(person('bob@example.test', 'Bob Example', 1, 0, ''))).toEqual(bob);
  });

  it('completeAddress accepts exactly one address', () => {
    expect(completeAddress('bob@example.test')).toEqual({ name: null, email: 'bob@example.test' });
    expect(completeAddress('Bob Example <bob@example.test>')).toEqual(bob);
    expect(completeAddress('bo')).toBeNull();
    expect(completeAddress('')).toBeNull();
    expect(completeAddress('a@x.test, b@y.test')).toBeNull();
  });

  it('addUnique appends new people, compares addresses without case, and never re-parses names', () => {
    const sam = { name: 'Roe, Sam', email: 'sam@nowhere.test' };
    const list = addUnique([bob], [{ name: null, email: 'BOB@example.test' }, sam, sam]);
    expect(list).toEqual([bob, sam]);
  });

  it('addUnique returns a new array', () => {
    const before = [bob];
    expect(addUnique(before, [])).not.toBe(before);
  });
});
