// A saved person as oinbox reads and writes one: a JSContact Card (RFC 9553) the way Stalwart keeps it.
// Pure: no Solid, no JMAP.
import type { CardAddress, CardEmail, CardPhone, ContactCard, NameComponent, PartialDate } from '../jmap/types';

/** Stalwart's limit for one card, as JSON. */
export const MAX_CARD_BYTES = 524_288;

export type EmailLabel = 'work' | 'personal' | 'other';
export type PhoneLabel = 'mobile' | 'work' | 'home' | 'other';
export type AddressLabel = 'work' | 'home' | 'other';

export interface EmailView {
  key: string;
  address: string;
  label: EmailLabel;
  preferred: boolean;
}
export interface PhoneView {
  key: string;
  number: string;
  label: PhoneLabel;
}
export interface AddressView {
  key: string;
  text: string;
  label: AddressLabel;
}

/** What the contact dialog edits. A row with a `key` is an entry the card already has. */
export interface ContactForm {
  given: string;
  surname: string;
  /** A data: URI, or null for none. */
  photo: string | null;
  emails: { key?: string; address: string; label: EmailLabel; preferred: boolean }[];
  phones: { key?: string; number: string; label: PhoneLabel }[];
  organization: string;
  department: string;
  title: string;
  addresses: { key?: string; text: string; label: AddressLabel }[];
  birthday: { day: string; month: string; year: string };
  notes: string;
}

export type FormErrors = Partial<Record<'name' | 'birthday' | 'size' | `emails.${number}`, string>>;

/** The order a name is said in. A phone's card lists the surname first, so position means nothing. */
const NAME_ORDER = ['title', 'given', 'given2', 'surname', 'surname2', 'generation', 'credential'];

/**
 * Stalwart checks almost nothing it stores, and cards come from other clients and from imports: an
 * entry may be null, and a field may be missing or not text. One such card must not take the list,
 * the suggestions and every popover down with it.
 */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
/** The entries of a card's map that are objects at all. */
function rows<T>(map: Record<string, T> | undefined | null): [string, T][] {
  return map && typeof map === 'object' ? Object.entries(map).filter(([, v]) => !!v && typeof v === 'object') : [];
}
const parts = (components: NameComponent[] | undefined | null): NameComponent[] =>
  Array.isArray(components) ? components.filter((c) => !!c && typeof c === 'object').map((c) => ({ kind: text(c.kind), value: text(c.value) })) : [];

function fullName(components: NameComponent[] | undefined): string {
  const all = parts(components);
  return NAME_ORDER.flatMap((kind) => all.filter((c) => c.kind === kind).map((c) => c.value.trim()))
    .filter(Boolean)
    .join(' ');
}

export function isGroup(card: ContactCard): boolean {
  return card.kind === 'group';
}

/** "Roe, Sam" and "Sam Roe" are both Sam Roe; a single word is a given name. */
export function splitName(display: string): { given: string; surname: string } {
  const text = display.trim().replace(/\s+/g, ' ');
  const comma = text.indexOf(',');
  if (comma > 0) return { given: text.slice(comma + 1).trim(), surname: text.slice(0, comma).trim() };
  const space = text.lastIndexOf(' ');
  return space < 0 ? { given: text, surname: '' } : { given: text.slice(0, space), surname: text.slice(space + 1) };
}

export function nameParts(card: ContactCard): { given: string; surname: string } {
  const components = parts(card.name?.components);
  if (!components.length) return splitName(text(card.name?.full));
  const of = (kind: string) => components.find((c) => c.kind === kind)?.value.trim() ?? '';
  return { given: of('given'), surname: of('surname') };
}

const emailLabel = (e: CardEmail): EmailLabel => (e.contexts?.work ? 'work' : e.contexts?.private ? 'personal' : 'other');
const phoneLabel = (p: CardPhone): PhoneLabel =>
  p.features?.mobile || p.features?.cell ? 'mobile' : p.contexts?.work ? 'work' : p.contexts?.private ? 'home' : 'other';
