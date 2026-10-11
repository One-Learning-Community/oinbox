// Importing vCards: the browser has cut the file into cards; the server reads each one
// (Blob/upload + ContactCard/parse) and the result is saved (ContactCard/set).
import { MAX_CARD_BYTES, cardBytes, displayName } from '../contacts/card';
import { UnauthorizedError, type JmapClient } from '../jmap/client';
import { BLOB, CONTACTS, CONTACTS_PARSE, CORE, type ContactCard, type Id, type ParsedCard } from '../jmap/types';

/** One card of a file, as text, with what was told of it without parsing. */
export interface VcardBlock {
  text: string;
  name: string;
  uid: string;
  /** Import under a new uid: a card with this one exists, and the user wants this one as well. */
  freshUid?: boolean;
}

export interface ImportResult {
  imported: number;
  failed: { name: string; error: string }[];
  /** Stopped by the user. */
  cancelled: boolean;
  /** Set when the server's upload allowance ran out: its own words, and the seconds until it is back if it said. */
  quota?: { message: string; retryAfter: number | null };
  /** Cards not sent at all: after a stop, a lost connection, or the allowance running out. */
  left: number;
}

export interface ImportOptions {
  /** Cards dealt with so far, of how many. Called after every batch. */
  onProgress?: (done: number, total: number) => void;
  /** Checked before each batch: what is saved stays. */
  signal?: AbortSignal;
}

/** Stalwart's limits: 10 blobs a parse, and a request of 10 MB at most. */
const PARSE_IDS = 10;
const BATCH_CARDS = 100;
const BATCH_CHARS = 4_000_000;
const MAX_BLOCK_CHARS = 7_000_000;
const SET_BYTES = 4_500_000;
const USING = [CORE, BLOB, CONTACTS, CONTACTS_PARSE];

interface Deps {
  accountId: () => Id | undefined;
  bookId: () => Id | undefined;
  now: () => string;
  uid: () => string;
  /** Bring what was saved into the store. */
  catchUp: () => Promise<void>;
}

/** What Stalwart's parser leaves under `vCard` and does not understand: a group as Apple's Contacts writes one. */
function appleGroup(card: ParsedCard): void {
  const props = Array.isArray(card.vCard?.properties) ? card.vCard.properties : [];
  const values = (name: string) => props.filter((p) => Array.isArray(p) && p[0] === name).map((p) => String(p[3] ?? '').trim()).filter(Boolean);
  if (!card.kind && values('x-addressbookserver-kind').some((k) => k.toLowerCase() === 'group')) card.kind = 'group';
  const members = values('x-addressbookserver-member');
  if (members.length) card.members = { ...card.members, ...Object.fromEntries(members.map((m) => [m, true])) };
}

