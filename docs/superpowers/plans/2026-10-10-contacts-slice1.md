# Contacts, slice 1 (viewing, editing, suggestions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Contacts page backed by Stalwart's JMAP Contacts where the user views, searches, adds, edits and deletes people, saves them from mail, and gets them as recipient suggestions.

**Architecture:** One `Contacts` store for the app holds the whole address book in memory (paged load, `/changes`, push, IndexedDB copy). Pure functions in `src/contacts/` read a JSContact card, build the form and the patch a save sends, and sort and search. The page, the dialog and the person popover are thin Solid components over the store; `suggest()` takes saved contacts beside the directory.

**Tech Stack:** SolidJS 1.9, @solidjs/router 1.0, rozie Dialog and Popover, @tanstack/virtual-core through `src/ui/virtual.ts`, Vitest + jsdom, Playwright, Stalwart 0.16.23.

**Spec:** `docs/superpowers/specs/2026-10-10-contacts-design.md` (slice 2 has its own plan, written after this one is built).

## Global Constraints

- Branch `contacts`, stacked on `org-recipients`. Never push, never merge.
- Contacts are the user's own: account `primaryAccounts['urn:ietf:params:jmap:contacts']`. The Contacts link is hidden while a shared mailbox is open; suggestions and the popover use the user's contacts in every mailbox.
- With no contacts capability in the session, nothing of this feature is shown and nothing is requested.
- Never `ContactCard/get` with `ids: null`; never a query `sort`, `OR` or `NOT`; at most 500 ids per get and per set.
- A new card is sent with `uid` (`urn:uuid:` + `crypto.randomUUID()`), `kind: 'individual'`, `created`, `updated`, name components and `name.full`. An update never sends `uid`.
- A save sends only changed properties, each as a whole map; a property emptied is sent as `null`.
- A card is at most 524,288 bytes of JSON.
- The list is a plain `<table>`; rozie DataTable is not used. Dialog and Popover are rozie's. If one lacks something, stop and report.
- No new dependencies.
- User-facing strings exactly as written in this plan.
- Commit after every task, message prefix `Contacts:`, with the session's attribution lines.

## Review Focus

1. **More than 500 contacts.** A first load must show all of them, not the first 500. Pinned in Task 4 (store test with 1,201 cards).
2. **A card made by a phone** (components surname-first, no `isOrdered`, no `uid`, contexts such as `internet`): the name must read "Given Surname" and a save here must not drop its other data. Pinned in Task 2.
3. **Editing while the card changes elsewhere:** a save of the phone number must not undo an email changed on another device a moment before. Pinned in Task 2 (the patch holds only changed properties) and Task 4.
4. **A card with nothing to call it by** (no name; only a phone; an empty `name.full`): it must still be listed, opened and deletable. Pinned in Task 2 (`displayName`) and Task 3 (sort).
5. **The same address on two saved cards, or saved and in the directory:** one suggestion row, under the saved name. Pinned in Task 5.

---

### Task 1: Types and the fake server's contacts

**Files:**
- Modify: `src/jmap/types.ts`
- Modify: `src/sync/fake-jmap.ts`
- Test: `src/sync/fake-jmap.test.ts`

**Interfaces:**
- Produces: `CONTACTS`, `CONTACTS_PARSE`, `ContactCard`, `AddressBook`, `NameComponent`, `CardEmail`, `CardPhone`, `CardAddress`, `PartialDate`; `Methods` entries `AddressBook/get`, `AddressBook/changes`, `ContactCard/get`, `ContactCard/query`, `ContactCard/changes`, `ContactCard/set`. On `FakeJmap`: `contactsSupported = true`, `books: Map<string, AddressBook>` (one default book `b`), `cards: Map<string, ContactCard>`, `addCard(card: Partial<ContactCard>): ContactCard` (stores and logs a creation), `bumpCards(c: Partial<{created: string[]; updated: string[]; destroyed: string[]}>)`, `cardChangesUnsupported = false`.

- [ ] **Step 1: Add the types** to `src/jmap/types.ts` (constants beside `PRINCIPALS`, interfaces beside `Principal`, methods in `Methods`):

```ts
export const CONTACTS = 'urn:ietf:params:jmap:contacts';
export const CONTACTS_PARSE = 'urn:ietf:params:jmap:contacts:parse';

export interface AddressBook {
  id: Id;
  name: string;
  isDefault: boolean;
  isSubscribed?: boolean;
}

export interface NameComponent {
  /** 'given', 'surname', 'given2', 'surname2', 'title', 'credential', 'generation', 'separator'. */
  kind: string;
  value: string;
}
export interface CardEmail {
  address: string;
  contexts?: Record<string, boolean>;
  /** 1 is the most preferred. */
  pref?: number;
  label?: string;
}
export interface CardPhone {
  number: string;
  contexts?: Record<string, boolean>;
  features?: Record<string, boolean>;
  pref?: number;
  label?: string;
}
export interface CardAddress {
  full?: string;
  components?: NameComponent[];
  contexts?: Record<string, boolean>;
  countryCode?: string;
  isOrdered?: boolean;
}
export interface PartialDate {
  '@type'?: 'PartialDate';
  year?: number;
  month?: number;
  day?: number;
}

/** A JSContact Card as Stalwart 0.16 stores it. It sets no uid, created or updated of its own. */
export interface ContactCard {
  id: Id;
  '@type'?: 'Card';
  version?: string;
  uid?: string;
  kind?: string;
  created?: UTCDate;
  updated?: UTCDate;
  addressBookIds: Record<Id, boolean>;
  name?: { full?: string; components?: NameComponent[]; isOrdered?: boolean };
  nicknames?: Record<string, { name: string }>;
  emails?: Record<string, CardEmail>;
  phones?: Record<string, CardPhone>;
  organizations?: Record<string, { name?: string; units?: { name: string }[] }>;
  titles?: Record<string, { name: string; kind?: string }>;
  addresses?: Record<string, CardAddress>;
  notes?: Record<string, { note: string }>;
  anniversaries?: Record<string, { kind?: string; date?: PartialDate | { '@type': 'Timestamp'; utc: string } }>;
  links?: Record<string, { uri: string; kind?: string; label?: string }>;
  onlineServices?: Record<string, { service?: string; user?: string; uri?: string }>;
  keywords?: Record<string, boolean>;
  media?: Record<string, { kind: string; uri?: string; mediaType?: string }>;
  members?: Record<string, boolean>;
}
```

```ts
  'AddressBook/get': { args: GetArgs; result: GetResult<AddressBook> };
  'AddressBook/changes': { args: ChangesArgs; result: ChangesResult };
  'ContactCard/get': { args: GetArgs; result: GetResult<ContactCard> };
  'ContactCard/query': { args: QueryArgs<Record<string, never>>; result: QueryResult };
  'ContactCard/changes': { args: ChangesArgs; result: ChangesResult };
  'ContactCard/set': { args: SetArgs<ContactCard>; result: SetResult<ContactCard> };
```

- [ ] **Step 2: Write the failing tests** in `src/sync/fake-jmap.test.ts` (a new `describe('contacts')`; `call` below is `(name, args) => fake.handle(name, { accountId: 'a1', ...args }, [CONTACTS])[1] as any`):

```ts
describe('contacts', () => {
  const book = { b: true };
  it('creates a card without adding a uid or dates, deriving name.full once', () => {
    const fake = new FakeJmap();
    const r = call(fake, 'ContactCard/set', { create: { c: { addressBookIds: book, name: { components: [{ kind: 'given', value: 'Zoë' }, { kind: 'surname', value: 'Probe' }] } } } });
    const id = r.created.c.id;
    expect(r.created.c).toEqual({ id });
    const card = fake.cards.get(id)!;
    expect(card.name!.full).toBe('Zoë Probe');
    expect(card.uid).toBeUndefined();
    expect(card.created).toBeUndefined();
    call(fake, 'ContactCard/set', { update: { [id]: { 'name/components/0/value': 'Zed' } } });
    expect(fake.cards.get(id)!.name).toMatchObject({ full: 'Zoë Probe', components: [{ kind: 'given', value: 'Zed' }, { kind: 'surname', value: 'Probe' }] });
  });
  it('gives a nameless card an empty full name', () => {
    const fake = new FakeJmap();
    const r = call(fake, 'ContactCard/set', { create: { c: { addressBookIds: book, emails: { e: { address: 'not an address' } } } } });
    expect(fake.cards.get(r.created.c.id)!.name).toEqual({ full: '' });
  });
  it('refuses unknown properties, a missing or unknown book, a changed uid, a second card with a uid, and an oversized card', () => {
    const fake = new FakeJmap();
    const r = call(fake, 'ContactCard/set', {
      create: {
        unknown: { addressBookIds: book, frobnicate: 1 },
        nobook: { name: { full: 'x' } },
        badbook: { addressBookIds: { zzz: true } },
        one: { addressBookIds: book, uid: 'u1' },
        big: { addressBookIds: book, notes: { n: { note: 'x'.repeat(524_288) } } },
      },
    });
    expect(r.notCreated.unknown).toMatchObject({ type: 'invalidProperties', properties: ['frobnicate'] });
    expect(r.notCreated.nobook).toMatchObject({ type: 'invalidProperties', description: 'Contact has to belong to at least one address book.' });
    expect(r.notCreated.badbook.description).toBe('addressBookId zzz does not exist.');
    expect(r.notCreated.big.description).toMatch(/exceeds the maximum allowed size of 524288 bytes/);
    const id = r.created.one.id;
    expect(call(fake, 'ContactCard/set', { create: { two: { addressBookIds: book, uid: 'u1' } } }).notCreated.two.description).toBe(`Contact with UID u1 already exists with id ${id}.`);
    expect(call(fake, 'ContactCard/set', { update: { [id]: { uid: 'u2' } } }).notUpdated[id].description).toBe('You cannot change the UID of a contact.');
    expect(call(fake, 'ContactCard/set', { update: { nope: { kind: 'individual' } } }).notUpdated.nope).toEqual({ type: 'notFound' });
  });
  it('patches by path, refuses a patch below a missing parent, and clears a property set to null', () => {
    const fake = new FakeJmap();
    const { id } = fake.addCard({ emails: { e1: { address: 'a@x.example' } }, notes: { n1: { note: 'hi' } } });
    expect(call(fake, 'ContactCard/set', { update: { [id]: { 'emails/e1/address': 'b@x.example', 'phones/p1': { number: '1' } } } }).notUpdated[id]).toMatchObject({ type: 'invalidProperties', description: 'Patch operation failed.' });
    expect(fake.cards.get(id)!.emails!.e1!.address).toBe('a@x.example');
    call(fake, 'ContactCard/set', { update: { [id]: { 'emails/e1/address': 'b@x.example', notes: null } } });
    expect(fake.cards.get(id)).toMatchObject({ emails: { e1: { address: 'b@x.example' } } });
    expect(fake.cards.get(id)!.notes).toBeUndefined();
  });
  it('pages a query, cuts get at 500, and refuses 501 ids', () => {
    const fake = new FakeJmap();
    for (let i = 0; i < 520; i++) fake.addCard({ name: { full: `P${i}` } });
    const q = call(fake, 'ContactCard/query', { position: 500, limit: 500 });
    expect(q.ids).toHaveLength(20);
    expect(call(fake, 'ContactCard/get', { ids: null }).list).toHaveLength(500);
    const all = call(fake, 'ContactCard/query', {}).ids as string[];
    expect(fake.handle('ContactCard/get', { accountId: 'a1', ids: all.slice(0, 501) }, [CONTACTS])).toEqual(['error', expect.objectContaining({ type: 'requestTooLarge' })]);
    expect(fake.handle('ContactCard/query', { accountId: 'a1', sort: [{ property: 'name' }] }, [CONTACTS])).toEqual(['error', { type: 'unsupportedSort', description: 'name' }]);
  });
  it('reports changes since a state, and cannot when told so', () => {
    const fake = new FakeJmap();
    const a = fake.addCard({ name: { full: 'A' } });
    const since = call(fake, 'ContactCard/get', { ids: [] }).state;
    const b = fake.addCard({ name: { full: 'B' } });
    call(fake, 'ContactCard/set', { update: { [a.id]: { kind: 'individual' } }, destroy: [] });
    expect(call(fake, 'ContactCard/changes', { sinceState: since })).toMatchObject({ created: [b.id], updated: [a.id], destroyed: [], hasMoreChanges: false });
    fake.cardChangesUnsupported = true;
    expect(fake.handle('ContactCard/changes', { accountId: 'a1', sinceState: since }, [CONTACTS])[1]).toEqual({ type: 'cannotCalculateChanges' });
  });
  it('answers unknownMethod without the capability', () => {
    const fake = new FakeJmap();
    expect(fake.handle('ContactCard/get', { accountId: 'a1', ids: [] }, [])[0]).toBe('error');
  });
});
```

