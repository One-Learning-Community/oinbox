import { describe, expect, it } from 'vitest';
import type { ContactCard } from '../jmap/types';
import { savedEntries } from './saved';

const p = (id: string, c: Partial<ContactCard>): ContactCard => ({ id, addressBookIds: { b: true }, ...c });
const zoe = p('1', {
  name: { components: [{ kind: 'given', value: 'Zoë' }, { kind: 'surname', value: 'Probe' }] },
  emails: { e1: { address: 'zoe@home.example' }, e2: { address: 'Zoe@Work.example', pref: 1 } },
  organizations: { o: { name: 'Acme Ltd', units: [{ name: 'Research' }] } },
  nicknames: { n: { name: 'Zed' } },
});

describe('savedEntries', () => {
  it('gives one entry per address of a person, marking the preferred one, with words to find them by', () => {
    expect(savedEntries([zoe])).toEqual([
      { email: 'Zoe@Work.example', name: 'Zoë Probe', preferred: true, words: ['Acme Ltd', 'Research', 'Zed'], contactId: '1' },
      { email: 'zoe@home.example', name: 'Zoë Probe', preferred: false, words: ['Acme Ltd', 'Research', 'Zed'], contactId: '1' },
    ]);
  });
  it('lists an address on two cards once, under the first', () => {
    const twin = p('2', { name: { full: 'Zoe Twin' }, emails: { e: { address: 'ZOE@home.example' } } });
    expect(savedEntries([zoe, twin]).map((e) => [e.email, e.contactId])).toEqual([['Zoe@Work.example', '1'], ['zoe@home.example', '1']]);
  });
  it('has no name for a card known only by its address, and skips blank addresses', () => {
    const bare = p('3', { name: { full: '' }, emails: { e: { address: 'bare@x.example' }, f: { address: '  ' } } });
    expect(savedEntries([bare])).toEqual([{ email: 'bare@x.example', name: '', preferred: true, words: [], contactId: '3' }]);
    expect(savedEntries([p('4', { phones: { p: { number: '555' } } })])).toEqual([]);
  });
});
