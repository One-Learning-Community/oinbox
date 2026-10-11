import { batch, createMemo, createSignal, type Accessor } from 'solid-js';
import { createStore, produce, reconcile, unwrap } from 'solid-js/store';
import { loadContacts, saveContacts } from '../cache/persist';
import { emailsOf, newCard, patchFor, type ContactForm } from '../contacts/card';
import { isGroup } from '../contacts/card';
import { membersWith, membersWithout, newGroup, sortGroups } from '../contacts/groups';
import { sortPeople } from '../contacts/search';
import { UnauthorizedError, type JmapClient } from '../jmap/client';
import { CONTACTS, CORE, type AddressBook, type ContactCard, type Id, type StateChange } from '../jmap/types';
import { logUnexpected } from '../sync/connection';
import type { ToastFn } from './actions';
import { createImporter, type ImportOptions, type ImportResult, type VcardBlock } from './contacts-import';

export type ContactDialogState = { kind: 'new'; seed?: { name?: string; email?: string } } | { kind: 'edit'; id: Id };
/** `then`: people to put in the group once it is made. */
export type GroupDialogState = { kind: 'create'; then?: Id[] } | { kind: 'rename'; id: Id };
export type ContactWrite = { ok: true; id: Id } | { ok: false; error: string };

export interface ContactsState {
  cards: Record<Id, ContactCard>;
  books: Record<Id, AddressBook>;
  /** The address book is on screen, from the server or from the copy kept in the browser. */
  loaded: boolean;
  /** The last attempt to load it failed and nothing is on screen. */
  failed: boolean;
  /** The first exchange with the server since the start has ended: what is on screen is as new as can be had. */
  current: boolean;
}

export interface Contacts {
  /** Whether the server has JMAP Contacts. */
  available(): boolean;
  state: ContactsState;
  /** Reactive: people (no groups), in list order. */
  people: Accessor<ContactCard[]>;
  /** Reactive: the saved person with this address (compared without case), the first in list order. */
  byEmail(email: string): ContactCard | undefined;
  /** Show the stored copy, then catch up; with none, load everything. Rejects only when signed out. */
  start(key: string): Promise<void>;
  /** Load everything again. */
  reload(): Promise<void>;
  onStateChange(change: StateChange): void;
  /** After a push (re)connect, changes may have been missed. */
  onConnected(): void;
  create(form: ContactForm): Promise<ContactWrite>;
  /**
   * Save the form. `base` is the card as the form was started from: only what the user changed since
   * then is sent, so what another device changed meanwhile is left as that device left it.
   */
  update(id: Id, form: ContactForm, base?: ContactCard): Promise<ContactWrite>;
  /** Delete, with Undo in the toast. */
  remove(id: Id): Promise<ContactWrite>;
  /** Reactive: the groups, by name. */
  groups: Accessor<ContactCard[]>;
  createGroup(name: string): Promise<ContactWrite>;
  renameGroup(id: Id, name: string): Promise<ContactWrite>;
  /** Deletes the group card only: its people stay. Asks nothing: the caller confirms. */
  removeGroup(id: Id): Promise<ContactWrite>;
  /** Add people to a group. A person's card with no uid is first replaced by a copy that has one. */
  addToGroup(groupId: Id, cardIds: Id[]): Promise<ContactWrite>;
  removeFromGroup(groupId: Id, cardIds: Id[]): Promise<ContactWrite>;
  /** Delete several people in one go. No undo: the caller confirms first. */
  removeMany(ids: Id[]): Promise<{ removed: number; error?: string }>;
  /** Reactive: the card that took this one's place when it was given a uid, if any. */
  movedTo(id: Id): Id | undefined;
  /**
   * Import cards cut from vCard files: the server reads each one, and what it makes of them is saved.
   * Never rejects for a bad card; stops when asked, when the connection is lost, or when the server's
   * upload allowance runs out, and says which.
   */
  importVcards(blocks: VcardBlock[], opts?: ImportOptions): Promise<ImportResult>;
  importOpen: Accessor<boolean>;
  openImport(): void;
  closeImport(): void;
  groupDialog: Accessor<GroupDialogState | null>;
  openGroupDialog(state: GroupDialogState): void;
  closeGroupDialog(): void;
  /** The contact dialog, wherever it was asked for. */
  dialog: Accessor<ContactDialogState | null>;
  openDialog(state: ContactDialogState): void;
  closeDialog(): void;
  /** The person has been signed out: nothing more is fetched or written to the browser. */
  stop(): void;
}

