import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadContacts, saveContacts } from '../cache/persist';
import { displayName, toForm } from '../contacts/card';
import { CONTACTS } from '../jmap/types';
import { FakeJmap } from '../sync/fake-jmap';
import { createContacts } from './contacts';

vi.mock('../cache/persist', () => ({
  loadContacts: vi.fn(async () => undefined),
  saveContacts: vi.fn(async () => undefined),
}));

const NOW = '2026-10-10T12:00:00Z';

function setup(opts: { contactsSupported?: boolean } = {}) {
  const fake = new FakeJmap();
  fake.contactsSupported = opts.contactsSupported ?? true;
  const toast = vi.fn();
  const contacts = createRoot(() => createContacts(fake.client(), toast, { now: () => NOW, uid: () => 'urn:uuid:test', saveDelayMs: 0 }));
  return { fake, contacts, toast };
}

beforeEach(() => {
  vi.mocked(loadContacts).mockReset().mockResolvedValue(undefined);
  vi.mocked(saveContacts).mockClear();
});

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
