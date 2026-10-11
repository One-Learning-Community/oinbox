import { describe, expect, it } from 'vitest';
import type { ContactCard } from '../jmap/types';
import { checkGroupName, expandGroup, groupName, groupsHolding, memberCount, membersOf, membersWith, membersWithout, newGroup, sortGroups } from './groups';

const NOW = '2026-10-10T12:00:00Z';
const p = (id: string, name: string, more: Partial<ContactCard> = {}): ContactCard => ({ id, uid: `u-${id}`, addressBookIds: { b: true }, name: { full: name }, ...more });
const g = (id: string, name: string, members: string[], more: Partial<ContactCard> = {}): ContactCard => ({
  id, uid: `g-${id}`, kind: 'group', addressBookIds: { b: true }, name: { full: name }, ...(members.length ? { members: Object.fromEntries(members.map((m) => [m, true])) } : {}), ...more,
});
const adam = p('1', 'Adam Zeller', { emails: { e1: { address: 'adam@home.example' }, e2: { address: 'Adam@Work.example', pref: 1 } } });
const mia = p('2', 'Mia Mid');
const zoe = p('3', 'Zoë Probe', { emails: { e1: { address: 'zoe@x.example' } } });
const bare = p('4', '', { name: { full: '' }, emails: { e1: { address: 'bare@x.example' } } });
const people = [adam, bare, mia, zoe];

describe('groups', () => {
  it('names a group, and sorts groups by name leaving people out', () => {
    expect(groupName(g('a', 'Team', []))).toBe('Team');
    expect(groupName(g('a', '  ', []))).toBe('Untitled group');
    expect(sortGroups([g('b', 'zebra', []), adam, g('a', 'Älpha', []), g('c', 'Beta', [])]).map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });
  it('resolves members in list order', () => {
    const team = g('a', 'Team', ['u-3', 'u-1']);
    expect(membersOf(team, people).people.map((x) => x.id)).toEqual(['1', '3']);
    expect(memberCount(team, people)).toBe(2);
  });
  it('counts a deleted member and a member that is a group as unknown', () => {
    const inner = g('i', 'Inner', []);
    const team = g('a', 'Team', ['u-1', 'u-gone', 'g-i']);
    expect(membersOf(team, people)).toMatchObject({ unknown: 2, addresses: [] });
    expect(membersOf(team, [...people, inner]).people.map((x) => x.id)).toEqual(['1']);
  });
  it('lists a mailto: member another client wrote as a bare address', () => {
    const team = g('a', 'Team', ['MAILTO:Ext@Else.example', 'u-3']);
    expect(membersOf(team, people)).toMatchObject({ addresses: ['Ext@Else.example'], unknown: 0 });
    expect(memberCount(team, people)).toBe(2);
  });
  it('ignores a member key set to false, and a group with no members at all', () => {
    expect(membersOf({ ...g('a', 'T', []), members: { 'u-1': false } }, people).people).toEqual([]);
    expect(membersOf(g('a', 'T', []), people)).toEqual({ people: [], addresses: [], unknown: 0 });
  });
  it('expands to one recipient per member by preferred email, then the bare addresses', () => {
    const team = g('a', 'Team', ['u-1', 'u-2', 'u-3', 'u-4', 'mailto:ext@else.example']);
    expect(expandGroup(team, people)).toEqual({
      recipients: [
        { name: 'Adam Zeller', email: 'Adam@Work.example' },
        { name: null, email: 'bare@x.example' },
        { name: 'Zoë Probe', email: 'zoe@x.example' },
        { name: null, email: 'ext@else.example' },
      ],
      withoutEmail: 1,
    });
  });
  it('lists an address once, however it is reached', () => {
    const twin = p('5', 'Zoe Twin', { emails: { e1: { address: 'ZOE@x.example' } } });
    const team = g('a', 'Team', ['u-3', 'u-5', 'mailto:zoe@X.example']);
    expect(expandGroup(team, [...people, twin]).recipients).toEqual([{ name: 'Zoë Probe', email: 'zoe@x.example' }]);
  });
  it('skips, and counts, a member whose only "email" is no address', () => {
    const odd = p('6', 'Odd One', { emails: { e1: { address: 'not an address' }, e2: { address: '  ' } } });
    expect(expandGroup(g('a', 'T', ['u-6']), [odd])).toEqual({ recipients: [], withoutEmail: 1 });
  });
  it('finds the groups a card is in', () => {
    const groups = [g('a', 'A', ['u-1']), g('b', 'B', ['u-2', 'u-1']), g('c', 'C', ['u-3'])];
    expect(groupsHolding(adam, groups).map((x) => x.id)).toEqual(['a', 'b']);
    const { uid: _u, ...noUid } = adam;
    expect(groupsHolding(noUid, groups)).toEqual([]);
  });
  it('adds members keeping keys it does not know', () => {
    expect(membersWith(g('a', 'A', ['u-gone', 'u-1']), ['u-1', 'u-2'])).toEqual({ 'u-gone': true, 'u-1': true, 'u-2': true });
  });
  it('removes members, and is null when the last goes', () => {
    expect(membersWithout(g('a', 'A', ['u-gone', 'u-1']), ['u-1'])).toEqual({ 'u-gone': true });
    expect(membersWithout(g('a', 'A', ['u-1']), ['u-1'])).toBeNull();
  });
  it('makes a new group card', () => {
    expect(newGroup('  Team  ', 'b', NOW, 'urn:uuid:x')).toEqual({ '@type': 'Card', version: '1.0', kind: 'group', uid: 'urn:uuid:x', created: NOW, updated: NOW, name: { full: 'Team' }, addressBookIds: { b: true } });
  });
  it('checks a group name', () => {
    const groups = [g('a', 'Équipe', []), g('b', 'Team', [])];
    expect(checkGroupName('  ', groups)).toBe('Give the group a name.');
    expect(checkGroupName('x'.repeat(101), groups)).toBe('A group name can have at most 100 characters.');
    expect(checkGroupName('equipe', groups)).toBe('There is already a group called “Équipe”.');
    expect(checkGroupName('Equipe', groups, 'a')).toBeNull();
    expect(checkGroupName('New', groups)).toBeNull();
  });
});
