import { describe, expect, it } from 'vitest';
import type { ContactCard } from '../jmap/types';
import { findDuplicates, peekVcard, splitVcards, toVcard, toVcards } from './vcard';

const vc = (...lines: string[]) => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n') + '\r\n';
const card = (c: Partial<ContactCard>): ContactCard => ({ id: 'c1', addressBookIds: { b: true }, ...c });

describe('splitVcards', () => {
  it('cuts a file into its cards, ignoring what lies between them and counting one cut short', () => {
    const text = `junk\r\n${vc('FN:One')}\r\nmore junk\r\n${vc('FN:Two')}${vc('FN:Three')}BEGIN:VCARD\r\nFN:Never ended\r\n`;
    const { blocks, unreadable } = splitVcards(text);
    expect(blocks).toEqual([vc('FN:One'), vc('FN:Two'), vc('FN:Three')]);
    expect(unreadable).toBe(1);
  });
  it('reads bare line feeds, a byte-order mark and any letter case, and gives every block CRLF', () => {
    const text = '﻿begin:vcard\nVERSION:3.0\nFN:Line Feed\nend:VCARD\n';
    expect(splitVcards(text)).toEqual({ blocks: ['begin:vcard\r\nVERSION:3.0\r\nFN:Line Feed\r\nend:VCARD\r\n'], unreadable: 0 });
  });
  it('counts a card begun inside another as cut short, and finds nothing in a file that is no vCard', () => {
    expect(splitVcards('BEGIN:VCARD\r\nFN:A\r\nBEGIN:VCARD\r\nFN:B\r\nEND:VCARD\r\n')).toMatchObject({ unreadable: 1, blocks: [expect.stringContaining('FN:B')] });
    expect(splitVcards('Name,Email\r\nAnn,ann@x.example\r\n')).toEqual({ blocks: [], unreadable: 0 });
    expect(splitVcards('')).toEqual({ blocks: [], unreadable: 0 });
  });
});

describe('peekVcard', () => {
  it('reads a card as Google writes one', () => {
    expect(peekVcard(vc('FN:Zoë Probe', 'N:Probe;Zoë;;;', 'item1.EMAIL;TYPE=INTERNET:Zoe@Work.example', 'item1.X-ABLabel:Work', 'EMAIL;TYPE=INTERNET;TYPE=HOME:zoe@home.example')))
      .toEqual({ uid: '', emails: ['zoe@work.example', 'zoe@home.example'], name: 'Zoë Probe', group: false });
  });
  it('reads a uid folded over two lines', () => {
    expect(peekVcard(vc('FN:A', 'UID:urn:uuid:11111111-1111-4111-8111-\r\n 111111111111')).uid).toBe('urn:uuid:11111111-1111-4111-8111-111111111111');
  });
  it('names a card with only N, with only an email, and with nothing', () => {
    expect(peekVcard(vc('N:Probe\\, Jr;Zoë;;;')).name).toBe('Zoë Probe, Jr');
    expect(peekVcard(vc('EMAIL:only@x.example')).name).toBe('only@x.example');
    expect(peekVcard(vc('TEL:555')).name).toBe('No name');
  });
  it('leaves out what is no address, and knows a group as Apple and as vCard 4 write one', () => {
    expect(peekVcard(vc('FN:A', 'EMAIL:not an address', 'email:ok@x.example')).emails).toEqual(['ok@x.example']);
    expect(peekVcard(vc('FN:G', 'X-ADDRESSBOOKSERVER-KIND:group')).group).toBe(true);
    expect(peekVcard(vc('FN:G', 'KIND:Group')).group).toBe(true);
    expect(peekVcard(vc('FN:P', 'KIND:individual')).group).toBe(false);
  });
});

describe('findDuplicates', () => {
  const existing = [
    card({ id: '1', uid: 'u-1', name: { full: 'Ann' }, emails: { e: { address: 'Ann@X.example' } } }),
    card({ id: '2', uid: 'g-1', kind: 'group', name: { full: 'Team' } }),
  ];
  const peek = (uid: string, emails: string[] = [], group = false) => ({ uid, emails, name: 'x', group });
  it('knows a card by its uid, then by an email an existing person has', () => {
    expect(findDuplicates([peek('u-1'), peek('u-new', ['ann@x.example']), peek('', ['new@x.example']), peek('u-other')], existing)).toEqual({ duplicates: [0, 1], fresh: [2, 3] });
  });
  it('knows a card repeated inside the file by its uid', () => {
    expect(findDuplicates([peek('u-9'), peek('u-9'), peek('', ['a@x.example']), peek('', ['a@x.example'])], existing)).toEqual({ duplicates: [1], fresh: [0, 2, 3] });
  });
  it('matches a group by uid only, and never a person against a group', () => {
    expect(findDuplicates([peek('g-1', [], true), peek('g-2', ['ann@x.example'], true)], existing)).toEqual({ duplicates: [0], fresh: [1] });
  });
});

