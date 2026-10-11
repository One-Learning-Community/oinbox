// vCard files, as far as the browser deals with them: cutting a file into its cards and telling a
// duplicate before anything is uploaded (the server does the reading), and writing an export.
// Pure: no Solid, no JMAP.
import type { ContactCard } from '../jmap/types';
import { addressesOf, birthdayOf, displayName, emailsOf, isGroup, nicknamesOf, phonesOf, photoOf } from './card';

const BEGIN = /^BEGIN:\s*VCARD\s*$/i;
const END = /^END:\s*VCARD\s*$/i;
const ADDRESS = /^[^\s@]+@[^\s@]+$/;

/** The cards of a file's text, each from BEGIN:VCARD to END:VCARD with CRLF line ends, and how many began and never ended. */
export function splitVcards(text: string): { blocks: string[]; unreadable: number } {
  const blocks: string[] = [];
  let unreadable = 0;
  let open: string[] | null = null;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    if (BEGIN.test(line)) {
      if (open) unreadable++;
      open = [line];
    } else if (open) {
      open.push(line);
      if (END.test(line)) {
        blocks.push(`${open.join('\r\n')}\r\n`);
        open = null;
      }
    }
  }
  if (open) unreadable++;
  return { blocks, unreadable };
}

/** What can be told of a card without parsing it: enough to name it and to know a duplicate. */
export interface VcardPeek {
  /** The card's UID, or one made from its text when it has none. Never empty. */
  uid: string;
  /** Lower case. */
  emails: string[];
  name: string;
  group: boolean;
}

