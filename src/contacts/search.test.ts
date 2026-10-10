import { describe, expect, it } from 'vitest';
import type { ContactCard } from '../jmap/types';
import { fold, matchPeople, sortPeople } from './search';

const p = (id: string, c: Partial<ContactCard>): ContactCard => ({ id, addressBookIds: { b: true }, ...c });
const named = (id: string, given: string, surname: string, more: Partial<ContactCard> = {}) => p(id, { name: { components: [{ kind: 'given', value: given }, { kind: 'surname', value: surname }] }, ...more });
const zoe = named('1', 'Zoë', 'Probe-Smith', { emails: { e: { address: 'zoe.ps@work.example' } }, phones: { p: { number: '+1 (555) 010-0199' } }, organizations: { o: { name: 'Acme Ltd', units: [{ name: 'Research' }] } }, nicknames: { n: { name: 'Zed' } } });
const adam = named('2', 'adam', 'Zeller');
const nameless = p('3', { name: { full: '' } });
const team = p('4', { kind: 'group', name: { full: 'Aardvarks' } });
const ten = named('5', 'Agent', '10');
const two = named('6', 'Agent', '2');

describe('sortPeople', () => {
  it('orders by name without case or accents, numbers by value, the nameless last, groups left out', () => {
    expect(sortPeople([zoe, nameless, ten, team, adam, two]).map((c) => c.id)).toEqual(['2', '6', '5', '1', '3']);
  });
});

describe('matchPeople', () => {
  const all = [zoe, adam, nameless];
  const ids = (q: string) => matchPeople(all, q).map((c) => c.id);
  it('matches every word as a prefix of a name, nickname, organisation or email word', () => {
    expect(fold('Zoë')).toBe('zoe');
    expect(ids('')).toEqual(['1', '2', '3']);
    expect(ids('zo')).toEqual(['1']);
    expect(ids('ZOE smi')).toEqual(['1']);
    expect(ids('smith zoë')).toEqual(['1']);
    expect(ids('acm res')).toEqual(['1']);
    expect(ids('zed')).toEqual(['1']);
    expect(ids('work.example')).toEqual(['1']);
    expect(ids('ps')).toEqual(['1']);
    expect(ids('ze')).toEqual(['1', '2']);
    expect(ids('oe')).toEqual([]);
    expect(ids('zoe adam')).toEqual([]);
  });
  it('finds a phone number by its digits, however it is written', () => {
    expect(ids('555 010')).toEqual(['1']);
    expect(ids('0100199')).toEqual(['1']);
    expect(ids('+1555')).toEqual(['1']);
    expect(ids('55')).toEqual([]);
  });
});