const addressLabel = (a: CardAddress): AddressLabel => (a.contexts?.work ? 'work' : a.contexts?.private ? 'home' : 'other');
const addressText = (a: CardAddress): string =>
  typeof a.full === 'string' ? a.full : parts(a.components).filter((c) => c.kind !== 'separator').map((c) => c.value).join(', ');

/** The preferred address first, then as stored. */
export function emailsOf(card: ContactCard): EmailView[] {
  const entries = rows(card.emails);
  let best: string | undefined = entries[0]?.[0];
  let lowest = Infinity;
  for (const [key, e] of entries) {
    if (typeof e.pref === 'number' && e.pref < lowest) {
      lowest = e.pref;
      best = key;
    }
  }
  const views = entries.map(([key, e]) => ({ key, address: text(e.address), label: emailLabel(e), preferred: key === best }));
  return [...views.filter((v) => v.preferred), ...views.filter((v) => !v.preferred)];
}

export function phonesOf(card: ContactCard): PhoneView[] {
  return rows(card.phones).map(([key, p]) => ({ key, number: text(p.number), label: phoneLabel(p) }));
}

export function addressesOf(card: ContactCard): AddressView[] {
  return rows(card.addresses).map(([key, a]) => ({ key, text: addressText(a), label: addressLabel(a) }));
}

const isJobTitle = (t: { kind?: string }) => !t.kind || t.kind === 'title';

export function organizationOf(card: ContactCard): { name: string; department: string; title: string } {
  const org = rows(card.organizations)[0]?.[1];
  const title = rows(card.titles).map(([, t]) => t).find(isJobTitle);
  const unit = Array.isArray(org?.units) ? org.units[0] : undefined;
  return { name: text(org?.name).trim(), department: text(unit?.name).trim(), title: text(title?.name).trim() };
}

const birthEntry = (card: ContactCard): [string, PartialDate] | undefined => {
  for (const [key, a] of rows(card.anniversaries)) {
    const date = a.date as PartialDate | undefined;
    if (a.kind === 'birth' && date && typeof date.month === 'number' && typeof date.day === 'number') return [key, date];
  }
  return undefined;
};

export function birthdayOf(card: ContactCard): { day: number; month: number; year?: number } | null {
  const date = birthEntry(card)?.[1];
  if (!date) return null;
  return { day: date.day!, month: date.month!, ...(typeof date.year === 'number' ? { year: date.year } : {}) };
}

export function notesOf(card: ContactCard): string {
  return rows(card.notes).map(([, n]) => text(n.note)).filter(Boolean).join('\n\n');
}

const photoEntry = (card: ContactCard): [string, string] | undefined => {
  for (const [key, m] of rows(card.media)) {
    if (m.kind === 'photo' && text(m.uri).startsWith('data:image/')) return [key, m.uri!];
  }
  return undefined;
};

/** The photo kept in the card. One another client stored as a web address is never fetched. */
export function photoOf(card: ContactCard): string | null {
  return photoEntry(card)?.[1] ?? null;
}

export function nicknamesOf(card: ContactCard): string[] {
  return rows(card.nicknames).map(([, n]) => text(n.name).trim()).filter(Boolean);
}

/** What the card holds that the dialog does not edit, for showing as it is. */
export function extrasOf(card: ContactCard): { label: string; values: string[] }[] {
  const out: { label: string; values: string[] }[] = [];
  const add = (label: string, values: unknown[]) => {
    const kept = values.map((v) => text(v).trim()).filter(Boolean);
    if (kept.length) out.push({ label, values: kept });
  };
  add('Nickname', nicknamesOf(card));
  add('Links', rows(card.links).map(([, l]) => l.uri));
  add('Online', rows(card.onlineServices).map(([, s]) => (text(s.service) && text(s.user) ? `${s.service}: ${s.user}` : (s.uri ?? s.user))));
  add('Keywords', Object.keys(card.keywords && typeof card.keywords === 'object' ? card.keywords : {}));
  add('Name', parts(card.name?.components).filter((c) => c.kind !== 'given' && c.kind !== 'surname' && c.kind !== 'separator').map((c) => c.value));
  return out;
}

