// The address book as kept in IndexedDB between visits.
// Pure: no Solid, no JMAP.
import type { AddressBook, ContactCard } from '../jmap/types';

/** Every card and book, and the server states they were read at. */
export interface ContactsCache {
  cards: ContactCard[];
  books: AddressBook[];
  cardState: string;
  bookState: string;
}

/** A stored address book, if it has the shape this version writes; anything else is ignored. */
export function parseContactsCache(value: unknown): ContactsCache | undefined {
  const c = value as Partial<ContactsCache> | null | undefined;
  if (!c || typeof c !== 'object' || typeof c.cardState !== 'string' || typeof c.bookState !== 'string') return undefined;
  if (!Array.isArray(c.cards) || !Array.isArray(c.books)) return undefined;
  const ok =
    c.cards.every((card) => card && typeof card.id === 'string' && !!card.addressBookIds && typeof card.addressBookIds === 'object') &&
    c.books.every((book) => book && typeof book.id === 'string' && typeof book.name === 'string');
  return ok ? { cards: c.cards, books: c.books, cardState: c.cardState, bookState: c.bookState } : undefined;
}
