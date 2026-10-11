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
  it('reads a card another client left malformed without failing', () => {
    const broken = card({
      name: { components: [{ kind: 'given' }, null, { kind: 'surname', value: 'Kept' }] },
      emails: { a: {}, b: null, c: { address: 'ok@x.example' } },
      phones: { a: {}, b: { number: 5 } },
      notes: { a: {}, b: { note: 'fine' } },
      nicknames: { a: {} },
      organizations: { a: null },
      titles: { a: {} },
      addresses: { a: null, b: { components: [null, { kind: 'locality' }] } },
      anniversaries: { a: null },
      media: { a: null },
      links: { a: {} },
      onlineServices: { a: null },
    } as never);
    expect(displayName(broken)).toBe('Kept');
    expect(emailsOf(broken).map((e) => e.address)).toEqual(['', 'ok@x.example']);
    expect(phonesOf(broken).map((p) => p.number)).toEqual(['', '']);
    expect(notesOf(broken)).toBe('fine');
    expect(addressesOf(broken).map((a) => a.text)).toEqual(['']);
    expect(organizationOf(broken)).toEqual({ name: '', department: '', title: '' });
    expect(birthdayOf(broken)).toBeNull();
    expect(photoOf(broken)).toBeNull();
    expect(extrasOf(broken)).toEqual([]);
    expect(() => toForm(broken)).not.toThrow();
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
  it('writes nothing for a card whose oddities the form does not show', () => {
    const odd = card({
      name: { full: 'Mary Ann Van Der Berg', components: [{ kind: 'given', value: 'Mary' }, { kind: 'given', value: 'Ann' }, { kind: 'surname', value: 'Van Der' }, { kind: 'surname', value: 'Berg' }] },
      emails: { e1: { address: ' mary@x.example ' }, e2: { address: '' } },
      phones: { p1: { number: ' 555 ' }, p2: { number: '' } },
      addresses: { a1: { full: '' } },
      organizations: { o1: { name: ' Acme ', units: [{ name: 'Sales', sortAs: 'S' }, { name: 'North' }] } },
      titles: { t1: { name: 'Seller' } },
    });
    expect(patchFor(odd, toForm(odd), NOW)).toEqual({});
  });
  it('keeps what else a department and a job title hold when they are renamed', () => {
    const c = card({ organizations: { o1: { name: 'Acme', units: [{ name: 'Sales', sortAs: 'S' }, { name: 'North' }] } }, titles: { t1: { name: 'Seller' } } });
    const patch = patchFor(c, { ...toForm(c), department: 'Marketing', title: 'Buyer' }, NOW);
    expect(patch.organizations).toEqual({ o1: { name: 'Acme', units: [{ name: 'Marketing', sortAs: 'S' }, { name: 'North' }] } });
    expect(patch.titles).toEqual({ t1: { name: 'Buyer' } });
  });
  it('reads every given name and surname, and keeps the ones a rename does not touch', () => {
    const c = card({ name: { components: [{ kind: 'given', value: 'Mary' }, { kind: 'given', value: 'Ann' }, { kind: 'surname', value: 'Van Der' }, { kind: 'surname', value: 'Berg' }] } });
    expect(nameParts(c)).toEqual({ given: 'Mary Ann', surname: 'Van Der Berg' });
    const patch = patchFor(c, { ...toForm(c), surname: 'Roe' }, NOW);
    expect(patch.name).toEqual({ components: [{ kind: 'given', value: 'Mary' }, { kind: 'given', value: 'Ann' }, { kind: 'surname', value: 'Roe' }], isOrdered: true, full: 'Mary Ann Roe' });
  });
  it('says what is wrong with a birthday', () => {
    const f = toForm();
    expect(validateForm({ ...f, given: 'A', birthday: { day: '3', month: '', year: '' } }).birthday).toBe('Give both a day and a month.');
    expect(validateForm({ ...f, given: 'A', birthday: { day: '3', month: '4', year: 'abc' } }).birthday).toBe('Give the year as a number, or leave it empty.');
  });
  it('measures a card in bytes', () => {
    expect(cardBytes({ a: 'é' })).toBe(new TextEncoder().encode('{"a":"é"}').length);
    expect(MAX_CARD_BYTES).toBe(524_288);
  });
});
