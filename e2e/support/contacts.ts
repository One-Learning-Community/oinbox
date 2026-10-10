// Test-side helpers for the address book: JMAP Contacts over Basic auth, as support/mail.ts does for mail.
import { ALICE, BASE, PASSWORD, jmap } from './mail';

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'];
const CONTACTS = 'urn:ietf:params:jmap:contacts';
const ids = new Map<string, { account: string; book: string }>();

/** The user's contacts account and default address book. */
export async function addressBook(user = ALICE): Promise<{ account: string; book: string }> {
  let hit = ids.get(user);
  if (!hit) {
    const res = await fetch(`${BASE}/jmap/session`, { headers: { authorization: 'Basic ' + Buffer.from(`${user}:${PASSWORD}`).toString('base64') } });
    if (!res.ok) throw new Error(`session for ${user}: HTTP ${res.status}`);
    const account = ((await res.json()) as { primaryAccounts: Record<string, string> }).primaryAccounts[CONTACTS]!;
    const r = await jmap([['AddressBook/get', { accountId: account }, 'b']], user, USING);
    const books = r.b.list as { id: string; isDefault: boolean }[];
    hit = { account, book: (books.find((b) => b.isDefault) ?? books[0]!).id };
    ids.set(user, hit);
  }
  return hit;
}

export type Card = Record<string, any>;

/** Create cards in the default book (at most 500 a call); returns their ids in order. */
export async function createCards(cards: Card[], user = ALICE): Promise<string[]> {
  const { account, book } = await addressBook(user);
  const create = Object.fromEntries(cards.map((c, i) => [`c${i}`, { addressBookIds: { [book]: true }, ...c }]));
  const r = await jmap([['ContactCard/set', { accountId: account, create }, 's']], user, USING);
  return cards.map((_, i) => r.s.created[`c${i}`].id as string);
}

export async function updateCard(id: string, patch: Record<string, unknown>, user = ALICE): Promise<void> {
  const { account } = await addressBook(user);
  await jmap([['ContactCard/set', { accountId: account, update: { [id]: patch } }, 's']], user, USING);
}

export async function destroyCards(cardIds: string[], user = ALICE): Promise<void> {
  if (!cardIds.length) return;
  const { account } = await addressBook(user);
  for (let i = 0; i < cardIds.length; i += 500) {
    await jmap([['ContactCard/set', { accountId: account, destroy: cardIds.slice(i, i + 500) }, 's']], user, USING);
  }
}

/** Every card of the user, read in pages (a get without ids stops at 500). */
export async function listCards(user = ALICE): Promise<Card[]> {
  const { account } = await addressBook(user);
  const out: Card[] = [];
  for (let position = 0; ; position += 500) {
    const r = await jmap(
      [
        ['ContactCard/query', { accountId: account, position, limit: 500 }, 'q'],
        ['ContactCard/get', { accountId: account, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' } }, 'g'],
      ],
      user,
      USING,
    );
    out.push(...(r.g.list as Card[]));
    if ((r.q.ids as string[]).length < 500) break;
  }
  return out;
}

export async function destroyAllCards(user = ALICE): Promise<void> {
  await destroyCards((await listCards(user)).map((c) => c.id as string), user);
}

export const named = (given: string, surname: string, more: Card = {}): Card => ({
  name: { components: [{ kind: 'given', value: given }, { kind: 'surname', value: surname }] },
  ...more,
});