/** Stalwart's limit for one get, and the page a load is read in. */
const PAGE = 500;
const SAVE_MS = 2000;
const USING = [CORE, CONTACTS];
const UNAVAILABLE = 'Contacts are not available.';
const NO_GROUP = 'This group no longer exists.';

/**
 * The user's address book, held whole: the server can neither sort it by name nor search it
 * reliably, so the list and the recipient suggestions work from this copy. It is kept current by
 * /changes on every push, and stored for the next start.
 */
export function createContacts(
  client: JmapClient,
  toast: ToastFn,
  opts: { now?: () => string; uid?: () => string; saveDelayMs?: number } = {},
): Contacts {
  const now = opts.now ?? (() => new Date().toISOString());
  const uid = opts.uid ?? (() => `urn:uuid:${crypto.randomUUID()}`);
  const saveDelayMs = opts.saveDelayMs ?? SAVE_MS;
  const [state, setState] = createStore<ContactsState>({ cards: {}, books: {}, loaded: false, failed: false, current: false });
  const [dialog, setDialog] = createSignal<ContactDialogState | null>(null);
  const [groupDialog, setGroupDialog] = createSignal<GroupDialogState | null>(null);
  const [moved, setMoved] = createSignal<ReadonlyMap<Id, Id>>(new Map());
  const [importOpen, setImportOpen] = createSignal(false);
  let key: string | null = null;
  let cardState = '';
  let bookState = '';
  /** A load from scratch is wanted, whatever is on screen. */
  let full = false;
  let failing = false;
  let running: Promise<void> | null = null;
  let again = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const accountId = (): Id | undefined => (client.hasSession ? client.session.primaryAccounts[CONTACTS] : undefined);

  const saveSoon = () => {
    if (saveTimer || !key || stopped) return;
    const under = key;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (stopped) return;
      void saveContacts(under, { cards: Object.values(unwrap(state.cards)), books: Object.values(unwrap(state.books)), cardState, bookState });
    }, saveDelayMs);
  };

  const put = (cards: ContactCard[], gone: Id[] = []) => {
    setState(
      'cards',
      produce((all) => {
        for (const id of gone) delete all[id];
        // Assigned whole: merging would keep properties the card has lost.
        for (const card of cards) all[card.id] = card;
      }),
    );
    saveSoon();
  };

  const fetchCards = async (accountId: Id, ids: Id[]): Promise<{ list: ContactCard[]; notFound: Id[] }> => {
    const list: ContactCard[] = [];
    const notFound: Id[] = [];
    for (let i = 0; i < ids.length; i += PAGE) {
      const b = client.batch();
      const get = b.call('ContactCard/get', { accountId, ids: ids.slice(i, i + PAGE) });
      const res = (await client.send(b, USING)).get(get);
      list.push(...res.list);
      notFound.push(...res.notFound);
    }
    return { list, notFound };
  };

  /** What changed since the states held. `settled`: right after a full load, when there is nothing older to fall back from. */
  const changes = async (accountId: Id, settled = false): Promise<void> => {
    for (;;) {
      const b = client.batch();
      const cc = b.call('ContactCard/changes', { accountId, sinceState: cardState });
      const bc = b.call('AddressBook/changes', { accountId, sinceState: bookState });
      const res = await client.send(b, USING);
      // The server cannot say what changed (or will not take the state we kept): what we hold is
      // no use as a starting point, so everything is read again.
      if (res.error(cc) ?? res.error(bc)) {
        if (settled) return;
        await loadAll(accountId);
        return;
      }
      const cards = res.get(cc);
      const books = res.get(bc);
      const fetched = await fetchCards(accountId, [...cards.created, ...cards.updated]);
      let bookList: AddressBook[] | null = null;
      if (books.created.length || books.updated.length || books.destroyed.length) {
        const b2 = client.batch();
        const get = b2.call('AddressBook/get', { accountId });
        bookList = (await client.send(b2, USING)).get(get).list;
      }
      batch(() => {
        put(fetched.list, [...cards.destroyed, ...fetched.notFound]);
        if (bookList) setState('books', reconcile(Object.fromEntries(bookList.map((x) => [x.id, x]))));
      });
      cardState = cards.newState;
      bookState = books.newState;
      if (!cards.hasMoreChanges && !books.hasMoreChanges) return;
    }
  };

  /** Every card, in pages: a get without ids stops at 500 without saying so. */
  const loadAll = async (accountId: Id): Promise<void> => {
    const cards: Record<Id, ContactCard> = {};
    let books: AddressBook[] = [];
    let firstCardState = '';
    let firstBookState = '';
    let pages = 0;
    for (let position = 0; ; ) {
      const b = client.batch();
      const ab = position === 0 ? b.call('AddressBook/get', { accountId }) : null;
      const query = b.call('ContactCard/query', { accountId, position, limit: PAGE, calculateTotal: true });
      const get = b.call('ContactCard/get', { accountId, '#ids': query.ref('/ids') });
      const res = await client.send(b, USING);
      const page = res.get(query); // surfaces a failed query instead of a dangling back-reference
      const got = res.get(get);
      for (const card of got.list) cards[card.id] = card;
      if (ab) {
        const bookRes = res.get(ab);
        books = bookRes.list;
        firstBookState = bookRes.state;
        firstCardState = got.state;
      }
      pages++;
      // A server may give shorter pages than asked for: the end is its count, or a page with nothing on it.
      position += page.ids.length;
      if (!page.ids.length || (typeof page.total === 'number' ? position >= page.total : page.ids.length < PAGE)) break;
    }
    batch(() => {
      // Every card a new object, not merged into the old one: the search index is kept per object.
      setState(
        'cards',
        produce((all) => {
          for (const id of Object.keys(all)) if (!(id in cards)) delete all[id];
          for (const card of Object.values(cards)) all[card.id] = card;
        }),
      );
      setState('books', reconcile(Object.fromEntries(books.map((x) => [x.id, x]))));
      setState({ loaded: true, failed: false });
    });
    cardState = firstCardState;
    bookState = firstBookState;
    full = false;
    saveSoon();
    // Later pages were read after the state was noted: whatever changed meanwhile is asked for.
    if (pages > 1) await changes(accountId, true);
  };

  /** One run at a time; a request during a run is honoured by one more run after it. */
  const sync = (): Promise<void> => {
    const accountId0 = accountId();
    if (!accountId0 || stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const fromScratch = full || !state.loaded;
        try {
          if (fromScratch) await loadAll(accountId0);
          else await changes(accountId0);
          failing = false;
        } catch (e) {
          if (e instanceof UnauthorizedError) throw e;
          if (!fromScratch) throw e;
          if (!state.loaded) setState('failed', true);
          if (!failing) {
            failing = true;
            toast(`Couldn't load your contacts: ${(e as Error).message}`, 'error');
          }
        }
      } while (again);
    })().finally(() => (running = null));
    return running;
  };

  const people = createMemo(() => sortPeople(Object.values(state.cards)));
  const groups = createMemo(() => sortGroups(Object.values(state.cards)));
  const byAddress = createMemo(() => {
    const map = new Map<string, ContactCard>();
    for (const card of people()) {
      for (const e of emailsOf(card)) {
        const k = e.address.trim().toLowerCase();
        if (k && !map.has(k)) map.set(k, card);
      }
    }
    return map;
  });

  /** A set's new state is ours if nothing else happened in between; otherwise ask what did. */
  const advance = (oldState: string | null, newState: string) => {
    if (oldState === cardState) cardState = newState;
    else void sync().catch(logUnexpected);
  };

  const refused = (e: { type: string; description?: string } | undefined, what: string): string =>
    e?.description ?? `The server refused the ${what} (${e?.type ?? 'unknown'}).`;

  /** Create one card and show it as the server stored it. */
  const createCard = async (accountId: Id, card: Partial<ContactCard>): Promise<ContactWrite> => {
    const b = client.batch();
    const set = b.call('ContactCard/set', { accountId, create: { new: card } });
    const res = (await client.send(b, USING)).get(set);
    const id = res.created?.new?.id;
    if (!id) return { ok: false, error: refused(res.notCreated?.new, 'contact') };
    // A created id cannot be read back in the same request (Stalwart refuses the back-reference).
    put((await fetchCards(accountId, [id])).list);
    advance(res.oldState, res.newState);
    return { ok: true, id };
  };

  const guarded = async (work: (accountId: Id) => Promise<ContactWrite>): Promise<ContactWrite> => {
    const accountId0 = accountId();
    if (!accountId0) return { ok: false, error: UNAVAILABLE };
    try {
      return await work(accountId0);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      return { ok: false, error: (e as Error).message };
    }
  };

  /** Send one card's patch and show the card as the server then has it. `gone`: what to say when it no longer exists. */
  const patchCard = async (accountId: Id, id: Id, patch: Record<string, unknown>, gone: string): Promise<ContactWrite> => {
    const b = client.batch();
    const set = b.call('ContactCard/set', { accountId, update: { [id]: patch } });
    const res = (await client.send(b, USING)).get(set);
    const err = res.notUpdated?.[id];
    if (err?.type === 'notFound') {
      put([], [id]);
      return { ok: false, error: gone };
    }
    if (err) return { ok: false, error: refused(err, 'change') };
    // Read back: the card may also hold what another device changed a moment ago.
    const fetched = await fetchCards(accountId, [id]);
    put(fetched.list, fetched.notFound);
    advance(res.oldState, res.newState);
    return { ok: true, id };
  };

  const defaultBook = (): AddressBook | undefined => {
    const books = Object.values(state.books);
    return books.find((x) => x.isDefault) ?? books[0];
  };
  const groupCard = (id: Id): ContactCard | undefined => {
    const card = state.cards[id];
    return card && isGroup(card) ? unwrap(card) : undefined;
  };

  /**
   * Stalwart lets a uid be set only when a card is made, and a group names its members by uid: a card
   * without one is made again with one, and only then is the old card removed.
   */
  const withUid = async (accountId: Id, card: ContactCard): Promise<{ ok: true; uid: string } | { ok: false; error: string }> => {
    if (card.uid) return { ok: true, uid: card.uid };
    const { id, ...rest } = structuredClone(card);
    const copy = { ...rest, uid: uid(), updated: now() };
    const made = await createCard(accountId, copy);
    if (!made.ok) return made;
    const b = client.batch();
    const set = b.call('ContactCard/set', { accountId, destroy: [id] });
    const res = (await client.send(b, USING)).get(set);
    const err = res.notDestroyed?.[id];
    // Left behind, the old card is a duplicate the person can see and delete; the group has the new one.
    if (!err || err.type === 'notFound') {
      batch(() => {
        setMoved(new Map(moved()).set(id, made.id));
        put([], [id]);
      });
    }
    advance(res.oldState, res.newState);
    return { ok: true, uid: copy.uid };
  };

  /** A second click while the first is on its way is the same deletion, not another. */
  const removing = new Map<Id, Promise<ContactWrite>>();
  const once = (id: Id, work: () => Promise<ContactWrite>): Promise<ContactWrite> => {
    let going = removing.get(id);
    if (!going) {
      going = work().finally(() => removing.delete(id));
      removing.set(id, going);
    }
    return going;
  };

  return {
    available: () => !!accountId(),
    state,
    people,
    byEmail: (email) => byAddress().get(email.trim().toLowerCase()),
    start: async (storageKey) => {
      if (!accountId()) return;
      key = storageKey;
      const cache = await loadContacts(storageKey);
      if (cache && !state.loaded) {
        cardState = cache.cardState;
        bookState = cache.bookState;
        batch(() => {
          setState('cards', reconcile(Object.fromEntries(cache.cards.map((c) => [c.id, c]))));
          setState('books', reconcile(Object.fromEntries(cache.books.map((x) => [x.id, x]))));
          setState('loaded', true);
        });
      }
      try {
        await sync();
      } finally {
        setState('current', true);
      }
    },
    reload: () => {
      full = true;
      // Asked for by hand: a second failure is said too.
      failing = false;
      return sync();
    },
    onStateChange: (change) => {
      const accountId0 = accountId();
      const types = accountId0 && key ? change.changed[accountId0] : undefined;
      if (!types) return;
      if ((types.ContactCard && types.ContactCard !== cardState) || (types.AddressBook && types.AddressBook !== bookState)) void sync().catch(logUnexpected);
    },
    onConnected: () => {
      if (key) void sync().catch(logUnexpected);
    },
    create: (form) =>
      guarded(async (accountId0) => {
        const book = defaultBook();
        if (!book) return { ok: false, error: 'Your contacts have not loaded yet.' };
        return createCard(accountId0, newCard(form, book.id, now(), uid()));
      }),
    update: (id, form, base) =>
      guarded(async (accountId0) => {
        const card = state.cards[id];
        if (!card) return { ok: false, error: 'This contact no longer exists.' };
        const patch = patchFor(base ?? unwrap(card), form, now());
        if (!Object.keys(patch).length) return { ok: true, id };
        return patchCard(accountId0, id, patch, 'This contact no longer exists.');
      }),
    remove: (id) => once(id, async () => {
      const stored = state.cards[id];
      const copy = stored ? structuredClone(unwrap(stored)) : null;
      const result = await guarded(async (accountId0) => {
        const b = client.batch();
        const set = b.call('ContactCard/set', { accountId: accountId0, destroy: [id] });
        const res = (await client.send(b, USING)).get(set);
        const err = res.notDestroyed?.[id];
        // Already gone is what was asked for.
        if (err && err.type !== 'notFound') return { ok: false, error: refused(err, 'deletion') };
        put([], [id]);
        advance(res.oldState, res.newState);
        return { ok: true, id };
      });
      if (!result.ok) {
        toast(`Couldn't delete the contact: ${result.error}`, 'error');
        return result;
      }
      const undo = () => {
        if (!copy) return;
        const { id: _id, ...card } = copy;
        // Under its uid again, so the groups that name it still do. The id is new.
        void guarded((accountId0) => createCard(accountId0, card)).then((r) => {
          if (!r.ok) toast(`Couldn't restore the contact: ${r.error}`, 'error');
        }, logUnexpected);
      };
      toast('Contact deleted.', 'info', copy ? { label: 'Undo', run: undo } : undefined);
      return result;
    }),
    groups,
    createGroup: (name) =>
      guarded(async (accountId0) => {
        const book = defaultBook();
        if (!book) return { ok: false, error: 'Your contacts have not loaded yet.' };
        return createCard(accountId0, newGroup(name, book.id, now(), uid()));
      }),
    renameGroup: (id, name) =>
      guarded(async (accountId0) => {
        const group = groupCard(id);
        if (!group) return { ok: false, error: NO_GROUP };
        return patchCard(accountId0, id, { name: { ...group.name, full: name.trim() }, updated: now() }, NO_GROUP);
      }),
    removeGroup: (id) =>
      guarded(async (accountId0) => {
        const b = client.batch();
        const set = b.call('ContactCard/set', { accountId: accountId0, destroy: [id] });
        const res = (await client.send(b, USING)).get(set);
        const err = res.notDestroyed?.[id];
        if (err && err.type !== 'notFound') return { ok: false, error: refused(err, 'deletion') };
        put([], [id]);
        advance(res.oldState, res.newState);
        return { ok: true, id };
      }),
    addToGroup: (groupId, cardIds) =>
      guarded(async (accountId0) => {
        if (!groupCard(groupId)) return { ok: false, error: NO_GROUP };
        const uids: string[] = [];
        for (const id of cardIds) {
          const card = state.cards[id];
          if (!card || isGroup(card)) continue;
          const r = await withUid(accountId0, unwrap(card));
          if (!r.ok) return r;
          uids.push(r.uid);
        }
        // Read again: making the copies took requests, and the group may have changed meanwhile.
        const group = groupCard(groupId);
        if (!group) return { ok: false, error: NO_GROUP };
        if (uids.every((u) => group.members?.[u] === true)) return { ok: true, id: groupId };
        return patchCard(accountId0, groupId, { members: membersWith(group, uids), updated: now() }, NO_GROUP);
      }),
    removeFromGroup: (groupId, cardIds) =>
      guarded(async (accountId0) => {
        const group = groupCard(groupId);
        if (!group) return { ok: false, error: NO_GROUP };
        const uids = cardIds.map((id) => state.cards[id]?.uid).filter((u): u is string => !!u && group.members?.[u] === true);
        if (!uids.length) return { ok: true, id: groupId };
        return patchCard(accountId0, groupId, { members: membersWithout(group, uids), updated: now() }, NO_GROUP);
      }),
    removeMany: async (ids) => {
      const accountId0 = accountId();
      if (!accountId0) return { removed: 0, error: UNAVAILABLE };
      let removed = 0;
      try {
        for (let i = 0; i < ids.length; i += PAGE) {
          const chunk = ids.slice(i, i + PAGE);
          const b = client.batch();
          const set = b.call('ContactCard/set', { accountId: accountId0, destroy: chunk });
          const res = (await client.send(b, USING)).get(set);
          const failed = Object.entries(res.notDestroyed ?? {}).filter(([, e]) => e.type !== 'notFound');
          const kept = new Set(failed.map(([id]) => id));
          const gone = chunk.filter((id) => !kept.has(id));
          put([], gone);
          removed += gone.length;
          advance(res.oldState, res.newState);
          if (failed.length) return { removed, error: refused(failed[0]![1], 'deletion') };
        }
      } catch (e) {
        if (e instanceof UnauthorizedError) throw e;
        return { removed, error: (e as Error).message };
      }
      return { removed };
    },
    importVcards: createImporter(client, { accountId, bookId: () => defaultBook()?.id, now, uid, catchUp: () => sync() }),
    importOpen,
    openImport: () => void setImportOpen(true),
    closeImport: () => void setImportOpen(false),
    movedTo: (id) => moved().get(id),
    groupDialog,
    openGroupDialog: (next) => void setGroupDialog(next),
    closeGroupDialog: () => void setGroupDialog(null),
    dialog,
    openDialog: (next) => void setDialog(next),
    closeDialog: () => void setDialog(null),
    stop: () => {
      stopped = true;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
    },
  };
}