describe('toVcard', () => {
  const zoe = card({
    uid: 'urn:uuid:1',
    kind: 'individual',
    name: { full: 'ignored', components: [{ kind: 'surname', value: 'Probe' }, { kind: 'title', value: 'Dr' }, { kind: 'given', value: 'Zoë' }, { kind: 'given2', value: 'Ann' }, { kind: 'credential', value: 'PhD' }] },
    nicknames: { k1: { name: 'Zed' } },
    emails: { e1: { address: 'zoe@home.example', contexts: { private: true } }, e2: { address: 'zoe@work.example', contexts: { work: true }, pref: 1 }, e3: { address: 'zoe@other.example' } },
    phones: { p1: { number: '+1 555 0100', features: { mobile: true } }, p2: { number: '+1 555 0101', contexts: { work: true } }, p3: { number: '+1 555 0102', contexts: { private: true } }, p4: { number: '+1 555 0103', features: { fax: true } } },
    organizations: { o1: { name: 'Acme, Ltd', units: [{ name: 'Research' }] } },
    titles: { t1: { name: 'Head of Research', kind: 'title' } },
    addresses: { a1: { full: '1 High St\nLeeds "LS1"', contexts: { private: true } } },
    anniversaries: { b1: { kind: 'birth', date: { '@type': 'PartialDate', month: 3, day: 14 } } },
    notes: { n1: { note: 'Likes tea; hates coffee\nSecond line' } },
    links: { l1: { uri: 'https://zoe.example' } },
    keywords: { vip: true, friend: true },
    media: { m1: { kind: 'photo', uri: 'data:image/png;base64,iVBORw0KGgo=' }, m2: { kind: 'photo', uri: 'https://elsewhere.example/p.png' } },
  });
  it('writes a person as vCard 4.0, line for line', () => {
    expect(toVcard(zoe).split('\r\n')).toEqual([
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:urn:uuid:1',
      'KIND:individual',
      'FN:Dr Zoë Ann Probe PhD',
      'N:Probe;Zoë;Ann;Dr;PhD',
      'NICKNAME:Zed',
      'EMAIL;TYPE=work;PREF=1:zoe@work.example',
      'EMAIL;TYPE=home:zoe@home.example',
      'EMAIL:zoe@other.example',
      'TEL;TYPE=cell:+1 555 0100',
      'TEL;TYPE=work:+1 555 0101',
      'TEL;TYPE=home:+1 555 0102',
      'TEL;TYPE=fax:+1 555 0103',
      'ORG:Acme\\, Ltd;Research',
      'TITLE:Head of Research',
      "ADR;TYPE=home;LABEL=\"1 High St\\nLeeds 'LS1'\":;;1 High St\\nLeeds \"LS1\";;;;",
      'BDAY:--0314',
      'NOTE:Likes tea\; hates coffee\\nSecond line',
      'URL:https://zoe.example',
      'CATEGORIES:vip,friend',
      'PHOTO:data:image/png;base64,iVBORw0KGgo=',
      'END:VCARD',
      '',
    ]);
  });
  it('writes a group with its members as they are stored, and a birthday with its year', () => {
    const group = card({ uid: 'g-1', kind: 'group', name: { full: 'Team' }, members: { 'urn:uuid:1': true, 'mailto:ext@else.example': true, 'u-off': false } });
    expect(toVcard(group).split('\r\n')).toEqual(['BEGIN:VCARD', 'VERSION:4.0', 'UID:g-1', 'KIND:group', 'FN:Team', 'MEMBER:urn:uuid:1', 'MEMBER:mailto:ext@else.example', 'END:VCARD', '']);
    expect(toVcard(card({ name: { full: 'B' }, anniversaries: { b: { kind: 'birth', date: { year: 1990, month: 3, day: 4 } } } }))).toContain('\r\nBDAY:19900304\r\n');
  });
  it('writes a card with nothing to call it by, and an address kept as parts', () => {
    expect(toVcard(card({}))).toBe('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:No name\r\nEND:VCARD\r\n');
    expect(toVcard(card({ name: { full: 'A' }, addresses: { a: { components: [{ kind: 'name', value: '12 High St' }, { kind: 'locality', value: 'Leeds' }] } } }))).toContain('ADR;LABEL="12 High St, Leeds":;;12 High St\\, Leeds;;;;');
  });
  it('folds a long line at 75 octets without splitting a character, and it unfolds to the original', () => {
    const note = 'é'.repeat(100);
    const lines = toVcard(card({ name: { full: 'A' }, notes: { n: { note } } })).split('\r\n');
    const bytes = (l: string) => new TextEncoder().encode(l).length;
    expect(lines.every((l) => bytes(l) <= 75)).toBe(true);
    expect(lines.filter((l) => l.startsWith(' ')).length).toBeGreaterThan(1);
    const unfolded = lines.join('\r\n').replace(/\r\n /g, '');
    expect(unfolded).toContain(`NOTE:${note}\r\n`);
  });
  it('joins cards one after another, and peeks back at what it wrote', () => {
    const text = toVcards([zoe, card({ id: 'c2', uid: 'u-2', name: { full: 'Bob' }, emails: { e: { address: 'bob@x.example' } } })]);
    const { blocks, unreadable } = splitVcards(text);
    expect(unreadable).toBe(0);
    expect(blocks.map(peekVcard)).toEqual([
      { uid: 'urn:uuid:1', emails: ['zoe@work.example', 'zoe@home.example', 'zoe@other.example'], name: 'Dr Zoë Ann Probe PhD', group: false },
      { uid: 'u-2', emails: ['bob@x.example'], name: 'Bob', group: false },
    ]);
  });
});
