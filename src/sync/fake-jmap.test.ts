import { describe, expect, it } from 'vitest';
import { CONTACTS, VACATION } from '../jmap/types';
import { FakeJmap } from './fake-jmap';

const ALL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', VACATION];
const set = (s: FakeJmap, args: Record<string, unknown>) => s.handle('Identity/set', { accountId: 'a1', ...args }, ALL)[1] as Record<string, any>;
const vset = (s: FakeJmap, patch: Record<string, unknown>) =>
  s.handle('VacationResponse/set', { accountId: 'a1', update: { singleton: patch } }, ALL)[1] as Record<string, any>;

describe('FakeJmap identities (as Stalwart 0.16.23)', () => {
  it('serves the default identity with every property', () => {
    const [, r] = new FakeJmap().handle('Identity/get', { accountId: 'a1', ids: null }, ALL) as [string, any];
    expect(r.list).toEqual([{ id: 'id1', name: 'Alice', email: 'alice@example.test', replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: true }]);
  });

  it('creates on an owned address, lowercased, and answers without oldState', () => {
    const s = new FakeJmap();
    const r = set(s, { create: { c: { name: 'Support', email: 'ALICE@example.test', textSignature: null } } });
    expect(r.oldState).toBeUndefined();
    const id = r.created.c.id as string;
    expect(r.created.c).toEqual({ id });
    expect(s.identities.get(id)).toMatchObject({ email: 'alice@example.test', textSignature: '' });
  });

  it('refuses addresses the account does not own, malformed and missing ones', () => {
    const r = set(new FakeJmap(), { create: { a: { email: 'bob@example.test' }, b: { email: 'nope' }, c: { name: 'x' } } });
    expect(r.notCreated.a).toMatchObject({ type: 'invalidProperties', properties: ['email'], description: 'E-mail address not configured for this account.' });
    expect(r.notCreated.b).toMatchObject({ type: 'invalidProperties', properties: ['email'], description: 'Invalid e-mail address.' });
    expect(r.notCreated.c).toMatchObject({ type: 'invalidProperties', properties: ['email'], description: 'Missing e-mail address.' });
  });

  it('refuses changing the address and over-long fields', () => {
    const s = new FakeJmap();
    expect(set(s, { update: { id1: { email: 'x@example.test' } } }).notUpdated.id1).toMatchObject({ type: 'invalidProperties', properties: ['email'] });
    expect(set(s, { update: { id1: { name: 'x'.repeat(255) } } }).notUpdated.id1).toMatchObject({ properties: ['name'] });
    expect(set(s, { update: { id1: { htmlSignature: 'x'.repeat(2048) } } }).notUpdated.id1).toMatchObject({ properties: ['htmlSignature'] });
    expect(set(s, { update: { id1: { name: 'x'.repeat(254), htmlSignature: 'x'.repeat(2047) } } }).updated).toEqual({ id1: null });
  });

  it('stops at 20 identities with overQuota', () => {
    const s = new FakeJmap();
    for (let i = 0; i < 19; i++) set(s, { create: { c: { email: 'alice@example.test' } } });
    expect(s.identities.size).toBe(20);
    expect(set(s, { create: { c: { email: 'alice@example.test' } } }).notCreated.c.type).toBe('overQuota');
  });

  it('lets the last identity be destroyed, and reports unknown ids', () => {
    const s = new FakeJmap();
    const r = set(s, { destroy: ['id1', 'zz'] });
    expect(r.destroyed).toEqual(['id1']);
    expect(r.notDestroyed.zz.type).toBe('notFound');
    expect(s.identities.size).toBe(0);
  });

  it('moves the state on every change and logs it for Identity/changes', () => {
    const s = new FakeJmap();
    const before = (s.handle('Identity/get', { accountId: 'a1', ids: null }, ALL)[1] as any).state;
    const r = set(s, { update: { id1: { name: 'A' } } });
    expect(r.newState).not.toBe(before);
    const [, ch] = s.handle('Identity/changes', { accountId: 'a1', sinceState: before }, ALL) as [string, any];
    expect(ch.updated).toEqual(['id1']);
  });
});

describe('FakeJmap vacation response (as Stalwart 0.16.23)', () => {
  it('needs the capability in using', () => {
    const [name, r] = new FakeJmap().handle('VacationResponse/get', { accountId: 'a1', ids: null }, ALL.slice(0, 2)) as [string, any];
    expect(name).toBe('error');
    expect(r.type).toBe('unknownMethod');
  });

  it('serves a disabled, empty singleton and applies partial updates', () => {
    const s = new FakeJmap();
    expect((s.handle('VacationResponse/get', { accountId: 'a1', ids: ['singleton'] }, ALL)[1] as any).list[0]).toEqual({
      id: 'singleton', isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null,
    });
    const r = vset(s, { isEnabled: true, subject: 'Away' });
    expect(r.updated).toEqual({ singleton: null });
    expect(r.oldState).toBeDefined();
    expect(s.vacation).toMatchObject({ isEnabled: true, subject: 'Away', textBody: null });
  });

  it('refuses create, destroy, unknown ids and date-only values; accepts an end before the start', () => {
    const s = new FakeJmap();
    const r = s.handle('VacationResponse/set', { accountId: 'a1', create: { x: {} }, destroy: ['singleton'], update: { other: { isEnabled: true } } }, ALL)[1] as any;
    expect(r.notCreated.x.type).toBe('singleton');
    expect(r.notDestroyed.singleton.type).toBe('singleton');
    expect(r.notUpdated.other.type).toBe('notFound');
    expect(vset(s, { fromDate: '2026-10-05' }).notUpdated.singleton).toMatchObject({ type: 'invalidProperties', properties: ['fromDate'] });
    expect(vset(s, { fromDate: '2026-10-20T00:00:00Z', toDate: '2026-10-10T00:00:00Z' }).updated).toEqual({ singleton: null });
  });

  it('applies the byte limits, including the shared body budget', () => {
    const s = new FakeJmap();
    expect(vset(s, { subject: 'x'.repeat(512) }).notUpdated.singleton.properties).toEqual(['subject']);
    expect(vset(s, { textBody: 'x'.repeat(2048) }).notUpdated.singleton.properties).toEqual(['textBody']);
    expect(vset(s, { textBody: 'x'.repeat(2047), htmlBody: 'x'.repeat(1458) }).notUpdated.singleton.properties).toEqual(['htmlBody']);
    // With no text part the server derives one from the HTML, and that copy counts too.
    expect(vset(s, { textBody: null, htmlBody: 'x'.repeat(1753) }).notUpdated.singleton.properties).toEqual(['htmlBody']);
    expect(vset(s, { textBody: null, htmlBody: 'x'.repeat(1752) }).updated).toEqual({ singleton: null });
  });
});

