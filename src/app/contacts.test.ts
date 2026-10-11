import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadContacts, saveContacts } from '../cache/persist';
import { displayName, toForm } from '../contacts/card';
import { matchPeople } from '../contacts/search';
import { CONTACTS } from '../jmap/types';
import { FakeJmap } from '../sync/fake-jmap';
import { createContacts } from './contacts';


vi.mock('../cache/persist', () => ({
  loadContacts: vi.fn(async () => undefined),
  saveContacts: vi.fn(async () => undefined),
}));

const NOW = '2026-10-10T12:00:00Z';

function setup(opts: { contactsSupported?: boolean; saveDelayMs?: number } = {}) {
  const fake = new FakeJmap();
  fake.contactsSupported = opts.contactsSupported ?? true;
  const toast = vi.fn();
  const contacts = createRoot(() => createContacts(fake.client(), toast, { now: () => NOW, uid: () => 'urn:uuid:test', saveDelayMs: opts.saveDelayMs ?? 0 }));
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
  it('says so again when a retry fails too', async () => {
    const { fake, contacts, toast } = setup();
    fake.onCall = () => { throw new Error('down'); };
    await contacts.start('k');
    await contacts.reload();
    expect(toast).toHaveBeenCalledTimes(2);
  });
  it('loads an address book whole from a server that gives shorter pages than asked for', async () => {
    const { fake, contacts } = setup();
    fake.cardPageLimit = 100;
    for (let i = 0; i < 250; i++) fake.addCard({ name: { full: `P${i}` } });
    await contacts.start('k');
    expect(contacts.people()).toHaveLength(250);
  });
  it('deletes once when asked twice at once', async () => {
    const { fake, contacts, toast } = setup();
    const a = fake.addCard({ uid: 'u-1', name: { full: 'A' } });
    await contacts.start('k');
    const [one, two] = await Promise.all([contacts.remove(a.id), contacts.remove(a.id)]);
    expect([one.ok, two.ok]).toEqual([true, true]);
    expect(fake.sent.filter(([n, args]) => n === 'ContactCard/set' && args.destroy)).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });
  it('knows when it has caught up with the server, so a card newer than the stored copy can be waited for', async () => {
    const { fake, contacts } = setup();
    const a = fake.addCard({ name: { full: 'A' } });
    const state = `k${fake.cardState}`;
    const b = fake.addCard({ name: { full: 'B' } });
    vi.mocked(loadContacts).mockResolvedValue({ cards: [structuredClone(a)], books: [...fake.books.values()], cardState: state, bookState: 'ab1' });
    let seen: boolean | null = null;
    fake.onCall = (name) => {
      if (name === 'ContactCard/changes') seen = contacts.state.loaded && !contacts.state.current;
    };
    await contacts.start('k');
    expect(seen).toBe(true);
    expect(contacts.state.current).toBe(true);
    expect(contacts.state.cards[b.id]).toBeDefined();
  });
  it('counts as caught up when the server cannot be reached: there is nothing more to wait for', async () => {
    const { fake, contacts } = setup();
    fake.onCall = () => { throw new Error('down'); };
    await contacts.start('k').catch(() => {});
    expect(contacts.state.current).toBe(true);
  });
  it('writes nothing to the browser once stopped', async () => {
    const { fake, contacts } = setup({ saveDelayMs: 20 });
    fake.addCard({ name: { full: 'A' } });
    await contacts.start('signed-out');
    // A save is waiting its turn when the person is signed out.
    contacts.stop();
    contacts.onStateChange({ '@type': 'StateChange', changed: { a1: { ContactCard: 'k999' } } });
    await new Promise((r) => setTimeout(r, 40));
    // Other tests' stores may still be saving under their own keys.
    expect(vi.mocked(saveContacts).mock.calls.filter(([key]) => key === 'signed-out')).toEqual([]);
    expect(fake.calls.filter((c) => c === 'ContactCard/changes')).toEqual([]);
  });
  it('finds a person by their new name after everything is loaded again', async () => {
    const { fake, contacts } = setup();
    const a = fake.addCard({ name: { components: [{ kind: 'given', value: 'Before' }] } });
    await contacts.start('k');
    expect(matchPeople(contacts.people(), 'before')).toHaveLength(1);
    fake.cards.get(a.id)!.name = { components: [{ kind: 'given', value: 'After' }], full: 'After' };
    await contacts.reload();
    expect(matchPeople(contacts.people(), 'after')).toHaveLength(1);
    expect(matchPeople(contacts.people(), 'before')).toHaveLength(0);
  });
  it('loads everything again when the server rejects the state it kept', async () => {
    const { fake, contacts } = setup();
    fake.addCard({ name: { full: 'A' } });
    vi.mocked(loadContacts).mockResolvedValue({ cards: [], books: [], cardState: 'not-a-state', bookState: 'ab1' });
    await contacts.start('k');
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

describe('createContacts: groups and bulk work', () => {
  const person = (fake: FakeJmap, name: string, uid?: string) => fake.addCard({ ...(uid ? { uid } : {}), name: { full: name }, emails: { e1: { address: `${name.toLowerCase()}@x.example` } } });
  const sets = (fake: FakeJmap) => fake.sent.filter(([n]) => n === 'ContactCard/set').map(([, a]) => a);

  it('creates a group with a kind and a uid, listed among groups and not among people', async () => {
    const { fake, contacts } = setup();
    person(fake, 'Ann', 'u-ann');
    await contacts.start('k');
    const r = await contacts.createGroup('  Team  ');
    expect(r.ok).toBe(true);
    expect(contacts.groups().map((g) => g.name?.full)).toEqual(['Team']);
    expect(contacts.people().map((p) => p.name?.full)).toEqual(['Ann']);
    expect([...fake.cards.values()].find((c) => c.kind === 'group')).toMatchObject({ uid: 'urn:uuid:test', created: NOW, updated: NOW, name: { full: 'Team' } });
  });
  it('renames a group, and says so when it is gone', async () => {
    const { fake, contacts } = setup();
    const g = fake.addCard({ kind: 'group', uid: 'g1', name: { full: 'Old' }, members: { 'u-ann': true } });
    await contacts.start('k');
    expect((await contacts.renameGroup(g.id, ' New ')).ok).toBe(true);
    expect(fake.cards.get(g.id)).toMatchObject({ name: { full: 'New' }, updated: NOW, members: { 'u-ann': true } });
    expect(contacts.groups()[0]!.name?.full).toBe('New');
    fake.cards.delete(g.id);
    expect(await contacts.renameGroup(g.id, 'Newer')).toEqual({ ok: false, error: 'This group no longer exists.' });
    expect(await contacts.renameGroup('nope', 'Newer')).toEqual({ ok: false, error: 'This group no longer exists.' });
  });
  it('deletes a group and leaves its people', async () => {
    const { fake, contacts } = setup();
    person(fake, 'Ann', 'u-ann');
    const g = fake.addCard({ kind: 'group', uid: 'g1', name: { full: 'Team' }, members: { 'u-ann': true } });
    await contacts.start('k');
    expect((await contacts.removeGroup(g.id)).ok).toBe(true);
    expect(contacts.groups()).toEqual([]);
    expect(contacts.people()).toHaveLength(1);
  });
  it('adds people to a group; one with no uid is first replaced by a copy that has one', async () => {
    const { fake, contacts } = setup();
    const ann = person(fake, 'Ann', 'u-ann');
    const bob = person(fake, 'Bob');
    const g = fake.addCard({ kind: 'group', uid: 'g1', name: { full: 'Team' } });
    await contacts.start('k');
    const r = await contacts.addToGroup(g.id, [ann.id, bob.id]);
    expect(r.ok).toBe(true);
    expect(fake.cards.has(bob.id)).toBe(false);
    const copy = [...fake.cards.values()].find((c) => c.name?.full === 'Bob')!;
    expect(copy).toMatchObject({ uid: 'urn:uuid:test', emails: { e1: { address: 'bob@x.example' } }, updated: NOW });
    expect(fake.cards.get(g.id)!.members).toEqual({ 'u-ann': true, 'urn:uuid:test': true });
    expect(contacts.state.cards[bob.id]).toBeUndefined();
    expect(contacts.movedTo(bob.id)).toBe(copy.id);
    expect(contacts.people().map((p) => p.name?.full)).toEqual(['Ann', 'Bob']);
    expect(fake.cards.get(g.id)!.updated).toBe(NOW);
  });
  it('keeps the original when the copy cannot be made', async () => {
    const { fake, contacts } = setup();
    const bob = person(fake, 'Bob');
    fake.addCard({ uid: 'urn:uuid:test', name: { full: 'Holder of the uid' } });
    const g = fake.addCard({ kind: 'group', uid: 'g1', name: { full: 'Team' } });
    await contacts.start('k');
    const r = await contacts.addToGroup(g.id, [bob.id]);
    expect(r.ok).toBe(false);
    expect(fake.cards.has(bob.id)).toBe(true);
    expect(fake.cards.get(g.id)!.members).toBeUndefined();
  });
  it('sends nothing when everyone is already in the group', async () => {
    const { fake, contacts } = setup();
    const ann = person(fake, 'Ann', 'u-ann');
    const g = fake.addCard({ kind: 'group', uid: 'g1', name: { full: 'Team' }, members: { 'u-ann': true } });
    await contacts.start('k');
    const before = sets(fake).length;
    expect((await contacts.addToGroup(g.id, [ann.id])).ok).toBe(true);
    expect(sets(fake)).toHaveLength(before);
  });
  it('removes people from a group, clearing members when the last goes and keeping keys it does not know', async () => {
    const { fake, contacts } = setup();
    const ann = person(fake, 'Ann', 'u-ann');
    const bob = person(fake, 'Bob', 'u-bob');
    const g = fake.addCard({ kind: 'group', uid: 'g1', name: { full: 'Team' }, members: { 'u-ann': true, 'u-bob': true, 'u-gone': true } });
    await contacts.start('k');
    await contacts.removeFromGroup(g.id, [ann.id]);
    expect(fake.cards.get(g.id)!.members).toEqual({ 'u-bob': true, 'u-gone': true });
    fake.cards.get(g.id)!.members = { 'u-bob': true };
    await contacts.reload();
    await contacts.removeFromGroup(g.id, [bob.id]);
    expect(fake.cards.get(g.id)).not.toHaveProperty('members');
    expect(contacts.groups()[0]!.members).toBeUndefined();
  });
  it('says so when the group to change is gone', async () => {
    const { fake, contacts } = setup();
    const ann = person(fake, 'Ann', 'u-ann');
    await contacts.start('k');
    expect(await contacts.addToGroup('nope', [ann.id])).toEqual({ ok: false, error: 'This group no longer exists.' });
    expect(await contacts.removeFromGroup('nope', [ann.id])).toEqual({ ok: false, error: 'This group no longer exists.' });
  });
  it('deletes several people in one go, counting one already gone', async () => {
    const { fake, contacts } = setup();
    const ids = ['Ann', 'Bob', 'Cy'].map((n) => person(fake, n, `u-${n}`).id);
    await contacts.start('k');
    fake.cards.delete(ids[1]!);
    expect(await contacts.removeMany(ids)).toEqual({ removed: 3 });
    expect(contacts.people()).toEqual([]);
    expect(sets(fake).filter((a) => a.destroy)).toHaveLength(1);
  });
  it('deletes more than 500 people in chunks', async () => {
    const { fake, contacts } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 620; i++) ids.push(fake.addCard({ name: { full: `P${i}` } }).id);
    await contacts.start('k');
    expect(await contacts.removeMany(ids)).toEqual({ removed: 620 });
    expect(sets(fake).filter((a) => a.destroy).map((a) => (a.destroy as string[]).length)).toEqual([500, 120]);
  });
  it('holds the group dialog', async () => {
    const { contacts } = setup();
    expect(contacts.groupDialog()).toBeNull();
    contacts.openGroupDialog({ kind: 'create', then: ['c1'] });
    expect(contacts.groupDialog()).toEqual({ kind: 'create', then: ['c1'] });
    contacts.closeGroupDialog();
    expect(contacts.groupDialog()).toBeNull();
  });
});