- [ ] **Step 3: Run** `pnpm vitest run src/sync/fake-jmap.test.ts -t contacts`. Expected: FAIL (`fake.cards` undefined).

- [ ] **Step 4: Implement in `FakeJmap`.** State:

```ts
  /** Whether the session names a contacts account. */
  contactsSupported = true;
  books = new Map<string, AddressBook>([['b', { id: 'b', name: 'Stalwart Address Book (alice@example.test)', isDefault: true, isSubscribed: true }]]);
  cards = new Map<string, ContactCard>();
  cardState = 1;
  cardLog: { state: number; created: string[]; updated: string[]; destroyed: string[] }[] = [];
  /** Simulates ContactCard/changes answering cannotCalculateChanges. */
  cardChangesUnsupported = false;
  private nextCardId = 1;

  addCard(card: Partial<ContactCard>): ContactCard {
    const id = `c${this.nextCardId++}`;
    const stored = { '@type': 'Card', version: '1.0', addressBookIds: { b: true }, ...structuredClone(card), id } as ContactCard;
    stored.name = { ...stored.name, full: stored.name?.full ?? fullOf(stored.name?.components) };
    this.cards.set(id, stored);
    this.bumpCards({ created: [id] });
    return stored;
  }
  bumpCards(c: Partial<{ created: string[]; updated: string[]; destroyed: string[] }>) {
    this.cardLog.push({ state: ++this.cardState, created: c.created ?? [], updated: c.updated ?? [], destroyed: c.destroyed ?? [] });
  }
```

Module-level helpers:

```ts
const CARD_PROPS = new Set(['@type', 'version', 'uid', 'kind', 'created', 'updated', 'prodId', 'addressBookIds', 'name', 'nicknames', 'emails', 'phones', 'organizations', 'titles', 'addresses', 'notes', 'anniversaries', 'links', 'onlineServices', 'keywords', 'media', 'members']);
const MAX_CARD_BYTES = 524_288;
const MAX_OBJECTS = 500;
const fullOf = (components?: NameComponent[]) => (components ?? []).map((c) => c.value).join(' ');
const tooLarge = { type: 'requestTooLarge', description: 'The number of ids requested by the client exceeds the maximum number the server is willing to process in a single method call.' };

/** Apply one JMAP patch to a card copy. Returns the property that could not be set, else null. */
function patchCard(card: Record<string, unknown>, patch: Record<string, unknown>): string | null {
  for (const [path, value] of Object.entries(patch)) {
    const segs = path.split('/');
    let cur: any = card;
    for (const s of segs.slice(0, -1)) {
      cur = Array.isArray(cur) ? cur[Number(s)] : cur?.[s];
      if (cur === undefined || cur === null || typeof cur !== 'object') return path;
    }
    const last = segs[segs.length - 1]!;
    if (value === null) delete cur[last];
    else cur[last] = structuredClone(value);
  }
  return null;
}
```

In `handle`, before the `switch`: `if ((name.startsWith('ContactCard/') || name.startsWith('AddressBook/')) && !(using.includes(CONTACTS) && this.contactsSupported)) return ['error', { type: 'unknownMethod', description: `Method ${name} requires capability ${CONTACTS}.` }];`

Cases:

```ts
      case 'AddressBook/get':
        return [name, { accountId: args.accountId, state: 'ab1', list: [...this.books.values()].map((b) => structuredClone(b)), notFound: [] }];
      case 'AddressBook/changes':
        return [name, { accountId: args.accountId, oldState: args.sinceState, newState: 'ab1', hasMoreChanges: false, created: [], updated: [], destroyed: [] }];
      case 'ContactCard/query': {
        const sort = args.sort as { property: string }[] | undefined;
        if (sort?.length) return ['error', { type: 'unsupportedSort', description: sort[0]!.property }];
        const position = (args.position as number | undefined) ?? 0;
        const all = [...this.cards.keys()];
        const limit = (args.limit as number | undefined) || all.length;
        return [name, { accountId: args.accountId, queryState: `k${this.cardState}`, canCalculateChanges: true, position, ids: all.slice(position, position + limit) }];
      }
      case 'ContactCard/get': {
        if (ids && ids.length > MAX_OBJECTS) return ['error', tooLarge];
        const all = [...this.cards.values()];
        // Stalwart cuts an unbounded get at 500 without saying so.
        const list = (ids ? all.filter((c) => ids.includes(c.id)) : all.slice(0, MAX_OBJECTS)).map((c) => structuredClone(c));
        return [name, { accountId: args.accountId, state: `k${this.cardState}`, list, notFound: ids ? ids.filter((id) => !this.cards.has(id)) : [] }];
      }
      case 'ContactCard/changes': {
        if (this.cardChangesUnsupported) return ['error', { type: 'cannotCalculateChanges' }];
        const since = Number(String(args.sinceState).slice(1));
        const entries = this.cardLog.filter((l) => l.state > since);
        const uniq = (xs: string[]) => [...new Set(xs)];
        const destroyed = uniq(entries.flatMap((l) => l.destroyed));
        const created = uniq(entries.flatMap((l) => l.created)).filter((id) => !destroyed.includes(id));
        const updated = uniq(entries.flatMap((l) => l.updated)).filter((id) => !created.includes(id) && !destroyed.includes(id));
        return [name, { accountId: args.accountId, oldState: args.sinceState, newState: `k${this.cardState}`, hasMoreChanges: false, created, updated, destroyed }];
      }
      case 'ContactCard/set':
        return [name, this.cardSet(args)];
```

```ts
  private cardSet(args: Record<string, unknown>) {
    const create = (args.create ?? {}) as Record<string, Record<string, unknown>>;
    const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
    const destroy = (args.destroy ?? []) as string[];
    const oldState = `k${this.cardState}`;
    const invalid = (description: string, properties?: string[]) => ({ type: 'invalidProperties', description, ...(properties ? { properties } : {}) });
    const check = (card: Record<string, unknown>, selfId?: string) => {
      const unknown = Object.keys(card).find((k) => k !== 'id' && !CARD_PROPS.has(k));
      if (unknown) return invalid('Invalid property.', [unknown]);
      const books = Object.keys((card.addressBookIds ?? {}) as object);
      if (!books.length) return invalid('Contact has to belong to at least one address book.', ['addressBookIds']);
      const missing = books.find((b) => !this.books.has(b));
      if (missing) return invalid(`addressBookId ${missing} does not exist.`, ['addressBookIds']);
      const size = JSON.stringify(card).length;
      if (size > MAX_CARD_BYTES) return invalid(`Contact size ${size} exceeds the maximum allowed size of ${MAX_CARD_BYTES} bytes.`);
      const twin = card.uid ? [...this.cards.values()].find((c) => c.uid === card.uid && c.id !== selfId) : undefined;
      if (twin) return invalid(`Contact with UID ${card.uid as string} already exists with id ${twin.id}.`, ['uid']);
      return null;
    };
    const created: Record<string, { id: string }> = {};
    const notCreated: Record<string, unknown> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    for (const [key, card] of Object.entries(create)) {
      const err = check(card);
      if (err) notCreated[key] = err;
      else created[key] = { id: this.addCard(card as Partial<ContactCard>).id };
    }
    for (const [id, patch] of Object.entries(update)) {
      const cur = this.cards.get(id);
      if (!cur) notUpdated[id] = { type: 'notFound' };
      else if ('id' in patch) notUpdated[id] = invalid('The id property is immutable.', ['id']);
      else if ('uid' in patch) notUpdated[id] = invalid('You cannot change the UID of a contact.', ['uid']);
      else {
        const next = structuredClone(cur) as unknown as Record<string, unknown>;
        const failed = patchCard(next, patch);
        const err = failed ? invalid('Patch operation failed.', [failed]) : check(next, id);
        if (err) notUpdated[id] = err;
        else {
          this.cards.set(id, next as unknown as ContactCard);
          this.bumpCards({ updated: [id] });
          updated[id] = null;
        }
      }
    }
    for (const id of destroy) {
      if (this.cards.delete(id)) {
        this.bumpCards({ destroyed: [id] });
        destroyed.push(id);
      } else notDestroyed[id] = { type: 'notFound' };
    }
    const none = (o: object) => (Object.keys(o).length ? o : null);
    return { accountId: args.accountId, oldState, newState: `k${this.cardState}`, created: none(created), updated: none(updated), destroyed: destroyed.length ? destroyed : null, notCreated: none(notCreated), notUpdated: none(notUpdated), notDestroyed: none(notDestroyed) };
  }
```

In both session builders (`client()` and `fakeClient`), add to `primaryAccounts`: `...(fake.contactsSupported ? { [CONTACTS]: 'a1' } : {})` (in `fakeClient`: `first.contactsSupported`, `first.accountId`).