describe('FakeJmap message parts (as Stalwart 0.16.23)', () => {
  const eset = (s: FakeJmap, args: Record<string, unknown>) => s.handle('Email/set', { accountId: 'a1', ...args }, ALL)[1] as Record<string, any>;
  const message = (blobId: string) => ({
    subject: 'x',
    bodyValues: { text: { value: 't' }, html: { value: '<img src="cid:c1@oinbox">' } },
    bodyStructure: {
      type: 'multipart/mixed',
      subParts: [
        { type: 'multipart/alternative', subParts: [
          { partId: 'text', type: 'text/plain' },
          { type: 'multipart/related', subParts: [
            { partId: 'html', type: 'text/html' },
            { blobId, type: 'image/png', name: 'a.png', cid: 'c1@oinbox', disposition: 'inline' },
          ] },
        ] },
        { blobId, type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' },
      ],
    },
  });
  const server = () => {
    const s = new FakeJmap();
    s.uploads.add('up1');
    return s;
  };

  it('stores a bodyStructure as body parts and attachments, each with a blob id of its own', () => {
    const s = server();
    const id = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    const e = s.emails.get(id)!;
    expect(e.htmlBody!.map((p) => [p.partId, p.type])).toEqual([['html', 'text/html']]);
    expect(e.textBody!.map((p) => [p.partId, p.type])).toEqual([['text', 'text/plain']]);
    expect(e.attachments!.map((p) => [p.name, p.cid, p.disposition])).toEqual([['a.png', 'c1@oinbox', 'inline'], ['a.pdf', null, 'attachment']]);
    const blobs = e.attachments!.map((p) => p.blobId);
    expect(new Set(blobs).size).toBe(2);
    expect(blobs).not.toContain('up1');
    expect('bodyStructure' in e).toBe(false);
  });

  it('accepts the blob of an upload again, and the part blob of a message that still exists', () => {
    const s = server();
    const first = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    expect(eset(s, { create: { c: message('up1') } }).created.c).toBeTruthy();
    const part = s.emails.get(first)!.attachments![0]!.blobId!;
    expect(eset(s, { create: { c: message(part) } }).created.c).toBeTruthy();
  });

  it('refuses the part blob of a destroyed message, and an unknown blob', () => {
    const s = server();
    const first = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    const part = s.emails.get(first)!.attachments![0]!.blobId!;
    eset(s, { destroy: [first] });
    const r = eset(s, { create: { c: message(part) } });
    expect(r.created.c).toBeUndefined();
    expect(r.notCreated.c.type).toBe('blobNotFound');
    expect(eset(s, { create: { c: message('nope') } }).notCreated.c.type).toBe('blobNotFound');
  });

  it('accepts a part blob in the request that destroys its message', () => {
    const s = server();
    const first = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    const part = s.emails.get(first)!.attachments![0]!.blobId!;
    const r = eset(s, { create: { c: message(part) }, destroy: [first] });
    expect(r.created.c).toBeTruthy();
    expect(r.destroyed).toEqual([first]);
  });

  it('still destroys when the create in the same request fails', () => {
    const s = server();
    const first = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    const r = eset(s, { create: { c: message('nope') }, destroy: [first] });
    expect(r.notCreated.c.type).toBe('blobNotFound');
    expect(s.emails.has(first)).toBe(false);
  });

  it('answers notDestroyed: notFound for an unknown id, forbidden for a rejected one that stays', () => {
    const s = server();
    const id = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    s.rejectDestroys.add(id);
    const r = eset(s, { destroy: [id, 'nope'] });
    expect(r.notDestroyed).toEqual({ [id]: { type: 'forbidden' }, nope: { type: 'notFound' } });
    expect(r.destroyed).toEqual([]);
    expect(s.emails.has(id)).toBe(true);
    s.rejectDestroys.clear();
    const r2 = eset(s, { destroy: [id] });
    expect(r2.destroyed).toEqual([id]);
    expect(r2.notDestroyed).toBeNull();
  });
});

const call = (s: FakeJmap, name: string, args: Record<string, unknown>) => s.handle(name, { accountId: 'a1', ...args }, [CONTACTS])[1] as Record<string, any>;

describe('FakeJmap contacts (as Stalwart 0.16.23)', () => {
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
