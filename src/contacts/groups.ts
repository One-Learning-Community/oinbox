// Contact groups: a JSContact card of kind "group" whose members are other cards' uids.
// Pure: no Solid, no JMAP.
import type { ContactCard, EmailAddress, Id } from '../jmap/types';
import { displayName, emailsOf, isGroup } from './card';
import { fold } from './search';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const MAILTO = /^mailto:/i;
const ADDRESS = /^[^\s@]+@[^\s@]+$/;

export function groupName(group: ContactCard): string {
  const name = displayName(group);
  return name === 'No name' ? 'Untitled group' : name;
}

/** The group cards among `cards`, by name. */
export function sortGroups(cards: ContactCard[]): ContactCard[] {
  return cards
    .filter(isGroup)
    .map((card) => ({ card, name: fold(groupName(card)) }))
    .sort((a, b) => collator.compare(a.name, b.name) || (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0))
    .map((x) => x.card);
}

const keysOf = (group: ContactCard): string[] =>
  group.members && typeof group.members === 'object' ? Object.entries(group.members).filter(([, on]) => on === true).map(([key]) => key) : [];

export interface GroupMembers {
  /** In list order. */
  people: ContactCard[];
  /** From mailto: keys another client wrote. */
  addresses: string[];
  /** Keys naming no card, or a group: a group never holds a group here. */
  unknown: number;
}

/** `people` are the address book's people (no groups), in list order. A member is the card whose uid is the key, exactly. */
export function membersOf(group: ContactCard, people: ContactCard[]): GroupMembers {
  const keys = keysOf(group);
  const uids = new Set(keys.filter((k) => !MAILTO.test(k)));
  const members = people.filter((p) => !isGroup(p) && typeof p.uid === 'string' && uids.has(p.uid));
  const found = new Set(members.map((p) => p.uid));
  return {
    people: members,
    addresses: keys.filter((k) => MAILTO.test(k)).map((k) => k.replace(MAILTO, '').trim()).filter(Boolean),
    unknown: [...uids].filter((uid) => !found.has(uid)).length,
  };
}

export function memberCount(group: ContactCard, people: ContactCard[]): number {
  const m = membersOf(group, people);
  return m.people.length + m.addresses.length;
}

/** One recipient per member by preferred email, then the bare addresses; an address appears once. */
export function expandGroup(group: ContactCard, people: ContactCard[]): { recipients: EmailAddress[]; withoutEmail: number } {
  const members = membersOf(group, people);
  const seen = new Set<string>();
  const recipients: EmailAddress[] = [];
  let withoutEmail = 0;
  const add = (name: string | null, email: string) => {
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    recipients.push({ name, email });
  };
  for (const person of members.people) {
    const email = emailsOf(person).map((e) => e.address.trim()).find((a) => ADDRESS.test(a));
    if (!email) {
      withoutEmail++;
      continue;
    }
    const name = displayName(person);
    add(name === email ? null : name, email);
  }
  for (const address of members.addresses) if (ADDRESS.test(address)) add(null, address);
  return { recipients, withoutEmail };
}

/** The groups that name this card. A card with no uid can be in none. */
export function groupsHolding(card: ContactCard, groups: ContactCard[]): ContactCard[] {
  const uid = card.uid;
  if (!uid) return [];
  return groups.filter((g) => g.members?.[uid] === true);
}

/** The whole `members` map with these uids in it. Keys not touched are kept, known or not. */
export function membersWith(group: ContactCard, uids: string[]): Record<string, boolean> {
  return { ...(group.members ?? {}), ...Object.fromEntries(uids.map((uid) => [uid, true])) };
}

/** The whole `members` map without these uids, or null when nothing would be left. */
export function membersWithout(group: ContactCard, uids: string[]): Record<string, boolean> | null {
  const gone = new Set(uids);
  const left = Object.fromEntries(Object.entries(group.members ?? {}).filter(([key]) => !gone.has(key)));
  return Object.keys(left).length ? left : null;
}

export function newGroup(name: string, bookId: string, now: string, uid: string): Partial<ContactCard> {
  return { '@type': 'Card', version: '1.0', kind: 'group', uid, created: now, updated: now, name: { full: name.trim() }, addressBookIds: { [bookId]: true } };
}

/** What is wrong with a group's name, or null. `renaming` is the group being renamed, which may keep its own. */
export function checkGroupName(name: string, groups: ContactCard[], renaming?: Id): string | null {
  const wanted = name.trim();
  if (!wanted) return 'Give the group a name.';
  if (wanted.length > 100) return 'A group name can have at most 100 characters.';
  const twin = groups.find((g) => g.id !== renaming && fold(groupName(g)) === fold(wanted));
  return twin ? `There is already a group called “${groupName(twin)}”.` : null;
}