export function createImporter(client: JmapClient, deps: Deps) {
  /** A parsed card made ready to save. */
  const prepare = (parsed: ParsedCard, block: VcardBlock, bookId: Id, newUids: Map<VcardBlock, string>, moved: Map<string, string>): Partial<ContactCard> => {
    appleGroup(parsed);
    const { vCard: _v, ...card } = parsed;
    const now = deps.now();
    card['@type'] = 'Card';
    card.version ??= '1.0';
    card.kind ??= 'individual';
    card.uid = newUids.get(block) ?? (card.uid || deps.uid());
    card.created ??= now;
    card.updated ??= now;
    card.addressBookIds = { [bookId]: true };
    if (card.members) card.members = Object.fromEntries(Object.entries(card.members).map(([key, on]) => [moved.get(key) ?? key, on]));
    if (cardBytes(card) > MAX_CARD_BYTES && card.media) {
      // Almost always the photo. Without it the person is still saved.
      const media = Object.fromEntries(Object.entries(card.media).filter(([, m]) => !String(m?.uri ?? '').startsWith('data:')));
      if (Object.keys(media).length) card.media = media;
      else delete card.media;
    }
    return card;
  };

  /** One batch: upload, parse, save. Throws when a request fails as a whole. */
  const importBatch = async (accountId: Id, bookId: Id, batch: VcardBlock[], newUids: Map<VcardBlock, string>, moved: Map<string, string>) => {
    const failed: { name: string; error: string }[] = [];
    const b = client.batch();
    const upload = b.call('Blob/upload', { accountId, create: Object.fromEntries(batch.map((block, i) => [`b${i}`, { data: [{ 'data:asText': block.text }], type: 'text/vcard' }])) });
    const chunks: number[][] = [];
    for (let i = 0; i < batch.length; i += PARSE_IDS) chunks.push(batch.slice(i, i + PARSE_IDS).map((_, j) => i + j));
    const parses = chunks.map((chunk) => b.call('ContactCard/parse', { accountId, blobIds: chunk.map((i) => `#b${i}`) }));
    const res = await client.send(b, USING);
    const uploaded = res.get(upload);
    const blobOf = (i: number): Id | undefined => uploaded.created?.[`b${i}`]?.id;

    let quota: string | undefined;
    for (const [key, err] of Object.entries(uploaded.notCreated ?? {})) {
      if (err.type === 'overQuota') quota ??= err.description ?? 'The upload limit was reached.';
      else failed.push({ name: batch[Number(key.slice(1))]!.name, error: err.description ?? `The server refused the card (${err.type}).` });
    }

    const parsed: Record<string, ParsedCard> = {};
    const again: number[] = [];
    parses.forEach((call, n) => {
      // A parse fails whole when one of its blobs was refused: those that were made are asked for again.
      if (res.error(call)) again.push(...chunks[n]!.filter((i) => blobOf(i)));
      else Object.assign(parsed, res.get(call).parsed ?? {});
    });
    for (let i = 0; i < again.length; i += PARSE_IDS * 15) {
      const b2 = client.batch();
      const part = again.slice(i, i + PARSE_IDS * 15);
      const calls = [];
      for (let j = 0; j < part.length; j += PARSE_IDS) calls.push(b2.call('ContactCard/parse', { accountId, blobIds: part.slice(j, j + PARSE_IDS).map((k) => blobOf(k)!) }));
      const res2 = await client.send(b2, USING);
      for (const call of calls) Object.assign(parsed, res2.get(call).parsed ?? {});
    }

    const cards: { card: Partial<ContactCard>; name: string }[] = [];
    batch.forEach((block, i) => {
      const blob = blobOf(i);
      if (!blob) return;
      const got = parsed[blob];
      if (!got) return void failed.push({ name: block.name, error: 'This card could not be read.' });
      const card = prepare(got, block, bookId, newUids, moved);
      cards.push({ card, name: displayName(card as ContactCard) === 'No name' ? block.name : displayName(card as ContactCard) });
    });

    let imported = 0;
    for (let i = 0; i < cards.length; ) {
      // Up to 100 cards of half a megabyte each would be too much for one request.
      const create: Record<string, Partial<ContactCard>> = {};
      let bytes = 0;
      const first = i;
      for (; i < cards.length; i++) {
        const size = cardBytes(cards[i]!.card);
        if (i > first && bytes + size > SET_BYTES) break;
        create[`c${i}`] = cards[i]!.card;
        bytes += size;
      }
      const b3 = client.batch();
      const set = b3.call('ContactCard/set', { accountId, create });
      const saved = (await client.send(b3, [CORE, CONTACTS])).get(set);
      imported += Object.keys(saved.created ?? {}).length;
      for (const [key, err] of Object.entries(saved.notCreated ?? {})) {
        failed.push({ name: cards[Number(key.slice(1))]!.name, error: err.description ?? `The server refused the card (${err.type}).` });
      }
    }
    const sent = batch.filter((_, i) => blobOf(i)).length + Object.values(uploaded.notCreated ?? {}).filter((e) => e.type !== 'overQuota').length;
    return { imported, failed, quota, sent };
  };

  return async (blocks: VcardBlock[], opts: ImportOptions = {}): Promise<ImportResult> => {
    const result: ImportResult = { imported: 0, failed: [], cancelled: false, left: 0 };
    const accountId = deps.accountId();
    const bookId = deps.bookId();
    const total = blocks.length;
    if (!accountId || !bookId) return { ...result, left: total, failed: [{ name: 'Import', error: accountId ? 'Your contacts have not loaded yet.' : 'Contacts are not available.' }] };

    // New uids are settled before anything is sent, so a group can be pointed at a copy that comes after it in the file.
    const newUids = new Map<VcardBlock, string>();
    const moved = new Map<string, string>();
    for (const block of blocks) {
      if (!block.freshUid) continue;
      const fresh = deps.uid();
      newUids.set(block, fresh);
      if (block.uid && !moved.has(block.uid)) moved.set(block.uid, fresh);
    }

    let at = 0;
    let done = 0;
    while (at < total) {
      if (opts.signal?.aborted) {
        result.cancelled = true;
        break;
      }
      const batch: VcardBlock[] = [];
      let chars = 0;
      while (at < total && batch.length < BATCH_CARDS) {
        const block = blocks[at]!;
        if (block.text.length > MAX_BLOCK_CHARS) {
          result.failed.push({ name: block.name, error: 'This card is too large to import.' });
          at++;
          done++;
          continue;
        }
        if (batch.length && chars + block.text.length > BATCH_CHARS) break;
        batch.push(block);
        chars += block.text.length;
        at++;
      }
      if (batch.length) {
        try {
          const out = await importBatch(accountId, bookId, batch, newUids, moved);
          result.imported += out.imported;
          result.failed.push(...out.failed);
          done += out.sent;
          if (out.quota) {
            result.quota = { message: out.quota, retryAfter: await client.uploadRetryAfter(accountId) };
            at -= batch.length - out.sent;
            opts.onProgress?.(done, total);
            break;
          }
        } catch (e) {
          if (e instanceof UnauthorizedError) throw e;
          // The connection, or the server as a whole: nothing more is tried.
          result.failed.push(...batch.map((block) => ({ name: block.name, error: (e as Error).message })));
          break;
        }
      }
      opts.onProgress?.(done, total);
    }
    result.left = total - at;
    await deps.catchUp().catch((e: unknown) => {
      if (e instanceof UnauthorizedError) throw e;
    });
    return result;
  };
}