/** Never empty: a card with nothing to call it by is still listed. */
export function displayName(card: ContactCard): string {
  return (
    fullName(card.name?.components) ||
    text(card.name?.full).trim() ||
    organizationOf(card).name ||
    emailsOf(card)[0]?.address.trim() ||
    phonesOf(card)[0]?.number.trim() ||
    'No name'
  );
}

/** The form for an existing card, or an empty one, perhaps started from a name and address seen in mail. */
export function toForm(card?: ContactCard, seed?: { name?: string; email?: string }): ContactForm {
  if (!card) {
    return {
      ...splitName(seed?.name ?? ''),
      photo: null,
      emails: seed?.email ? [{ address: seed.email, label: 'other', preferred: true }] : [],
      phones: [],
      organization: '',
      department: '',
      title: '',
      addresses: [],
      birthday: { day: '', month: '', year: '' },
      notes: '',
    };
  }
  const org = organizationOf(card);
  const born = birthdayOf(card);
  return {
    ...nameParts(card),
    photo: photoOf(card),
    emails: emailsOf(card),
    phones: phonesOf(card),
    organization: org.name,
    department: org.department,
    title: org.title,
    addresses: addressesOf(card),
    birthday: born ? { day: String(born.day), month: String(born.month), year: born.year === undefined ? '' : String(born.year) } : { day: '', month: '', year: '' },
    notes: notesOf(card),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const whole = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

function formBirthday(form: ContactForm): { day: number; month: number; year?: number } | null | 'invalid' {
  const { day, month, year } = form.birthday;
  if (!day.trim() && !month.trim() && !year.trim()) return null;
  const d = whole(day, 1, 31);
  const m = whole(month, 1, 12);
  const y = year.trim() ? whole(year, 1, 9999) : undefined;
  if (d === null || m === null || y === null) return 'invalid';
  return { day: d, month: m, ...(y === undefined ? {} : { year: y }) };
}

/** What the server would accept but should not be saved. Blank rows are dropped, not faulted. */
export function validateForm(form: ContactForm): FormErrors {
  const errors: FormErrors = {};
  const named = [form.given, form.surname, form.organization, ...form.emails.map((e) => e.address)].some((t) => t.trim());
  if (!named) errors.name = 'Give a name, an organisation or an email address.';
  form.emails.forEach((e, i) => {
    if (e.address.trim() && !EMAIL.test(e.address.trim())) errors[`emails.${i}`] = 'This is not an email address.';
  });
  if (formBirthday(form) === 'invalid') errors.birthday = 'Give both a day and a month.';
  return errors;
}

type Maps = Pick<ContactCard, 'name' | 'emails' | 'phones' | 'organizations' | 'titles' | 'addresses' | 'anniversaries' | 'notes' | 'media'>;
const MAP_PROPS = ['emails', 'phones', 'organizations', 'titles', 'addresses', 'anniversaries', 'notes', 'media'] as const;

const clone = <T>(v: T): T => structuredClone(v);

/** The first of prefix1, prefix2, … that `taken` does not hold; it is added to `taken`. */
function freeKey(prefix: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const key = `${prefix}${i}`;
    if (!taken.has(key)) {
      taken.add(key);
      return key;
    }
  }
}

/**
 * A map of rows rebuilt from the form: entries the card has keep their place and whatever else they
 * hold, rows the user removed are gone, new rows follow under fresh keys.
 */
function rebuild<S extends object, R extends { key?: string }>(
  stored: Record<string, S> | undefined,
  rows: R[],
  prefix: string,
  write: (row: R, base: S | undefined) => S,
): Record<string, S> {
  const old = stored ?? {};
  const taken = new Set(Object.keys(old));
  const out: Record<string, S> = {};
  for (const key of Object.keys(old)) {
    const row = rows.find((r) => r.key === key);
    if (row) out[key] = write(row, clone(old[key]!));
  }
  for (const row of rows) {
    if (row.key === undefined || !(row.key in old)) out[freeKey(prefix, taken)] = write(row, undefined);
  }
  return out;
}

function withContexts<T extends { contexts?: Record<string, boolean> }>(entry: T, context: 'work' | 'private' | null): T {
  if (context) entry.contexts = { [context]: true };
  else delete entry.contexts;
  return entry;
}

function nextName(card: ContactCard | undefined, form: ContactForm): ContactCard['name'] {
  const given = form.given.trim();
  const surname = form.surname.trim();
  if (card) {
    const cur = nameParts(card);
    if (cur.given === given && cur.surname === surname) return card.name;
  }
  const others = parts(card?.name?.components).filter((c) => c.kind !== 'given' && c.kind !== 'surname');
  const components = [...others, ...(given ? [{ kind: 'given', value: given }] : []), ...(surname ? [{ kind: 'surname', value: surname }] : [])];
  if (!components.length) return { full: '' };
  const rank = (c: NameComponent) => (NAME_ORDER.indexOf(c.kind) + 1 || NAME_ORDER.length + 1);
  components.sort((a, b) => rank(a) - rank(b));
  return { components, isOrdered: true, full: fullName(components) };
}

function nextEmails(card: ContactCard | undefined, form: ContactForm): Record<string, CardEmail> {
  const rows = form.emails.filter((e) => e.address.trim());
  const emails = rebuild<CardEmail, (typeof rows)[number]>(card?.emails, rows, 'e', (row, base) => {
    const entry: CardEmail = { ...base, address: row.address.trim() };
    if (!base || emailLabel(base) !== row.label) withContexts(entry, row.label === 'work' ? 'work' : row.label === 'personal' ? 'private' : null);
    return entry;
  });
  // The mark is rewritten only when the user moved it: a card with no `pref` at all stays as it is.
  const chosen = rows.find((r) => r.preferred) ?? rows[0];
  const was = card ? emailsOf(card).find((e) => e.preferred)?.key : undefined;
  if (chosen && (chosen.key === undefined || chosen.key !== was)) {
    const keys = Object.keys(emails);
    const chosenKey = keys.find((k) => emails[k]!.address === chosen.address.trim() && (chosen.key === undefined ? !(k in (card?.emails ?? {})) : k === chosen.key));
    for (const k of keys) {
      if (k === chosenKey && keys.length > 1) emails[k]!.pref = 1;
      else delete emails[k]!.pref;
    }
  }
  return emails;
}

function nextPhones(card: ContactCard | undefined, form: ContactForm): Record<string, CardPhone> {
  const rows = form.phones.filter((p) => p.number.trim());
  return rebuild<CardPhone, (typeof rows)[number]>(card?.phones, rows, 'p', (row, base) => {
    const entry: CardPhone = { ...base, number: row.number.trim() };
    if (base && phoneLabel(base) === row.label) return entry;
    if (row.label === 'mobile') entry.features = { ...entry.features, mobile: true };
    else {
      if (entry.features) {
        const { mobile: _m, cell: _c, ...rest } = entry.features;
        if (Object.keys(rest).length) entry.features = rest;
        else delete entry.features;
      }
      withContexts(entry, row.label === 'work' ? 'work' : row.label === 'home' ? 'private' : null);
    }
    return entry;
  });
}

function nextAddresses(card: ContactCard | undefined, form: ContactForm): Record<string, CardAddress> {
  const rows = form.addresses.filter((a) => a.text.trim());
  return rebuild<CardAddress, (typeof rows)[number]>(card?.addresses, rows, 'a', (row, base) => {
    let entry: CardAddress;
    if (base && addressText(base) === row.text) entry = base;
    else {
      // The parts would contradict the new text.
      const { components: _c, isOrdered: _o, countryCode: _cc, ...rest } = base ?? {};
      entry = { ...rest, full: row.text.trim() };
    }
    if (!base || addressLabel(base) !== row.label) withContexts(entry, row.label === 'work' ? 'work' : row.label === 'home' ? 'private' : null);
    return entry;
  });
}

/** One entry of a map replaced or removed, the others untouched. */
function withEntry<S>(stored: Record<string, S> | undefined, key: string, value: S | null): Record<string, S> {
  const out = clone(stored ?? {});
  if (value === null) delete out[key];
  else out[key] = value;
  return out;
}

function nextMaps(card: ContactCard | undefined, form: ContactForm): Maps {
  const orgKey = Object.keys(card?.organizations ?? {})[0] ?? 'o1';
  const org = card?.organizations?.[orgKey];
  const name = form.organization.trim();
  const department = form.department.trim();
  const { name: _n, units: _u, ...orgRest } = org ?? {};
  const units = [...(department ? [{ name: department }] : []), ...(org?.units ?? []).slice(1)];
  const nextOrg = name || department ? { ...orgRest, ...(name ? { name } : {}), ...(units.length ? { units } : {}) } : null;

  const titleKey = rows(card?.titles).find(([, t]) => isJobTitle(t))?.[0] ?? freeKey('t', new Set(Object.keys(card?.titles ?? {})));
  const title = form.title.trim();
  const nextTitle = title ? { kind: 'title', ...card?.titles?.[titleKey], name: title } : null;

  const born = card ? birthEntry(card) : undefined;
  const bornKey = born?.[0] ?? freeKey('b', new Set(Object.keys(card?.anniversaries ?? {})));
  const want = formBirthday(form);
  const same = !!born && want !== null && want !== 'invalid' && born[1].day === want.day && born[1].month === want.month && born[1].year === want.year;
  const nextBorn =
    want === null || want === 'invalid'
      ? null
      : same
        ? card!.anniversaries![bornKey]!
        : { kind: 'birth', date: { '@type': 'PartialDate' as const, ...(want.year === undefined ? {} : { year: want.year }), month: want.month, day: want.day } };

  const notes = form.notes.trim();
  const noteKey = Object.keys(card?.notes ?? {})[0] ?? 'n1';
  const nextNotes = card && notes === notesOf(card).trim() ? clone(card.notes ?? {}) : notes ? { [noteKey]: { ...card?.notes?.[noteKey], note: notes } } : {};

  const photo = card ? photoEntry(card) : undefined;
  const photoKey = photo?.[0] ?? freeKey('m', new Set(Object.keys(card?.media ?? {})));
  const nextMedia =
    form.photo === (photo?.[1] ?? null) ? clone(card?.media ?? {}) : withEntry(card?.media, photoKey, form.photo ? { kind: 'photo', uri: form.photo } : null);

  return {
    name: nextName(card, form),
    emails: nextEmails(card, form),
    phones: nextPhones(card, form),
    organizations: withEntry(card?.organizations, orgKey, nextOrg),
    titles: withEntry(card?.titles, titleKey, nextTitle),
    addresses: nextAddresses(card, form),
    anniversaries: withEntry(card?.anniversaries, bornKey, nextBorn),
    notes: nextNotes,
    media: nextMedia,
  };
}

/** JSON with object keys in order, so that two values holding the same things compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

const isEmpty = (map: object | undefined) => !map || !Object.keys(map).length;

/** A card to create. The server adds no uid and no dates of its own. */
export function newCard(form: ContactForm, bookId: string, now: string, uid: string): Partial<ContactCard> {
  const maps = nextMaps(undefined, form);
  const card: Partial<ContactCard> = { '@type': 'Card', version: '1.0', uid, kind: 'individual', created: now, updated: now, addressBookIds: { [bookId]: true } };
  if (maps.name?.components?.length) card.name = maps.name;
  for (const prop of MAP_PROPS) if (!isEmpty(maps[prop])) (card as Record<string, unknown>)[prop] = maps[prop];
  return card;
}

/**
 * What a save sends: the properties the form changed, each whole (Stalwart refuses a patch below a
 * property the card lacks), `null` for one that was emptied. Empty when nothing changed.
 */
export function patchFor(card: ContactCard, form: ContactForm, now: string): Record<string, unknown> {
  const maps = nextMaps(card, form);
  const patch: Record<string, unknown> = {};
  if (stable(maps.name) !== stable(card.name)) patch.name = maps.name;
  for (const prop of MAP_PROPS) {
    const next = maps[prop];
    const stored = card[prop];
    if (isEmpty(next)) {
      if (!isEmpty(stored)) patch[prop] = null;
    } else if (stable(next) !== stable(stored)) patch[prop] = next;
  }
  if (Object.keys(patch).length) patch.updated = now;
  return patch;
}

export function cardBytes(card: unknown): number {
  return new TextEncoder().encode(JSON.stringify(card)).length;
}
