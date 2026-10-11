import { describe, expect, it } from 'vitest';
import type { SavedEntry } from '../contacts/saved';
import {
  add,
  addUnique,
  completeAddress,
  isRobot,
  offer,
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

describe('offer', () => {
  const ann = person('ann@corp.com', 'Ann Lee', 2, 0, '2026-09-10T00:00:00Z');
  const anna = person('anna@corp.com', 'Anna Poe', 1, 0, '2026-09-12T00:00:00Z');

  it('leaves the suggestions alone while the text is not a full address', () => {
    expect(offer([ann], 'an')).toEqual([ann]);
    expect(offer([ann], 'ann@corp')).toEqual([ann]);
    expect(offer([ann], 'ann@corp.c')).toEqual([ann]);
    expect(offer([], '')).toEqual([]);
  });

  it('puts a full typed address first when nobody known has exactly it', () => {
    // ann@corp.co is somebody else: it must not turn into ann@corp.com on Enter.
    expect(emails(offer([ann], 'ann@corp.co'))).toEqual(['ann@corp.co', 'ann@corp.com']);
    expect(offer([ann], 'ann@corp.co')[0]).toEqual({ email: 'ann@corp.co', name: '', sent: 0, received: 0, last: '' });
    expect(emails(offer([], 'new@nowhere.test'))).toEqual(['new@nowhere.test']);
  });

  it('keeps a typed display name', () => {
    expect(offer([], 'Sam Roe <sam@nowhere.test>')[0]).toMatchObject({ email: 'sam@nowhere.test', name: 'Sam Roe' });
  });

  it('puts the person whose address was typed in full first, whatever their rank and letter case', () => {
    expect(offer([anna, ann], 'ANN@corp.com')).toEqual([ann, anna]);
  });
});

describe('suggest with the organisation directory', () => {
  const index = indexOf(
    person('bob@example.test', 'Bobby', 2, 2, '2026-09-10T00:00:00Z'),
    person('stranger@elsewhere.test', 'Sam Stranger', 0, 3, '2026-09-20T00:00:00Z'),
    person('support@example.test', 'Help Desk', 0, 9, '2026-09-21T00:00:00Z'),
  );
  const directory = [
    { email: 'Bob@example.test', name: 'Bob Example', group: false },
    { email: 'carol@example.test', name: 'Carol Example', group: false },
    { email: 'sales@example.test', name: 'Sales', group: true },
    { email: 'support@example.test', name: 'Support', group: true },
    { email: 'sven@example.test', name: '', group: false },
  ];
  const withDirectory = { ...none, directory };

  it('offers a colleague who has never been written to', () => {
    expect(suggest(index, 'car', withDirectory)).toEqual([{ email: 'carol@example.test', name: 'Carol Example', sent: 0, received: 0, last: '', group: false }]);
    expect(emails(suggest(index, 'example carol', withDirectory))).toEqual(['carol@example.test']);
    expect(suggest(index, 'car', none)).toEqual([]);
  });

  it('puts people written to first, then the organisation by name, then strangers', () => {
    // Sent to Bob; Sales, Support and sven are colleagues; the stranger has only written in.
    expect(emails(suggest(index, 's', { ...withDirectory, directory: [...directory, { email: 'bob.s@example.test', name: 'Stu', group: false }] }))).toEqual([
      'sales@example.test', 'bob.s@example.test', 'support@example.test', 'sven@example.test', 'stranger@elsewhere.test',
    ]);
    expect(emails(suggest(index, 'e', { ...withDirectory, limit: 2 }))).toEqual(['bob@example.test', 'carol@example.test']);
  });

  it("shows the directory's name and whether it is a group, keeping the history's counts and spelling", () => {
    expect(suggest(index, 'bob', withDirectory)).toEqual([{ email: 'bob@example.test', name: 'Bob Example', sent: 2, received: 2, last: '2026-09-10T00:00:00Z', group: false }]);
    expect(suggest(index, 'supp', withDirectory)[0]).toMatchObject({ name: 'Support', group: true, received: 9 });
    // Found by the directory's name, no longer by the one mail gave it.
    expect(suggest(index, 'help', withDirectory)).toEqual([]);
  });

  it('keeps the name mail gave an account the directory has none for', () => {
    const named = indexOf(person('sven@example.test', 'Sven Olsen', 1, 0, '2026-09-10T00:00:00Z'));
    expect(suggest(named, 'olsen', withDirectory)[0]).toMatchObject({ email: 'sven@example.test', name: 'Sven Olsen' });
  });

  it('leaves out addresses already taken', () => {
    expect(suggest(index, 'car', { ...withDirectory, exclude: new Set(['carol@example.test']) })).toEqual([]);
  });

  it('does not change the index', () => {
    const before = JSON.stringify(index);
    suggest(index, 'e', withDirectory);
    expect(JSON.stringify(index)).toBe(before);
  });
});

describe('suggest with saved contacts', () => {
  const opts = { exclude: new Set<string>(), limit: 6 };
  const entry = (email: string, name: string, more: Partial<SavedEntry> = {}): SavedEntry => ({ email, name, preferred: true, words: [], contactId: 'c1', ...more });
  it('ranks written-to, then saved, then the organisation, then strangers', () => {
    const index = add(add({}, [{ name: 'Sam Sent', email: 'sam@x.example' }], 'sent', '2026-01-02T00:00:00Z'), [{ name: 'Sal Stranger', email: 'sal@x.example' }], 'received', '2026-01-03T00:00:00Z');
    const out = suggest(index, 's', { ...opts, saved: [entry('sue@x.example', 'Sue Saved')], directory: [{ email: 'sid@x.example', name: 'Sid Staff', group: false }] });
    expect(out.map((r) => r.email)).toEqual(['sam@x.example', 'sue@x.example', 'sid@x.example', 'sal@x.example']);
    expect(out[1]).toMatchObject({ saved: true, contactId: 'c1', name: 'Sue Saved' });
  });
  it('shows the saved name over the directory\'s and the mail history\'s, in one row', () => {
    const index = add({}, [{ name: 'zoe (work)', email: 'Zoe@x.example' }], 'sent', '2026-01-02T00:00:00Z');
    const out = suggest(index, 'zo', { ...opts, saved: [entry('zoe@x.example', 'Dr Zoë Probe')], directory: [{ email: 'zoe@x.example', name: 'Zoe P', group: false }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Dr Zoë Probe', saved: true, sent: 1, group: false });
  });
  it('still finds a colleague saved under another name by the name the organisation gives them', () => {
    const out = suggest({}, 'rob', { ...opts, saved: [entry('r@x.example', 'Bobby')], directory: [{ email: 'r@x.example', name: 'Robert Roe', group: false }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Bobby', saved: true });
  });
  it('finds a saved person by organisation or nickname', () => {
    const saved = [entry('zoe@x.example', 'Zoë Probe', { words: ['Acme Ltd', 'Research', 'Zed'] })];
    expect(suggest({}, 'acm', { ...opts, saved }).map((r) => r.email)).toEqual(['zoe@x.example']);
    expect(suggest({}, 'zed', { ...opts, saved })).toHaveLength(1);
    expect(suggest({}, 'beta', { ...opts, saved })).toHaveLength(0);
  });
  it('offers each address of a person, the preferred first', () => {
    const saved = [entry('home@x.example', 'Zoë Probe', { preferred: false }), entry('work@x.example', 'Zoë Probe')];
    expect(suggest({}, 'zoe', { ...opts, saved }).map((r) => r.email)).toEqual(['work@x.example', 'home@x.example']);
  });
  it('offers a saved address even if it looks like a robot, and honours exclude', () => {
    const saved = [entry('noreply@shop.example', 'The Shop')];
    expect(suggest({}, 'shop', { ...opts, saved })).toHaveLength(1);
    expect(suggest({}, 'shop', { ...opts, exclude: new Set(['noreply@shop.example']), saved })).toHaveLength(0);
  });
});

describe('suggest with contact groups', () => {
  const opts = { exclude: new Set<string>(), limit: 6 };
  const lists = [{ id: 'g1', name: 'Équipe Projet', count: 3 }, { id: 'g2', name: 'Family', count: 1 }];
  it('offers a group by a prefix of any word of its name, accents aside, with its count', () => {
    expect(suggest({}, 'proj', { ...opts, lists })).toEqual([{ email: '', name: 'Équipe Projet', sent: 0, received: 0, last: '', list: { id: 'g1', count: 3 } }]);
    expect(suggest({}, 'equipe p', { ...opts, lists })).toHaveLength(1);
    expect(suggest({}, 'quipe', { ...opts, lists })).toHaveLength(0);
  });
  it('ranks a group with the saved contacts: after people written to, before the organisation', () => {
    const index = add({}, [{ name: 'Fay Sent', email: 'fay@x.example' }], 'sent', '2026-01-02T00:00:00Z');
    const saved: SavedEntry[] = [{ email: 'fab@x.example', name: 'Fab Saved', preferred: true, words: [], contactId: 'c1' }];
    const out = suggest(index, 'fa', { ...opts, lists, saved, directory: [{ email: 'fae@x.example', name: 'Fae Staff', group: false }] });
    expect(out.map((r) => r.name)).toEqual(['Fay Sent', 'Fab Saved', 'Family', 'Fae Staff']);
  });
  it('is not offered for an address that matches nothing of its name, and is not hidden by exclude', () => {
    expect(suggest({}, 'fam@x.example', { ...opts, lists })).toEqual([]);
    expect(suggest({}, 'fam', { ...opts, exclude: new Set(['', 'family']), lists })).toHaveLength(1);
  });
  it('counts toward the limit like any row', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, name: `Team ${i}`, count: 2 }));
    expect(suggest({}, 'team', { ...opts, lists: many })).toHaveLength(6);
  });
});