- [ ] **Step 5: Run** `pnpm vitest run src/sync/fake-jmap.test.ts && pnpm typecheck`. Expected: PASS.

- [ ] **Step 6: Commit** `Contacts: card types, and the fake server speaks ContactCard as Stalwart does`.

---

### Task 2: Reading a card, the form, and the patch (`src/contacts/card.ts`)

**Files:**
- Create: `src/contacts/card.ts`
- Test: `src/contacts/card.test.ts`

**Interfaces:**
- Consumes: `ContactCard` and friends from Task 1.
- Produces:

```ts
export const MAX_CARD_BYTES = 524_288;
export type EmailLabel = 'work' | 'personal' | 'other';
export type PhoneLabel = 'mobile' | 'work' | 'home' | 'other';
export type AddressLabel = 'work' | 'home' | 'other';
export interface EmailView { key: string; address: string; label: EmailLabel; preferred: boolean }
export interface PhoneView { key: string; number: string; label: PhoneLabel }
export interface AddressView { key: string; text: string; label: AddressLabel }
export interface ContactForm {
  given: string; surname: string;
  /** A data: URI, or null for none. */
  photo: string | null;
  emails: { key?: string; address: string; label: EmailLabel; preferred: boolean }[];
  phones: { key?: string; number: string; label: PhoneLabel }[];
  organization: string; department: string; title: string;
  addresses: { key?: string; text: string; label: AddressLabel }[];
  birthday: { day: string; month: string; year: string };
  notes: string;
}
export type FormErrors = Partial<Record<'name' | 'birthday' | 'size' | `emails.${number}`, string>>;
export function isGroup(card: ContactCard): boolean;
export function nameParts(card: ContactCard): { given: string; surname: string };
export function displayName(card: ContactCard): string;      // never ''
export function emailsOf(card: ContactCard): EmailView[];    // preferred first, then stored order
export function phonesOf(card: ContactCard): PhoneView[];
export function addressesOf(card: ContactCard): AddressView[];
export function organizationOf(card: ContactCard): { name: string; department: string; title: string };
export function birthdayOf(card: ContactCard): { day: number; month: number; year?: number } | null;
export function notesOf(card: ContactCard): string;
export function photoOf(card: ContactCard): string | null;   // data: URIs only
export function extrasOf(card: ContactCard): { label: string; values: string[] }[];
export function splitName(display: string): { given: string; surname: string };
export function toForm(card?: ContactCard, seed?: { name?: string; email?: string }): ContactForm;
export function validateForm(form: ContactForm): FormErrors;
export function newCard(form: ContactForm, bookId: string, now: string, uid: string): Partial<ContactCard>;
export function patchFor(card: ContactCard, form: ContactForm, now: string): Record<string, unknown>; // {} when nothing changed
export function cardBytes(card: unknown): number;
```

Rules (from the spec, made exact):
- `nameParts`: the first component of kind `given` and of kind `surname`. With no components: `splitName(name.full)`.
- `fullName(components)`: values of kinds `title`, `given`, `given2`, `surname`, `surname2`, `generation`, `credential`, in that order, joined by a space. Never by array position.
- `displayName`: `fullName` of the components; else `name.full` trimmed; else the first organisation's name; else the preferred email; else the first phone number; else `'No name'`.
- Email label: `contexts.work` → `work`; `contexts.private` → `personal`; else `other`. Preferred: the lowest `pref`; with none, the first key.
- Phone label: `features.mobile` (or `features.cell`) → `mobile`; `contexts.work` → `work`; `contexts.private` → `home`; else `other`.
- Address label: `contexts.work` → `work`; `contexts.private` → `home`; else `other`. Text: `full`, else the component values joined by `, `.
- `organizationOf`: first organisation's `name` and `units[0].name`; first title whose `kind` is `title` or absent.
- `birthdayOf`: the first anniversary of kind `birth` whose date has `month` and `day`.
- `notesOf`: every note joined by a blank line.
- `extrasOf`: in this order, only when present: `Nickname` (nickname names), `Links` (uris), `Online` (`service: user` or the uri), `Keywords` (keys), `Name` (components of other kinds than given and surname, e.g. "Dr", when any).
- `splitName('Zoë Probe-Smith')` → `{given: 'Zoë', surname: 'Probe-Smith'}`; `'Cher'` → `{given: 'Cher', surname: ''}`; `'Roe, Sam'` → `{given: 'Sam', surname: 'Roe'}`; `'Ana María de la Cruz'` → split at the last space.
- `validateForm`: `name` = `'Give a name, an organisation or an email address.'` when given, surname, organisation and every email are blank; `emails.<i>` = `'This is not an email address.'` for a non-blank address not matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`; `birthday` = `'Give both a day and a month.'` when one of day and month is set without the other or the date is impossible (day 1–31, month 1–12, year blank or 1–9999). Blank email, phone and address rows are dropped, not errors.
- Map keys: a form row with `key` keeps it; a new row gets the first free of `e1, e2…` (`p…` phones, `a…` addresses). The note key is the first stored note's key, else `n1`; the organisation's the first stored, else `o1`; the title's the first stored title's, else `t1`; the birthday's the stored birth anniversary's, else `b1`; the photo's the first stored media of kind `photo`, else `m1`.
- Building each map starts from the stored entry, so unknown sub-fields survive: an email row keeps `label`, extra contexts, etc. Contexts change only if the row's label differs from the label the stored entry reads as: `work` → `{work: true}`, `personal`/`home` → `{private: true}`, `other` → contexts removed; for phones `mobile` sets `features.mobile` and leaves contexts; a change away from `mobile` deletes `features.mobile` and `features.cell`. `pref`: the preferred row gets `pref: 1`, all others lose `pref`; with one email, no `pref` at all.
- An address row whose text equals the stored entry's text is kept whole. Otherwise `full` is the text and `components`, `isOrdered` and `countryCode` are removed.
- Stored entries of a map that the form never showed (a second organisation, a title of another kind, media that is not a photo, anniversaries other than birth, a photo with an http uri) are kept in the map.
- `patchFor`: computes the next value of `name`, `emails`, `phones`, `organizations`, `titles`, `addresses`, `anniversaries`, `notes`, `media`; includes a property only when `JSON.stringify` of it differs from the stored one (key order normalised by building next from stored); an empty map is sent as `null`, and is not "changed" when the stored property is absent. `name` = the stored components with given and surname replaced, inserted or removed, sorted in `fullName`'s order, `isOrdered: true`, and `full` = `fullName(...)`; when both are blank and no other components remain, `name: { full: '' }`. When anything changed, `updated: now` is added. Never `uid`, `kind`, `created`, `addressBookIds`.
- `newCard`: `{ '@type': 'Card', version: '1.0', uid, kind: 'individual', created: now, updated: now, addressBookIds: {[bookId]: true}, name, ...the non-empty maps }`.
- `toForm(undefined, seed)`: empty form with `splitName(seed.name)` and one email row `{address: seed.email, label: 'other', preferred: true}`. `toForm(card)`: from the views above; birthday numbers as strings, year `''` when absent.

- [ ] **Step 1: Write the failing tests** `src/contacts/card.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ContactCard } from '../jmap/types';
import { addressesOf, displayName, emailsOf, extrasOf, nameParts, newCard, notesOf, organizationOf, patchFor, phonesOf, photoOf, splitName, toForm, validateForm, birthdayOf, cardBytes, MAX_CARD_BYTES } from './card';

const NOW = '2026-10-10T12:00:00Z';
const card = (c: Partial<ContactCard>): ContactCard => ({ id: 'c1', addressBookIds: { b: true }, ...c });
/** As Stalwart returns a vCard a phone PUT over CardDAV. */
const phone = card({
  uid: 'dav-1',
  name: { full: 'Dav Phone', components: [{ kind: 'surname', value: 'Phone' }, { kind: 'given', value: 'Dav' }] },
  emails: { k1: { address: 'dav@home.example', contexts: { internet: true, private: true } }, k2: { address: 'dav@work.example', contexts: { work: true }, pref: 1 } },
  phones: { k1: { number: '+1 555 0199', features: { mobile: true }, contexts: { private: true } } },
  organizations: { k1: { name: 'Phone Co', units: [{ name: 'Sales' }] } },
  titles: { k1: { name: 'Seller', kind: 'title' } },
  addresses: { k1: { contexts: { private: true }, components: [{ kind: 'name', value: '12 High St' }, { kind: 'locality', value: 'Leeds' }] } },
  notes: { k1: { note: 'From a phone' } },
  anniversaries: { k1: { kind: 'birth', date: { '@type': 'PartialDate', month: 3, day: 14 } } },
  nicknames: { k1: { name: 'Davvy' } },
  keywords: { vip: true },
});

describe('reading a card', () => {
  it('reads the name by kind, not position', () => {
    expect(nameParts(phone)).toEqual({ given: 'Dav', surname: 'Phone' });
    expect(displayName(phone)).toBe('Dav Phone');
    expect(displayName(card({ name: { full: 'Comp Only', components: [{ kind: 'given', value: 'Patched' }, { kind: 'surname', value: 'Only' }] } }))).toBe('Patched Only');
    expect(displayName(card({ name: { components: [{ kind: 'surname', value: 'Probe' }, { kind: 'title', value: 'Dr' }, { kind: 'given', value: 'Zoë' }] } }))).toBe('Dr Zoë Probe');
  });
  it('always has something to call a card by', () => {
    expect(displayName(card({ name: { full: 'Only Full' } }))).toBe('Only Full');
    expect(displayName(card({ name: { full: '' }, organizations: { o: { name: 'Acme' } } }))).toBe('Acme');
    expect(displayName(card({ name: { full: '' }, emails: { e: { address: 'x@y.example' } } }))).toBe('x@y.example');
    expect(displayName(card({ phones: { p: { number: '555' } } }))).toBe('555');
    expect(displayName(card({ name: { full: '  ' } }))).toBe('No name');
  });
  it('labels emails, phones and addresses and puts the preferred email first', () => {
    expect(emailsOf(phone)).toEqual([
      { key: 'k2', address: 'dav@work.example', label: 'work', preferred: true },
      { key: 'k1', address: 'dav@home.example', label: 'personal', preferred: false },
    ]);
    expect(emailsOf(card({ emails: { a: { address: 'a@x.example' }, b: { address: 'b@x.example' } } })).map((e) => e.preferred)).toEqual([true, false]);
    expect(phonesOf(phone)).toEqual([{ key: 'k1', number: '+1 555 0199', label: 'mobile' }]);
    expect(addressesOf(phone)).toEqual([{ key: 'k1', text: '12 High St, Leeds', label: 'home' }]);
  });
  it('reads organisation, birthday, notes, photo and the extras', () => {
    expect(organizationOf(phone)).toEqual({ name: 'Phone Co', department: 'Sales', title: 'Seller' });
    expect(birthdayOf(phone)).toEqual({ day: 14, month: 3 });
    expect(notesOf(card({ notes: { a: { note: 'one' }, b: { note: 'two' } } }))).toBe('one\n\ntwo');
    expect(photoOf(card({ media: { m: { kind: 'photo', uri: 'https://example.org/p.png' } } }))).toBeNull();
    expect(photoOf(card({ media: { l: { kind: 'logo', uri: 'data:image/png;base64,AA' }, m: { kind: 'photo', uri: 'data:image/png;base64,BB' } } }))).toBe('data:image/png;base64,BB');
    expect(extrasOf(phone)).toEqual([{ label: 'Nickname', values: ['Davvy'] }, { label: 'Keywords', values: ['vip'] }]);
  });
  it('splits a display name', () => {
    expect(splitName('Zoë Probe-Smith')).toEqual({ given: 'Zoë', surname: 'Probe-Smith' });
    expect(splitName('Cher')).toEqual({ given: 'Cher', surname: '' });
    expect(splitName('Roe, Sam')).toEqual({ given: 'Sam', surname: 'Roe' });
    expect(splitName('  Ana María de la Cruz ')).toEqual({ given: 'Ana María de la', surname: 'Cruz' });
    expect(splitName('')).toEqual({ given: '', surname: '' });
  });
});

