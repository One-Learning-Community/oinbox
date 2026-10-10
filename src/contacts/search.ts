// The contact list's order and its type-ahead filter. Stalwart can do neither (no sort by name, and
// a search that depends on the search store), so both happen here, over the whole address book.
// Pure: no Solid, no JMAP.
import type { ContactCard } from '../jmap/types';
import { displayName, emailsOf, isGroup, organizationOf, phonesOf } from './card';

/** Lower case, without accents: "Zoë" is found by "zoe". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const NAMELESS = 'No name';

/** People by name, those with nothing to call them by last. Group cards are not people. */
export function sortPeople(cards: ContactCard[]): ContactCard[] {
  return cards
    .filter((c) => !isGroup(c))
    .map((card) => ({ card, name: displayName(card) }))
    .sort(
      (a, b) =>
        Number(a.name === NAMELESS) - Number(b.name === NAMELESS) ||
        collator.compare(fold(a.name), fold(b.name)) ||
        (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0),
    )
    .map((x) => x.card);
}

const digitsOf = (text: string) => text.replace(/\D/g, '');
/** A word made of a phone number's characters. */
const DIGITISH = /^[+\d().-]*\d[+\d().-]*$/;

interface Indexed {
  words: string[];
  phones: string[];
}
const indexed = new WeakMap<ContactCard, Indexed>();

function index(card: ContactCard): Indexed {
  let hit = indexed.get(card);
  if (!hit) {
    const org = organizationOf(card);
    const text = [displayName(card), ...Object.values(card.nicknames ?? {}).map((n) => n.name), org.name, org.department];
    const words = text.flatMap((t) => fold(t).split(/[^\p{L}\p{N}]+/u));
    for (const e of emailsOf(card)) {
      const email = fold(e.address);
      const at = email.lastIndexOf('@');
      const local = at < 0 ? email : email.slice(0, at);
      const labels = at < 0 ? [] : email.slice(at + 1).split('.');
      words.push(email, local, ...local.split(/[._+-]/), ...labels.map((_, i) => labels.slice(i).join('.')));
    }
    hit = { words: words.filter(Boolean), phones: phonesOf(card).map((p) => digitsOf(p.number)).filter(Boolean) };
    indexed.set(card, hit);
  }
  return hit;
}

/**
 * The cards matching what was typed, in the order given. Every word must begin a word of the name,
 * a nickname, the organisation or an email address; digits typed with or without spaces and
 * punctuation are also looked for inside the phone numbers.
 */
export function matchPeople(cards: ContactCard[], query: string): ContactCard[] {
  const typed = fold(query).split(/\s+/).filter(Boolean);
  if (!typed.length) return cards;
  // "555 010" is one number typed with a space.
  const terms: string[][] = [];
  for (const word of typed) {
    const last = terms[terms.length - 1];
    if (DIGITISH.test(word) && last && DIGITISH.test(last[0]!)) last.push(word);
    else terms.push([word]);
  }
  return cards.filter((card) => {
    const { words, phones } = index(card);
    const begins = (w: string) => words.some((x) => x.startsWith(w));
    return terms.every((term) => {
      if (!DIGITISH.test(term[0]!)) return begins(term[0]!);
      const digits = digitsOf(term.join(''));
      return (digits.length >= 3 && phones.some((p) => p.includes(digits))) || term.every(begins);
    });
  });
}