const unescape = (value: string) => value.replace(/\\([\\,;nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
/** A structured value's parts: cut at each `;` that is not escaped. */
const parts = (value: string) => value.split(/(?<!\\);/).map((p) => unescape(p).trim());

/** The content lines of a block as [NAME, value], unfolded, without a group prefix or parameters. */
function contentLines(block: string): [string, string][] {
  const lines: string[] = [];
  for (const raw of block.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  const out: [string, string][] = [];
  for (const line of lines) {
    // The first colon outside quotes ends the name and its parameters.
    let colon = -1;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ':' && !quoted) {
        colon = i;
        break;
      }
    }
    if (colon < 1) continue;
    const name = line.slice(0, colon).split(';')[0]!.replace(/^[^.]*\./, '').toUpperCase();
    out.push([name, line.slice(colon + 1)]);
  }
  return out;
}

/** A 53-bit hash of a text (cyrb53), as 14 hex digits. */
function hash(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * A uid for a card whose text has none, made from the text: the same file gives the same uids, so
 * a card with neither UID nor email (a phone number and a name) is still known when the file is
 * chosen a second time.
 */
function textUid(block: string): string {
  const h = hash(block, 1) + hash(block, 2) + hash(block, 3);
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`;
}

export function peekVcard(block: string): VcardPeek {
  const lines = contentLines(block);
  const first = (name: string) => lines.find(([n]) => n === name)?.[1] ?? '';
  const emails = lines.filter(([n]) => n === 'EMAIL').map(([, v]) => v.trim().toLowerCase()).filter((v) => ADDRESS.test(v));
  const [surname = '', given = ''] = parts(first('N'));
  const name = unescape(first('FN')).trim() || [given, surname].filter(Boolean).join(' ') || emails[0] || 'No name';
  const kind = (first('KIND') || first('X-ADDRESSBOOKSERVER-KIND')).trim().toLowerCase();
  return { uid: first('UID').trim() || textUid(block), emails, name, group: kind === 'group' };
}

/** Indexes into the peeks given. */
export interface DuplicateCheck {
  fresh: number[];
  duplicates: number[];
}

/**
 * A duplicate has the uid of an existing card or of an earlier card in the file or, failing that,
 * an email an existing person has. Groups are matched by uid only.
 */
export function findDuplicates(peeks: VcardPeek[], existing: ContactCard[]): DuplicateCheck {
  const uids = new Set(existing.map((c) => c.uid).filter((u): u is string => !!u));
  const addresses = new Set(existing.filter((c) => !isGroup(c)).flatMap((c) => emailsOf(c).map((e) => e.address.trim().toLowerCase())).filter(Boolean));
  const fresh: number[] = [];
  const duplicates: number[] = [];
  peeks.forEach((peek, i) => {
    const known = (peek.uid && uids.has(peek.uid)) || (!peek.group && peek.emails.some((e) => addresses.has(e)));
    (known ? duplicates : fresh).push(i);
    if (peek.uid) uids.add(peek.uid);
  });
  return { fresh, duplicates };
}

const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\r\n|\n|\r/g, '\\n');
/** A value written as it is (a URI, an address, a number): only made unable to start a line of its own. */
const plain = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
const two = (n: number) => String(n).padStart(2, '0');
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const entries = <T>(map: Record<string, T> | undefined | null): T[] =>
  map && typeof map === 'object' ? Object.values(map).filter((v) => !!v && typeof v === 'object') : [];

/** No line longer than 75 octets of UTF-8; a continuation starts with a space, and no character is split. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  // Plain ASCII, as a photo's base64 is: a character is an octet, and there is nothing to measure.
  if (/^[\x00-\x7f]*$/.test(line)) {
    if (line.length <= 75) return line;
    const cut = [line.slice(0, 75)];
    for (let i = 75; i < line.length; i += 74) cut.push(` ${line.slice(i, i + 74)}`);
    return cut.join('\r\n');
  }
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n > 75) {
      out.push(current);
      current = ' ';
      size = 1;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n');
}

/** One card as vCard 4.0, CRLF line ends. What oinbox does not read (and other clients' extras) is not written. */
export function toVcard(card: ContactCard): string {
  const lines = ['BEGIN:VCARD', 'VERSION:4.0'];
  if (card.uid) lines.push(`UID:${plain(card.uid)}`);
  if (card.kind) lines.push(`KIND:${plain(card.kind)}`);
  lines.push(`FN:${escape(displayName(card))}`);

  const components = Array.isArray(card.name?.components) ? card.name.components.filter((c) => !!c && typeof c === 'object') : [];
  if (components.length) {
    const of = (kind: string) => components.filter((c) => c.kind === kind).map((c) => escape(str(c.value).trim())).filter(Boolean).join(',');
    lines.push(`N:${[of('surname'), of('given'), of('given2'), of('title'), of('credential')].join(';')}`);
  }
  const nicknames = nicknamesOf(card);
  if (nicknames.length) lines.push(`NICKNAME:${nicknames.map(escape).join(',')}`);

  for (const e of emailsOf(card)) {
    if (!e.address.trim()) continue;
    const type = e.label === 'work' ? ';TYPE=work' : e.label === 'personal' ? ';TYPE=home' : '';
    const pref = typeof card.emails?.[e.key]?.pref === 'number' ? `;PREF=${card.emails[e.key]!.pref}` : '';
    lines.push(`EMAIL${type}${pref}:${plain(e.address)}`);
  }
  for (const p of phonesOf(card)) {
    if (!p.number.trim()) continue;
    const fax = card.phones?.[p.key]?.features?.fax;
    const type = p.label === 'mobile' ? 'cell' : p.label === 'other' ? (fax ? 'fax' : '') : p.label;
    lines.push(`TEL${type ? `;TYPE=${type}` : ''}:${plain(p.number)}`);
  }
  for (const org of entries(card.organizations)) {
    const units = Array.isArray(org.units) ? org.units.map((u) => str(u?.name)) : [];
    const all = [str(org.name), ...units].map((x) => escape(x.trim()));
    if (all.some(Boolean)) lines.push(`ORG:${all.join(';')}`);
  }
  for (const title of entries(card.titles)) {
    if ((!title.kind || title.kind === 'title') && str(title.name).trim()) lines.push(`TITLE:${escape(str(title.name).trim())}`);
  }
  for (const a of addressesOf(card)) {
    const text = a.text.trim();
    if (!text) continue;
    const type = a.label === 'other' ? '' : `;TYPE=${a.label}`;
    // Kept here as one text: written as the label, which Stalwart reads back whole, and as the
    // street for programs that read only the parts.
    const label = text.replace(/\r\n|\n|\r/g, '\\n').replace(/"/g, "'");
    lines.push(`ADR${type};LABEL="${label}":;;${escape(text)};;;;`);
  }
  const born = birthdayOf(card);
  if (born) lines.push(`BDAY:${born.year === undefined ? '--' : String(born.year).padStart(4, '0')}${two(born.month)}${two(born.day)}`);
  for (const note of entries(card.notes)) if (str(note.note).trim()) lines.push(`NOTE:${escape(str(note.note).trim())}`);
  for (const link of entries(card.links)) if (str(link.uri).trim()) lines.push(`URL:${plain(str(link.uri))}`);
  const keywords = card.keywords && typeof card.keywords === 'object' ? Object.entries(card.keywords).filter(([, on]) => on === true).map(([k]) => escape(k)) : [];
  if (keywords.length) lines.push(`CATEGORIES:${keywords.join(',')}`);
  const photo = photoOf(card);
  if (photo) lines.push(`PHOTO:${plain(photo)}`);
  if (card.members && typeof card.members === 'object') {
    for (const [member, on] of Object.entries(card.members)) if (on === true) lines.push(`MEMBER:${plain(member)}`);
  }
  lines.push('END:VCARD');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function toVcards(cards: ContactCard[]): string {
  return cards.map(toVcard).join('');
}