describe('the form', () => {
  it('starts from a seed', () => {
    const f = toForm(undefined, { name: 'Nora New', email: 'nora@new.example' });
    expect(f).toMatchObject({ given: 'Nora', surname: 'New', emails: [{ address: 'nora@new.example', label: 'other', preferred: true }], phones: [], notes: '' });
  });
  it('checks what the server does not', () => {
    const blank = toForm();
    expect(validateForm(blank)).toEqual({ name: 'Give a name, an organisation or an email address.' });
    expect(validateForm({ ...blank, organization: 'Acme' })).toEqual({});
    expect(validateForm({ ...blank, given: 'A', emails: [{ address: 'ok@x.example', label: 'work', preferred: true }, { address: 'not an address', label: 'other', preferred: false }, { address: ' ', label: 'other', preferred: false }] })).toEqual({ 'emails.1': 'This is not an email address.' });
    expect(validateForm({ ...blank, given: 'A', birthday: { day: '14', month: '', year: '' } })).toEqual({ birthday: 'Give both a day and a month.' });
    expect(validateForm({ ...blank, given: 'A', birthday: { day: '32', month: '1', year: '' } })).toEqual({ birthday: 'Give both a day and a month.' });
  });
  it('makes a new card with a uid, dates, components and a full name', () => {
    const f = { ...toForm(), given: 'Zoë', surname: 'Probe', emails: [{ address: ' zoe@work.example ', label: 'work' as const, preferred: true }], phones: [{ number: '555', label: 'mobile' as const }], organization: 'Acme', department: 'Research', title: 'Head', notes: 'Hi', birthday: { day: '14', month: '3', year: '1990' }, photo: 'data:image/jpeg;base64,AA' };
    expect(newCard(f, 'b', NOW, 'urn:uuid:1')).toEqual({
      '@type': 'Card', version: '1.0', uid: 'urn:uuid:1', kind: 'individual', created: NOW, updated: NOW, addressBookIds: { b: true },
      name: { components: [{ kind: 'given', value: 'Zoë' }, { kind: 'surname', value: 'Probe' }], isOrdered: true, full: 'Zoë Probe' },
      emails: { e1: { address: 'zoe@work.example', contexts: { work: true } } },
      phones: { p1: { number: '555', features: { mobile: true } } },
      organizations: { o1: { name: 'Acme', units: [{ name: 'Research' }] } },
      titles: { t1: { name: 'Head', kind: 'title' } },
      notes: { n1: { note: 'Hi' } },
      anniversaries: { b1: { kind: 'birth', date: { '@type': 'PartialDate', year: 1990, month: 3, day: 14 } } },
      media: { m1: { kind: 'photo', uri: 'data:image/jpeg;base64,AA' } },
    });
  });
});

describe('the patch', () => {
  it('is empty when nothing changed, for a card made here and for a phone-made one', () => {
    expect(patchFor(phone, toForm(phone), NOW)).toEqual({});
    const mine = card(newCard({ ...toForm(), given: 'A', surname: 'B', emails: [{ address: 'a@b.example', label: 'other', preferred: true }] }, 'b', NOW, 'u') as ContactCard);
    expect(patchFor(mine, toForm(mine), NOW)).toEqual({});
  });
  it('holds only what changed, as whole maps, with the time', () => {
    const f = toForm(phone);
    f.phones[0]!.number = '+1 555 0200';
    expect(patchFor(phone, f, NOW)).toEqual({ phones: { k1: { number: '+1 555 0200', features: { mobile: true }, contexts: { private: true } } }, updated: NOW });
  });
  it('keeps what the form does not show inside a changed map', () => {
    const f = toForm(phone);
    f.emails.push({ address: 'third@x.example', label: 'work', preferred: false });
    expect(patchFor(phone, f, NOW).emails).toEqual({
      k1: { address: 'dav@home.example', contexts: { internet: true, private: true } },
      k2: { address: 'dav@work.example', contexts: { work: true }, pref: 1 },
      e1: { address: 'third@x.example', contexts: { work: true } },
    });
  });
  it('moves the preferred mark and changes a label', () => {
    const f = toForm(phone);
    f.emails = f.emails.map((e) => ({ ...e, preferred: e.key === 'k1', label: e.key === 'k1' ? 'other' : e.label }));
    expect(patchFor(phone, f, NOW).emails).toEqual({ k1: { address: 'dav@home.example', pref: 1 }, k2: { address: 'dav@work.example', contexts: { work: true } } });
  });
  it('renames by components, keeping the others, and rewrites full', () => {
    const dr = card({ name: { full: 'Dr Zoë Probe', components: [{ kind: 'given', value: 'Zoë' }, { kind: 'surname', value: 'Probe' }, { kind: 'title', value: 'Dr' }], isOrdered: true } });
    const f = toForm(dr);
    f.surname = 'Probe-Smith';
    expect(patchFor(dr, f, NOW)).toEqual({ name: { components: [{ kind: 'title', value: 'Dr' }, { kind: 'given', value: 'Zoë' }, { kind: 'surname', value: 'Probe-Smith' }], isOrdered: true, full: 'Dr Zoë Probe-Smith' }, updated: NOW });
  });
  it('gives a full-name-only card components on a rename, and none when the name is unchanged', () => {
    const only = card({ name: { full: 'Only Full' } });
    expect(patchFor(only, toForm(only), NOW)).toEqual({});
    const f = toForm(only);
    f.given = 'Renamed';
    expect(patchFor(only, f, NOW).name).toEqual({ components: [{ kind: 'given', value: 'Renamed' }, { kind: 'surname', value: 'Full' }], isOrdered: true, full: 'Renamed Full' });
  });
  it('clears an emptied property with null and drops components from an edited address', () => {
    const f = toForm(phone);
    f.notes = '';
    f.phones = [];
    f.birthday = { day: '', month: '', year: '' };
    f.addresses[0]!.text = '1 New Rd';
    expect(patchFor(phone, f, NOW)).toEqual({ notes: null, phones: null, anniversaries: null, addresses: { k1: { contexts: { private: true }, full: '1 New Rd' } }, updated: NOW });
  });
  it('keeps media that is not the photo, and another client\'s http photo', () => {
    const c = card({ name: { full: 'L' }, media: { l: { kind: 'logo', uri: 'data:image/png;base64,AA' }, h: { kind: 'photo', uri: 'https://example.org/p.png' } } });
    const f = toForm(c);
    f.photo = 'data:image/jpeg;base64,CC';
    expect(patchFor(c, f, NOW).media).toEqual({ l: { kind: 'logo', uri: 'data:image/png;base64,AA' }, h: { kind: 'photo', uri: 'https://example.org/p.png' }, m1: { kind: 'photo', uri: 'data:image/jpeg;base64,CC' } });
  });
  it('never sends uid, kind, created or addressBookIds', () => {
    const f = toForm(phone);
    f.given = 'X';
    expect(Object.keys(patchFor(phone, f, NOW)).sort()).toEqual(['name', 'updated']);
  });
  it('measures a card in bytes', () => {
    expect(cardBytes({ a: 'é' })).toBe(new TextEncoder().encode('{"a":"é"}').length);
    expect(MAX_CARD_BYTES).toBe(524_288);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/contacts/card.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/contacts/card.ts`** to the rules above. Header comment: `// A saved person as oinbox reads and writes one: a JSContact Card (RFC 9553) the way Stalwart keeps it.` then `// Pure: no Solid, no JMAP.` Structure: label readers; the `*Of` readers; `splitName`; `toForm`; `validateForm`; a private `nextMaps(card | undefined, form)` returning `{name, emails, phones, organizations, titles, addresses, anniversaries, notes, media}` with each map built from the stored entries; `newCard` (drops empty maps) and `patchFor` (diffs by `JSON.stringify`, `null` for an emptied map that was stored) both call it. Trim every text field. Photo media entry: `{ kind: 'photo', uri }`.

- [ ] **Step 4: Run** `pnpm vitest run src/contacts/card.test.ts && pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `Contacts: reading a card, the form, and a save that sends only what changed`.

---

### Task 3: Sorting and searching (`src/contacts/search.ts`)

**Files:**
- Create: `src/contacts/search.ts`
- Test: `src/contacts/search.test.ts`

**Interfaces:**
- Consumes: `displayName`, `emailsOf`, `phonesOf`, `organizationOf`, `isGroup` from Task 2.
- Produces: `fold(s: string): string` (lower case, diacritics removed); `sortPeople(cards: ContactCard[]): ContactCard[]` (groups left out; by folded display name with `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`, "No name" cards last, ties by id); `matchPeople(cards: ContactCard[], query: string): ContactCard[]` (order kept).

Matching: the query is folded and split on whitespace. A word matches a card when it is a prefix of one of the card's words, or, if it is three or more digits after removing `+ - ( ) . space`, when those digits occur in the digits of one of the card's phone numbers. The card's words: the folded display name, nicknames, organisation name and department split on `/[^\p{L}\p{N}]+/u`; for each email the whole address, the local part, the local part split on `/[._+-]/`, and each dot-suffix of the domain. Every word of the query must match. An empty query matches everything.

- [ ] **Step 1: Write the failing tests:**

```ts
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
```

- [ ] **Step 2: Run** `pnpm vitest run src/contacts/search.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()`. In `matchPeople`, a query such as `555 010` is two words: a word that is all digits and punctuation but shorter than three digits is joined to its digit neighbours first (join consecutive digit-only words, then test the joined digits against phones; if the joined run has fewer than three digits it matches nothing). Cache a card's words in a `WeakMap<ContactCard, string[]>`.
- [ ] **Step 4: Run** the test and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Contacts: the list's order and the type-ahead search`.

---

### Task 4: The store, its cache, and the wiring

**Files:**
- Create: `src/app/contacts.ts`
- Test: `src/app/contacts.test.ts`
- Modify: `src/cache/persist.ts` (add `loadContacts`, `saveContacts`; `clearSnapshots` also deletes `contacts:<key>`)
- Modify: `src/app/context.tsx` (`contacts: Contacts`, `hasContacts: () => boolean`)
- Modify: `src/index.tsx` (build, start, push, reconnect)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:

```ts
export interface ContactsCache { cards: ContactCard[]; books: AddressBook[]; cardState: string; bookState: string }
export function parseContactsCache(value: unknown): ContactsCache | undefined;
export type ContactDialogState = { kind: 'new'; seed?: { name?: string; email?: string } } | { kind: 'edit'; id: Id };
export type ContactWrite = { ok: true; id: Id } | { ok: false; error: string };
export interface Contacts {
  /** Whether the server has JMAP Contacts. */
  available(): boolean;
  state: { cards: Record<Id, ContactCard>; books: Record<Id, AddressBook>; loaded: boolean; failed: boolean };
  /** Reactive: people (no groups), in list order. */
  people: Accessor<ContactCard[]>;
  /** Reactive: the saved person with this address (compared without case), the first in list order. */
  byEmail(email: string): ContactCard | undefined;
  start(key: string): Promise<void>;
  /** Load everything again (the page's Retry). */
  reload(): Promise<void>;
  onStateChange(change: StateChange): void;
  onConnected(): void;
  create(form: ContactForm): Promise<ContactWrite>;
  update(id: Id, form: ContactForm): Promise<ContactWrite>;
  /** Delete, with Undo in the toast. */
  remove(id: Id): Promise<ContactWrite>;
  dialog: Accessor<ContactDialogState | null>;
  openDialog(state: ContactDialogState): void;
  closeDialog(): void;
}
export function createContacts(client: JmapClient, toast: ToastFn, opts?: { now?: () => string; uid?: () => string; saveDelayMs?: number }): Contacts;
```

Behaviour:
- `accountId()` = `client.hasSession ? client.session.primaryAccounts[CONTACTS] : undefined`. Every method is a no-op (writes answer `{ok: false, error: 'Contacts are not available.'}`) without it. Requests use `[CORE, CONTACTS]`.
- `start(key)`: read `loadContacts(key)`; if present, put it in the store (`loaded: true`) and `catchUp()`; else `loadAll()`. Concurrent calls share one run.
- `loadAll()`: first request `AddressBook/get` + `ContactCard/query {position: 0, limit: 500}` + `ContactCard/get {'#ids': query.ref('/ids')}`; then further pages while a page returned 500 ids. The card state kept is the **first** page's `state`; when done, `catchUp()` once, so a change made during a long load is not lost. Sets `loaded: true, failed: false`; on error sets `failed: true` and toasts `Couldn't load your contacts: <message>` once per failing streak (`UnauthorizedError` is rethrown, as the calendar store does).
- `catchUp()`: one run at a time; a call during a run schedules exactly one more. `ContactCard/changes` and `AddressBook/changes` from the known states, repeated while `hasMoreChanges`. Destroyed ids are removed; created and updated are fetched with `ContactCard/get` in chunks of 500; books are refetched whole when the book changes list is non-empty. `res.error(call)?.type === 'cannotCalculateChanges'` on either → `loadAll()`.
- `onStateChange(c)`: `const t = c.changed[accountId]`; if `t?.ContactCard` differs from the card state or `t?.AddressBook` from the book state → `catchUp()` (errors to `logUnexpected`).
- `onConnected()`: `catchUp()` if started, else nothing.
- After every applied change, save `saveContacts(key, cache)` debounced 2 s (`opts.saveDelayMs`), as recipients does.
- `create(form)`: `newCard(form, defaultBookId, now(), uid())` where the default book is the one with `isDefault`, else the first; `ContactCard/set {create: {new: card}}`; on success `ContactCard/get` the id, put it in the store, set the card state to the set's `newState` only if `oldState` equals the state we hold (else `catchUp()`), answer `{ok: true, id}`. `notCreated.new` → `{ok: false, error: description ?? 'The server refused the contact (<type>).'}`. A thrown non-auth error → `{ok: false, error: message}`.
- `update(id, form)`: `patchFor(state.cards[id], form, now())`; an empty patch answers `{ok: true, id}` without a request; a card no longer in the store or `notUpdated[id].type === 'notFound'` → `{ok: false, error: 'This contact no longer exists.'}`.
- `remove(id)`: keeps a copy; `ContactCard/set {destroy: [id]}`; removes it from the store; `toast('Contact deleted.', 'info', { label: 'Undo', run })` where `run` creates the copy again without `id` (same `uid`), puts the new card in the store and, if that fails, toasts `Couldn't restore the contact: <error>` as an error. A failed destroy toasts `Couldn't delete the contact: <error>` and answers `{ok: false}`.
- `people` = `createMemo(() => sortPeople(Object.values(state.cards)))`. `byEmail` reads a memoised `Map` built from `people()` × `emailsOf`, first card wins.
- `parseContactsCache`: an object with string `cardState`, `bookState` and arrays `cards` (each with string `id` and object `addressBookIds`) and `books`; else `undefined`.

- [ ] **Step 1: Write the failing tests** `src/app/contacts.test.ts` (persist mocked as `directory.test.ts` does; `setup()` builds `FakeJmap`, `fake.client()`, a `vi.fn()` toast, and `createRoot(() => createContacts(client, toast, { now: () => NOW, uid: () => 'urn:uuid:test', saveDelayMs: 0 }))`):

```ts
describe('createContacts', () => {
  it('loads an address book of more than 500 cards whole, in pages', async () => {
    const { fake, contacts } = setup();
    for (let i = 0; i < 1201; i++) fake.addCard({ name: { components: [{ kind: 'given', value: `P${i}` }] } });
    await contacts.start('alice:a1');
    expect(contacts.people()).toHaveLength(1201);
    expect(contacts.state.loaded).toBe(true);
    expect(fake.sent.filter(([n]) => n === 'ContactCard/query').map(([, a]) => a.position)).toEqual([0, 500, 1000]);
    expect(fake.sent.some(([n, a]) => n === 'ContactCard/get' && a.ids === null)).toBe(false);
  });
  it('does not lose a card created while the pages were loading', async () => {
    const { fake, contacts } = setup();
    for (let i = 0; i < 600; i++) fake.addCard({ name: { full: `P${i}` } });
    let added = false;
    fake.onCall = (name, args) => {
      if (name === 'ContactCard/query' && args.position === 500 && !added) {
        added = true;
        fake.addCard({ name: { components: [{ kind: 'given', value: 'Late' }] } });
      }
    };
    await contacts.start('k');
    expect(contacts.people().filter((c) => displayName(c) === 'Late')).toHaveLength(1);
    expect(contacts.people()).toHaveLength(601);
  });
  it('starts from the stored copy and asks only for what changed', async () => {
    const { fake, contacts } = setup();
    const a = fake.addCard({ name: { full: 'A' } });
    const state = `k${fake.cardState}`;
    const b = fake.addCard({ name: { full: 'B' } });
    vi.mocked(loadContacts).mockResolvedValue({ cards: [structuredClone(a)], books: [...fake.books.values()], cardState: state, bookState: 'ab1' });
    await contacts.start('k');
    expect(Object.keys(contacts.state.cards).sort()).toEqual([a.id, b.id]);
    expect(fake.calls).not.toContain('ContactCard/query');
  });
  it('loads everything again when the server cannot say what changed', async () => {
    const { fake, contacts } = setup();
    fake.addCard({ name: { full: 'A' } });
    vi.mocked(loadContacts).mockResolvedValue({ cards: [], books: [], cardState: 'k0', bookState: 'ab1' });
    fake.cardChangesUnsupported = true;
    await contacts.start('k');
    expect(contacts.people()).toHaveLength(1);
  });
  it('follows a push: created, updated and destroyed cards', async () => {
    const { fake, contacts } = setup();
    const a = fake.addCard({ name: { full: 'A' } });
    const gone = fake.addCard({ name: { full: 'Gone' } });
    await contacts.start('k');
    const b = fake.addCard({ name: { full: 'B' } });
    fake.handle('ContactCard/set', { accountId: 'a1', update: { [a.id]: { 'name/full': 'A2' } }, destroy: [gone.id] }, [CONTACTS]);
    contacts.onStateChange({ '@type': 'StateChange', changed: { a1: { ContactCard: `k${fake.cardState}` } } });
    await vi.waitFor(() => expect(contacts.state.cards[b.id]).toBeDefined());
    expect(contacts.state.cards[a.id]!.name!.full).toBe('A2');
    expect(contacts.state.cards[gone.id]).toBeUndefined();
    const calls = fake.calls.length;
    contacts.onStateChange({ '@type': 'StateChange', changed: { a1: { ContactCard: `k${fake.cardState}` } } });
    contacts.onStateChange({ '@type': 'StateChange', changed: { other: { ContactCard: 'x' } } });
    await Promise.resolve();
    expect(fake.calls.length).toBe(calls);
  });
  it('creates in the default book with a uid and shows the card', async () => {
    const { fake, contacts } = setup();
    await contacts.start('k');
    const r = await contacts.create({ ...toForm(), given: 'Nora', surname: 'New', emails: [{ address: 'nora@new.example', label: 'work', preferred: true }] });
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    expect(fake.cards.get(id)).toMatchObject({ uid: 'urn:uuid:test', kind: 'individual', created: NOW, addressBookIds: { b: true } });
    expect(contacts.byEmail('NORA@new.example')?.id).toBe(id);
  });
  it('sends only the changed property on update, and nothing when nothing changed', async () => {
    const { fake, contacts } = setup();
    const a = fake.addCard({ name: { components: [{ kind: 'given', value: 'A' }] }, emails: { e1: { address: 'a@x.example' } } });
    await contacts.start('k');
    const before = fake.calls.length;
    expect(await contacts.update(a.id, toForm(contacts.state.cards[a.id]))).toEqual({ ok: true, id: a.id });
    expect(fake.calls.length).toBe(before);
    // Another device changes the email; this browser has not heard yet.
    fake.handle('ContactCard/set', { accountId: 'a1', update: { [a.id]: { 'emails/e1/address': 'elsewhere@x.example' } } }, [CONTACTS]);
    const f = toForm(contacts.state.cards[a.id]);
    f.phones.push({ number: '555', label: 'mobile' });
    await contacts.update(a.id, f);
    expect(fake.cards.get(a.id)).toMatchObject({ emails: { e1: { address: 'elsewhere@x.example' } }, phones: { p1: { number: '555' } } });
    expect(contacts.state.cards[a.id]!.emails!.e1!.address).toBe('elsewhere@x.example');
  });
  it('says so when the card was deleted elsewhere', async () => {
    const { fake, contacts } = setup();
    const a = fake.addCard({ name: { full: 'A' } });
    await contacts.start('k');
    fake.cards.delete(a.id);
    const f = toForm(contacts.state.cards[a.id]);
    f.given = 'B';
    expect(await contacts.update(a.id, f)).toEqual({ ok: false, error: 'This contact no longer exists.' });
  });
  it('deletes with an undo that brings the card back under its uid', async () => {
    const { fake, contacts, toast } = setup();
    const a = fake.addCard({ uid: 'u-1', name: { full: 'A' }, notes: { n: { note: 'kept' } } });
    await contacts.start('k');
    expect((await contacts.remove(a.id)).ok).toBe(true);
    expect(contacts.people()).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith('Contact deleted.', 'info', expect.objectContaining({ label: 'Undo' }));
    toast.mock.calls[0]![2].run();
    await vi.waitFor(() => expect(contacts.people()).toHaveLength(1));
    expect([...fake.cards.values()][0]).toMatchObject({ uid: 'u-1', notes: { n: { note: 'kept' } } });
  });
  it('reports a failed load once and loads on retry', async () => {
    const { fake, contacts, toast } = setup();
    fake.addCard({ name: { full: 'A' } });
    fake.onCall = () => { throw new Error('down'); };
    await contacts.start('k');
    expect(contacts.state).toMatchObject({ loaded: false, failed: true });
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Couldn't load your contacts: /), 'error');
    fake.onCall = null;
    await contacts.reload();
    expect(contacts.state).toMatchObject({ loaded: true, failed: false });
    expect(contacts.people()).toHaveLength(1);
  });
  it('does nothing on a server without contacts', async () => {
    const { fake, contacts } = setup({ contactsSupported: false });
    await contacts.start('k');
    expect(contacts.available()).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(await contacts.create(toForm())).toEqual({ ok: false, error: 'Contacts are not available.' });
  });
  it('stores what it holds for the next start', async () => {
    const { fake, contacts } = setup();
    const a = fake.addCard({ name: { full: 'A' } });
    await contacts.start('alice:a1');
    await vi.waitFor(() => expect(saveContacts).toHaveBeenCalled());
    expect(vi.mocked(saveContacts).mock.lastCall).toEqual(['alice:a1', expect.objectContaining({ cards: [expect.objectContaining({ id: a.id })], cardState: `k${fake.cardState}` })]);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/app/contacts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/app/contacts.ts` (store via `createStore`, cards replaced with `reconcile` per id), and in `persist.ts`:

```ts
/** The user's address book as last seen, kept under their own mailbox key. */
export async function loadContacts(key: string): Promise<ContactsCache | undefined> {
  const s = idb();
  if (!s) return undefined;
  try {
    return parseContactsCache(await get<unknown>(`contacts:${key}`, s));
  } catch {
    return undefined;
  }
}

export async function saveContacts(key: string, cache: ContactsCache): Promise<void> {
  const s = idb();
  if (!s) return;
  try {
    await set(`contacts:${key}`, cache, s);
  } catch {
    // Ignore: best effort.
  }
}
```

and `await del(`contacts:${key}`, s);` in `clearSnapshots`. Add a `persist.test.ts` case that `clearSnapshots('k')` removes `contacts:k`, in the style of the existing directory case.

- [ ] **Step 4: Wire it** in `src/index.tsx`: build `const contacts = createContacts(client, toasts.toast);` beside `directory`; add to `app`: `contacts,` and `hasContacts: () => contacts.available() && cur().info.personal,`; in `start()` after `directory.start(...)`: `void contacts.start(key(accounts[0]!)).catch((e) => onAuthError(e));`; in the push handlers `contacts.onStateChange(c);` and `contacts.onConnected();` beside the calendar's. Add both fields to `App` in `context.tsx` with doc comments (`/** The user's own address book, whichever mailbox is on screen. */`).
- [ ] **Step 5: Run** `pnpm vitest run src/app src/cache && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `Contacts: the address book is loaded whole, kept current by push, and stored for the next start`.

---

### Task 5: Saved contacts in recipient suggestions

**Files:**
- Modify: `src/mail/recipients.ts`, `src/app/recipients.ts`, `src/ui/RecipientField.tsx`, `src/index.tsx`, `src/ui/styles.css`
- Create: `src/contacts/saved.ts`
- Test: `src/mail/recipients.test.ts`, `src/app/recipients.test.ts`, `src/contacts/saved.test.ts`

**Interfaces:**
- Consumes: `Contacts.people()`, `emailsOf`, `displayName`, `organizationOf`.
- Produces: in `src/contacts/saved.ts`: `export interface SavedEntry { email: string; name: string; preferred: boolean; words: string[]; contactId: Id }` and `savedEntries(people: ContactCard[]): SavedEntry[]` (one per email of each person, `name` = `displayName` unless that is the address itself or "No name", then `''`; `words` = organisation name, department and nicknames; an address on two cards appears once, the first in list order). `Recipient` gains `saved?: boolean` and `contactId?: Id`. `suggest()`'s opts gain `saved?: SavedEntry[]`. `createRecipients` opts gain `contacts?: { people: () => ContactCard[] }`.

Ranking (`tier`): `sent > 0` → 0; `saved` → 1; `group !== undefined` → 2; else 3. Within tier 1: by `sortName`, and for equal names the preferred address first, then by email. A saved row is built as `{ ...(history ?? zero), name: entry.name || directoryName || history name, saved: true, contactId, group: directory group if listed }` and is offered even if `isRobot(email)`. Its match tokens are the usual ones plus `entry.words` split on `/[^\p{L}\p{N}]+/u`, lower-cased.

- [ ] **Step 1: Write the failing tests** (added to `src/mail/recipients.test.ts`):

```ts
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
```

`src/contacts/saved.test.ts`: one person with two emails gives two entries with the preferred flag; an address on two cards appears once under the first card in list order; a card named only by its email has `name: ''`; words hold organisation, department and nicknames. `src/app/recipients.test.ts`: with `contacts: { people: () => [card] }`, `suggest('zo', new Set())` returns the saved row, and it updates when the accessor's value changes (use a signal).

- [ ] **Step 2: Run** `pnpm vitest run src/mail/recipients.test.ts src/contacts/saved.test.ts src/app/recipients.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `suggest`, handle `opts.saved` first: for each entry not excluded, build the row as above (looking the address up in a `Map` of the directory by lower-cased email and in `index`), match on its tokens plus words, push, and add its key to `listed` so the directory and history loops skip it. Replace `tier` and `compareSuggestions`:

```ts
/** A suggestion's rank: people written to, then saved contacts, then the organisation, then everyone else. */
const tier = (r: Recipient) => (r.sent > 0 ? 0 : r.saved ? 1 : r.group !== undefined ? 2 : 3);

function compareSuggestions(a: Recipient, b: Recipient): number {
  const rank = tier(a) - tier(b);
  if (rank) return rank;
  if (tier(a) === 1 || tier(a) === 2) {
    const byName = sortName(a) < sortName(b) ? -1 : sortName(a) > sortName(b) ? 1 : 0;
    return byName || Number(!!b.preferred) - Number(!!a.preferred) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
  }
  return compareRecipients(a, b);
}
```

(`Recipient` also gains `preferred?: boolean`, "Set on a saved contact's preferred address. Never stored." Check `snapshot()` in `src/app/recipients.ts` stores only index entries, which never carry these fields.) In `createRecipients.suggest`, pass `saved: opts.contacts ? savedEntries(opts.contacts.people()) : []`, memoised with `createMemo` inside the factory. In `index.tsx` build `contacts` before `createSpaces` and pass `createRecipients(engine, { directory, contacts })`. In `RecipientField`'s `optionSlot` add after the Group mark:

```tsx
                <Show when={r().saved}>
                  <span class="rcpt-group">Contact</span>
                </Show>
```

- [ ] **Step 4: Run** `pnpm vitest run src/mail src/app src/contacts && pnpm typecheck`. Expected: PASS, including the existing recipient tests unchanged.
- [ ] **Step 5: Commit** `Recipients: saved contacts are suggested, under the names they were saved with`.

---

### Task 6: The Contacts page

**Files:**
- Create: `src/ui/ContactsView.tsx`, `src/ui/ContactCard.tsx`, `src/ui/Avatar.tsx`
- Test: `src/ui/ContactsView.test.tsx`, `src/ui/ContactCard.test.tsx`
- Modify: `src/index.tsx` (routes), `src/ui/Shell.tsx` (nav link, New contact), `src/ui/keyboard.ts` (`g then p`), `src/ui/icons.tsx` (`contacts` icon), `src/ui/styles.css`

**Interfaces:**
- Consumes: `useApp().contacts`, `hasContacts`, `matchPeople`, the `*Of` readers, `createVirtualList`, `createMediaQuery`.
- Produces: `ContactsView` (route component for `/contacts` and `/contacts/:id`), `ContactCardView(props: { card: ContactCard })`, `Avatar(props: { name: string; seed: string; photo?: string | null; size?: number })`. Element hooks the e2e and later tasks rely on: `.contacts-view`, `.contacts-list`, `table.contacts-table`, `tr[data-contact-id]`, `.contact-card`, search input labelled `Search contacts`, buttons `New contact`, `Edit`, `Delete`, link `Back to contacts`.

Behaviour:
- Routes, before `/:slug`: `/contacts` and `/contacts/:id`, each `<PaneBoundary name="contacts">{app.hasContacts() ? <ContactsView /> : <Navigate href="/inbox" />}</PaneBoundary>`.
- Sidebar: after the Calendar block, `<Show when={hasContacts()}><A href="/contacts" class="nav-item" classList={{ active: props.current === '/contacts' || props.current.startsWith('/contacts/') }}><Icon name="contacts" /><span class="name">Contacts</span></A></Show>`. While the path is under `/contacts`, the sidebar's Compose button reads `New contact` and calls `contacts.openDialog({ kind: 'new' })`.
- Keyboard: `g` then `p` ("people"; `c` is Compose and would be read as that) goes to `/contacts` when `hasContacts()`; `SHORTCUTS` gains `['g then p', 'Go to Contacts']`.
- Layout: `.contacts-view` is a two-pane flex. Left `.contacts-list` (360px; full width at 800px and under): a header row with the search box and the count (`"212 contacts"`, `"1 contact"`, with a query `"3 of 212"`), then the scrolling table. Right `.contact-pane`: the card, or `Select a contact`. At 800px and under exactly one pane shows: the card when the route has an id (with a `Back to contacts` link, `<A href="/contacts">`), else the list.
- Table: `<table class="contacts-table" aria-label="Contacts">`, `<thead>` Name, Email, Phone, Organisation (the last two hidden at 800px and under and when the card pane is open beside a narrow list: use a container query on `.contacts-list`, hiding them under 520px). Body rows are virtual: `createVirtualList({ count, scrollElement, rowHeight: () => 48 })`, a leading spacer `<tr aria-hidden="true" style={{ height: `${first.start}px` }}>` and a trailing one, and `aria-rowcount` on the table with `aria-rowindex` on each row. The Name cell holds `<A href={`/contacts/${id}`}>` with the avatar and display name; the row has `aria-current="true"` when open. ArrowDown/ArrowUp on a focused name link move focus to the next/previous rendered row's link (scrolling it into view first through the virtualizer); Enter is the link's own.
- Empty states (text exactly): not loaded and not failed → `Loading contacts…` (`role="status"`); failed → `Couldn't load your contacts.` with a `Retry` button calling `contacts.reload()`; no people → `No contacts yet.` with a `New contact` button; a query with no match → `No contacts match “<query>”.`
- Card (`ContactCardView`): avatar (64px), `<h1>` display name, a line with title and organisation ("Head of Research, Acme Ltd · Research" built from what exists), `Edit` and `Delete` buttons. Then sections, each only when it has content, as a `<dl>`: Email (each `<a href="mailto:…">` whose click is prevented and opens `composers.open('new')` addressed to it: check `composers.open`'s signature and use its existing way to seed recipients; if it has none, add an optional `to: EmailAddress[]` seed to the `'new'` mode in `src/app/composer.ts` with a unit test), with the label and `Preferred` mark; Phone (`<a href="tel:…">` with digits and `+` only in the href); Address (`white-space: pre-line`); Birthday (`14 March` or `14 March 1990`, via `Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year? })` on a UTC date); Notes (`pre-line`); then each of `extrasOf`.
- A route id with no such card: while not loaded, `Loading contacts…`; once loaded, `navigate('/contacts', { replace: true })` and, if the card had been on screen before (it existed in a previous render), toast `That contact was deleted.`
- `Delete` calls `contacts.remove(id)` and navigates to `/contacts` on success.
- `Avatar`: the photo as `<img alt="">` when given, else the first letter of the name on `avatarColor(seed)` (move `avatarColor` out of `Conversation.tsx` into `Avatar.tsx` and import it back; no behaviour change there).

- [ ] **Step 1: Write the failing component tests.** `ContactsView.test.tsx` renders inside `AppContext.Provider` with a real `createContacts` over `FakeJmap` and a `MemoryRouter` (follow `AccountSwitcher.test.tsx` for the provider and router set-up; jsdom has no layout, so stub the virtual list as the thread list's tests do, or mock `./virtual` to return every row). Cases:
  - lists people sorted, shows `3 contacts`, leaves a group card out;
  - typing `acm` in `Search contacts` leaves the Acme person and shows `1 of 3`; a query with no match shows `No contacts match “zzz”.`;
  - `No contacts yet.` with an empty book; `Couldn't load your contacts.` and a working `Retry` after a failed load;
  - at `/contacts/<id>` the card shows the name as a heading, the email link, the phone link with `href="tel:+15550199"`, the birthday `14 March`, and the extras;
  - a card deleted from the store while open returns to `/contacts`.
  `ContactCard.test.tsx`: a card with only an email shows no Phone, Address, Birthday or Notes section; the organisation line for name only, title only, and all three.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the components, routes, nav link, shortcut, icon (Material "contacts" path, 24px viewBox, added to `paths`) and styles. Styles follow the existing variables (`--surface`, `--chip`, `--accent`, `--radius`); touch targets at least 44px under `@media (pointer: coarse)`; nothing wider than the screen at 390px.
- [ ] **Step 4: Run** `pnpm vitest run src/ui && pnpm typecheck && pnpm build`. Expected: PASS. Then with the dev stack up (`docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local-dist.yml up -d`), open `http://localhost:8080/contacts` as alice and check by eye, desktop and a 390px window: empty state, a card made with the JMAP helper appearing live.
- [ ] **Step 5: Commit** `Contacts: a page with the list, search and the card`.

---

### Task 7: The contact dialog and photos

**Files:**
- Create: `src/ui/ContactDialog.tsx`, `src/contacts/photo.ts`
- Test: `src/ui/ContactDialog.test.tsx`, `src/contacts/photo.test.ts`
- Modify: `src/ui/Shell.tsx` (host `<ContactDialog />` beside `<LabelDialog />`), `src/ui/ContactCard.tsx` (`Edit` opens it), `src/ui/styles.css`

**Interfaces:**
- Consumes: `contacts.dialog()`, `openDialog`, `closeDialog`, `create`, `update`, `toForm`, `validateForm`, `cardBytes`, `MAX_CARD_BYTES`, the confirm dialog (through `useApp()`: add `confirm: ConfirmFn` to `App` if it is not there, passing `confirmDialog.confirm`).
- Produces: `ContactDialog()` (renders nothing while `contacts.dialog()` is null); `photoDataUri(file: Blob, opts?: { size?: number; quality?: number }): Promise<string>`; `fitSquare(width: number, height: number, size: number): { sx: number; sy: number; side: number }` (the centred square crop). Form labels the e2e relies on: `Given name`, `Surname`, `Email 1` / `Email 2`…, `Email 1 type`, `Phone 1`, `Phone 1 type`, `Organisation`, `Department`, `Job title`, `Address 1`, `Address 1 type`, `Birthday day`, `Birthday month`, `Birthday year`, `Notes`; buttons `Add email`, `Add phone`, `Add address`, `Remove email 1`…, `Choose photo`, `Remove photo`, `Cancel`, `Save`; radio `Preferred` per email row (group label `Preferred email`), shown when there are two or more emails.

Behaviour:
- `<Dialog open onOpenChange={(o) => !o && requestClose()} ariaLabelledby="contact-dialog-title">`, title `New contact` or `Edit contact`. The body scrolls; the actions stay in view. At 800px and under the dialog fills the screen (CSS on a `contact-dialog` class).
- A new contact starts with one empty email row and one empty phone row; edit starts from `toForm(card)` (plus one empty row of each kind the card has none of).
- `Save`: `validateForm`; errors appear under their fields (`role="alert"`, `aria-invalid`, `aria-describedby`) and focus moves to the first; then, for a photo change, if `cardBytes` of the would-be card exceeds `MAX_CARD_BYTES` the error is `This contact is too large to save. Try a smaller photo or shorter notes.`; then `create` or `update`. While saving the button reads `Saving…` and the controls are disabled. `{ok: false}` shows the error at the foot (`role="alert"`) and keeps the dialog open. On success: close; a new contact navigates to `/contacts/<id>` when the page on screen is under `/contacts`, else toasts `Saved to contacts.`
- `requestClose()` (Cancel, Escape, backdrop): with no change since opening (compare `JSON.stringify` of the form), close; else `confirm({ title: 'Discard changes?', message: 'What you changed in this contact will be lost.', confirmLabel: 'Discard' })`.
- Edit of a card that leaves the store while open: the foot shows `This contact was deleted elsewhere.` and Save is disabled.
- Type pickers are native `<select>`s (rozie has no Select; already noted in `docs/rozie-feedback.md`). Email: Work, Personal, Other. Phone: Mobile, Work, Home, Other. Address: Work, Home, Other. Month: a `<select>` of month names with an empty first option; day and year are `inputmode="numeric"` text inputs.
- Photo: `Choose photo` opens a hidden `<input type="file" accept="image/*">`; the picked file goes through `photoDataUri` and previews in the avatar; a failure to decode shows `That file is not a picture this browser can read.`
- `photoDataUri`: `createImageBitmap(file)`, a canvas of `size` (256) square, draw the `fitSquare` crop, `canvas.toDataURL('image/jpeg', 0.85)`. Unit-test `fitSquare` (landscape, portrait, already square, smaller than the target is still drawn to `size`); `photoDataUri` itself is covered in the browser test of Task 10.

- [ ] **Step 1: Write the failing tests** `ContactDialog.test.tsx` (provider as in Task 6; `user` from `@testing-library/user-event` if the repo uses it, else `fireEvent` as the other dialog tests do):
  - new: filling `Given name`, `Surname`, `Email 1`, choosing `Work`, Save → the fake holds one card with those values and a `uid`; the dialog is gone;
  - Save on an empty form shows `Give a name, an organisation or an email address.` and sends no `ContactCard/set`;
  - a bad second email shows `This is not an email address.` under `Email 2`, focused;
  - edit: opens filled from the card; changing only `Phone 1` sends a set whose update has exactly `phones` and `updated`;
  - `Add email` then `Preferred` on the second → stored `pref: 1` on it;
  - a server refusal (`fake.onCall` throwing for `ContactCard/set`) shows the message and keeps the dialog open with the typed values;
  - Cancel with changes asks `Discard changes?`; without changes it just closes;
  - a seeded new dialog (`{kind: 'new', seed: {name: 'Nora New', email: 'nora@new.example'}}`) starts with those in `Given name`, `Surname`, `Email 1`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run src/ui src/contacts && pnpm typecheck`. Expected: PASS. By eye on the dev stack: create, edit, photo, discard prompt, at desktop and 390px.
- [ ] **Step 5: Commit** `Contacts: one dialog to add and edit a person, with a photo`.

---

### Task 8: The person popover, in messages and on recipient chips

**Files:**
- Create: `src/ui/PersonPopover.tsx`
- Test: `src/ui/PersonPopover.test.tsx`
- Modify: `src/ui/Conversation.tsx` (sender and recipient names), `src/ui/RecipientField.tsx` (chip label), `src/ui/styles.css`

**Interfaces:**
- Consumes: `contacts.byEmail`, `contacts.openDialog`, `hasContacts` is **not** used for the popover (it works in a shared mailbox): use `contacts.available()`; `app.spaces.current().info.personal`; the directory (expose `directory: Directory` on `App` and read `entries()`); `composers.open` with a `to` seed (Task 6).
- Produces: `PersonButton(props: { address: EmailAddress; label: string; class?: string; inMessage?: boolean })`: a `<button type="button" class="person">` showing `label`, with `aria-haspopup="dialog"` and `aria-expanded`, that opens a rozie Popover (`trigger="manual"`, `placement="bottom-start"`, `strategy="fixed"`, as `LabelMenu` does) anchored to itself. Without contacts on the server it renders plain text in a `<span>`.

Popover content (`role="dialog"`, `aria-label` = the name or address):
- avatar, the name (saved name, else directory name, else the address's own name, else the address), the address;
- saved: organisation line and the first phone; not saved but in the directory: `In your organisation`;
- actions: not saved → `Add to contacts` (`openDialog({ kind: 'new', seed: { name: saved/display name unless it equals the address, email } })`); saved → `Edit contact` (`openDialog({ kind: 'edit', id })`) and, when the mailbox on screen is the user's own, `Open in Contacts` (`<A href={`/contacts/${id}`}>`); with `inMessage` → `New message` (`composers.open('new', …to this address)`). Every action closes the popover. Escape closes it and returns focus to the button; Tab out closes it.

In `Conversation.tsx`:
- The expanded header keeps the sender's name as the toggle button (unchanged: it is the accessible control for expanding). After it, when expanded, the `<span class="addr">` becomes `<PersonButton address={from()!} label={`<${from()!.email}>`} class="addr" inMessage />`.
- `recipients(email, me)` becomes a component `Recipients` rendering `to ` followed by a `PersonButton` per address (label as today: `me` or `displayName(a, many)`), comma-separated. Clicks inside must not toggle the message: `onClick={(e) => e.stopPropagation()}` on the wrapper.

In `RecipientField.tsx`'s `chipSlot`: the label span becomes `<PersonButton address={a()} label={formatAddress(a())} class="rcpt-chip-label" />`. `onMouseDown={(e) => e.preventDefault()}` on it keeps the input's focus handling as the remove button does. Check by test that Backspace on a chip still removes it and that the Combobox's own keys are unaffected.

- [ ] **Step 1: Write the failing tests** `PersonPopover.test.tsx`: unknown address → `Add to contacts` opens the dialog state with the seed `{name: 'Nora New', email: 'nora@new.example'}`; an address whose display name is the address itself seeds no name; a saved address → shows the saved name and phone, `Edit contact` sets `{kind: 'edit', id}`, and `Open in Contacts` is present in the personal mailbox and absent in a shared one; a directory address not saved shows `In your organisation`; `inMessage` adds `New message`; without the contacts capability the label is plain text with no button. Extend `e2e`-independent unit coverage of `RecipientField` only if a test file for it exists; otherwise the chip is covered in Task 10.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** If the rozie Popover cannot be anchored to a button inside a Combobox chip, or steals the Combobox's focus handling, stop and report (Global Constraints).
- [ ] **Step 4: Run** `pnpm vitest run src/ui && pnpm typecheck`, then the existing browser specs that touch these surfaces: `pnpm e2e -- e2e/compose.spec.ts e2e/conversation.spec.ts e2e/keyboard.spec.ts`. Expected: PASS (they must not have needed changes beyond selectors for the recipient text; if a selector changes, keep its meaning).
- [ ] **Step 5: Commit** `Contacts: a person's popover on names in a message and on recipient chips, to save or open them`.

---

### Task 9: A shared address book is not a shared mailbox

**Files:**
- Modify: `src/app/accounts.ts`, `src/index.tsx`, `src/ui/AccountSwitcher.tsx`
- Test: `src/app/accounts.test.ts`, `src/ui/AccountSwitcher.test.tsx`

**Interfaces:**
- Produces: `startAll(spaces, onFailed)` unchanged in signature; a new export `isNotAMailbox(e: unknown): boolean` (a `MethodError` of type `forbidden`, or one whose description matches `/do not have access to account/i`); `Spaces` gains `hide(id: Id): void` and `list()` returns only the spaces not hidden (`list` becomes reactive: a signal of hidden ids).

Behaviour: in `index.tsx`'s `startAll` callback, before the toast: `if (isNotAMailbox(e)) { all.hide(s.info.id); return; }`. A hidden space is not listed in the switcher, not counted in `totalUnread`, and `show()` ignores it. If the address bar is under its `/shared/<id>` base, go to `/inbox` as `goHomeIfLost` does. Check how `MethodError` exposes its type (read `src/jmap/client.ts` lines 21–30) and what `engine.start()` actually throws for a forbidden account by writing the test first against a `FakeJmap` with a new flag `mailForbidden = true` that answers every `Mailbox/`, `Email/`, `Thread/`, `Identity/` call with `['error', { type: 'forbidden', description: 'You do not have access to account a2' }]`.

- [ ] **Step 1: Write the failing tests:** `accounts.test.ts`: two fakes, the second `mailForbidden`; `startAll` calls `onFailed` with an error for which `isNotAMailbox` is true; after `hide`, `list()` has one space and `totalUnread()` ignores the other; a transport failure and a `serverFail` are not `isNotAMailbox`. `AccountSwitcher.test.tsx`: with the second space hidden the switcher is not shown at all (one account), as for a user with no shared mailbox.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run src/app src/ui && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Shared mailboxes: an account that only shares an address book is not offered as a mailbox`.

---

### Task 10: Browser tests, accessibility, phone, and documents

**Files:**
- Create: `e2e/contacts.spec.ts`, `e2e/support/contacts.ts`
- Modify: `e2e/a11y.spec.ts`, `e2e/phone.spec.ts`, `e2e/README.md`, `CHANGELOG.md`, `README.md`, `docs/operating.md`, `docs/rozie-feedback.md` (only if something was found)

**Interfaces:**
- Consumes: `createAccount`, `deleteAccount` (`e2e/support/accounts.ts`), `signInThroughStalwart`, `BASE`, the SMTP helper in `e2e/support/mail.ts` (read it for the function that delivers a message to an arbitrary recipient; add a `to` parameter if it only delivers to alice).
- Produces (`e2e/support/contacts.ts`): `contactsJmap(user, password, calls)` (Basic auth, `using` core + contacts), `contactsAccountId(user, password)`, `createCard(user, password, card): Promise<string>` (default book looked up), `updateCard`, `listCards`, `destroyAllCards`.

The spec runs as a user of its own (`contacts-<time36>@example.test`, created in `beforeAll`, deleted in `afterAll`; `test.use({ storageState: { cookies: [], origins: [] } })`), signing in through Stalwart in a `beforeEach`. `afterEach` destroys every card of that user. Tests (all projects unless tagged):

1. **create, find, edit, delete with undo:** `/contacts` shows `No contacts yet.`; `New contact` → fill given name, surname, email (Work), phone (Mobile), organisation, notes → Save → the URL is `/contacts/<id>` and the card shows them; over JMAP the card has a `uid`, `kind: individual`, components and `name.full`. Add a second person over JMAP → it appears without a reload. Search `acm` → one row, `1 of 2`. Edit → change the phone → Save → the card shows it and, over JMAP, the email is untouched. Delete → `Contact deleted.` → the list has one row → Undo → two rows again and the JMAP card has the same `uid`.
2. **a change made elsewhere arrives live:** with a card open, `updateCard` over JMAP changes the surname → the heading changes without a reload; `destroy` over JMAP → back at `/contacts` with `That contact was deleted.`
3. **more than one page:** 520 cards created over JMAP in two sets → the count reads `520 contacts` and the last name in order is reachable by scrolling the table (`.contacts-list` scrolled to the bottom shows it).
4. **a phone's card:** a card created over JMAP in the CardDAV shape (surname-first components, no `isOrdered`, `contexts: {internet: true, private: true}`) lists as "Given Surname"; editing its note in the dialog leaves `emails` byte-identical over JMAP.
5. **add from a message's sender:** deliver a message from `Nora New <nora@new.example>` to the spec's user; open it; click `<nora@new.example>` → popover → `Add to contacts` → the dialog has Nora / New / the address → Save → `Saved to contacts.` → reopening the popover offers `Edit contact` and `Open in Contacts`, which lands on her card.
6. **add from a recipient chip, and suggestions:** Compose; type `zed@chip.example,` → the chip; click its label → `Add to contacts` → Save with given name `Zed`. In a new message type `zed` → the first suggestion reads `Zed` with `Contact`. Save a person at `Acme Ltd` over JMAP; type `acm` → that person is offered.
7. **photo:** in the dialog `Choose photo` with a generated 600×400 PNG → Save → the card shows an `<img>`; over JMAP `media` holds one `data:image/jpeg` photo under 60 kB.
8. **validation:** Save on an empty form shows the name message; `not an address` in Email 1 shows the email message; nothing is created over JMAP.
9. **`@phone`:** at 390px the list fills the screen, a tap opens the card with `Back to contacts`, the dialog fills the screen, and `noSidewaysScroll` holds for list, card and dialog (add `.contacts-view, .contacts-list, .contact-pane, .contact-dialog` to its selector list).

`a11y.spec.ts`: this file runs as alice. Add screens `contacts list`, `contact card`, `contact dialog`, `person popover`, each creating one `e2e-` named card in alice's book over JMAP first and destroying it in a `finally` (one card for seconds; alice's compose specs are not running at the same time, workers is 1). The popover screen opens a seeded thread's sender popover.

- [ ] **Step 1: Write `e2e/support/contacts.ts` and `e2e/contacts.spec.ts`.**
- [ ] **Step 2: Run** `pnpm build && pnpm e2e -- e2e/contacts.spec.ts`. Fix what it finds in the app (a real-server difference from the fake is fixed in the fake too, with a test, and noted in the memory file). Expected: PASS.
- [ ] **Step 3: Run the four projects for the new and touched specs:** `pnpm exec playwright test e2e/contacts.spec.ts e2e/a11y.spec.ts e2e/phone.spec.ts e2e/compose.spec.ts e2e/conversation.spec.ts --project=chromium --project=firefox --project=webkit --project=phone`. Expected: PASS.
- [ ] **Step 4: Documents.**
  - `CHANGELOG.md` under "Unreleased", in the file's existing voice: Contacts page (view, search, add, edit, delete with undo, photos), live updates from other devices, add to contacts from a message or a chip, saved contacts in recipient suggestions under their saved names, and the fix that an account sharing only an address book is no longer offered as a mailbox.
  - `README.md`: Contacts in the feature list; in known limits: one address book (the default) for new contacts, no groups or import yet (slice 2), no shared or team address books, search is in the browser.
  - `e2e/README.md`: a row for `contacts.spec.ts` in the table, in the style of the `password.spec.ts` row (a user of the spec's own, and why), and the new a11y and phone screens.
  - `docs/operating.md`: a short "Contacts" section: stored in Stalwart as JMAP Contacts, visible to CardDAV clients; the bundled Caddy does not proxy `/dav`, so a phone syncs against Stalwart's own address; cards are limited to 524,288 bytes by Stalwart.
- [ ] **Step 5: Full verification.** `pnpm typecheck && pnpm test && pnpm build && pnpm e2e:all`. Expected: all pass except the known noise (`inline-images.spec.ts:47` on Firefox and WebKit; `push.spec.ts:47`, `calendar-edit.spec.ts:160`, `imap-sync.spec.ts:40` timing-flaky: rerun those alone once before calling them noise).
- [ ] **Step 6: Commit** `Contacts: browser tests on every engine and the phone, axe checks, and the documents`.
