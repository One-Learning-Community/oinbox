import { batch, createSignal } from 'solid-js';
import { loadRecipients, saveRecipients } from '../cache/persist';
import type { EmailAddress } from '../jmap/types';
import { add, compareRecipients, suggest as rank, type ContactKind, type Recipient, type RecipientCache, type RecipientIndex } from '../mail/recipients';
import type { MailEngine } from '../sync/engine';

const SUGGESTIONS = 6;
const SCAN_LIMIT = 500;
const MAX_ENTRIES = 2000;
const MAX_COUNTED = 5000;
const SAVE_MS = 5000;

export interface Recipients {
  /** Reactive. `exclude` holds lower-cased addresses. */
  suggest(query: string, exclude: Set<string>): Recipient[];
  /** The recipients of a message that was just sent. */
  recordSent(emailId: string, addresses: EmailAddress[]): void;
  /** Load the user's cached index; emails reported earlier are counted once it is in. */
  start(username: string): Promise<void>;
  /** Read the recipients of recent Sent mail. Rejects if the request fails. */
  scanSent(): Promise<void>;
  stop(): void;
}

/** Recipient suggestions from mail history: Sent recipients, senders of synced mail, and messages just sent. */
export function createRecipients(engine: MailEngine, opts: { saveDelayMs?: number } = {}): Recipients {
  const index: RecipientIndex = {};
  /** Ids of emails already counted, oldest first. */
  const counted = new Set<string>();
  const [version, setVersion] = createSignal(0);
  const saveDelayMs = opts.saveDelayMs ?? SAVE_MS;
  let username: string | null = null;
  /** Work that arrived before the cache was loaded; null once it is. */
  let pending: (() => void)[] | null = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const snapshot = (): RecipientCache => ({
    index: Object.fromEntries(
      Object.values(index).sort(compareRecipients).slice(0, MAX_ENTRIES).map((r) => [r.email.toLowerCase(), r]),
    ),
    counted: [...counted].slice(-MAX_COUNTED),
  });

  const saveSoon = () => {
    if (stopped || saveTimer || !username) return;
    const user = username;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!stopped) void saveRecipients(user, snapshot());
    }, saveDelayMs);
  };

  const whenLoaded = (fn: () => void) => {
    if (pending) pending.push(fn);
    else fn();
  };

  const count = (emailId: string, addresses: EmailAddress[], kind: ContactKind, at: string) => {
    if (counted.has(emailId)) return;
    counted.add(emailId);
    const me = engine.myAddresses();
    add(index, addresses.filter((a) => !me.has(a.email.toLowerCase())), kind, at);
    setVersion((v) => v + 1);
    saveSoon();
  };

  engine.onEmails = (emails) =>
    whenLoaded(() =>
      batch(() => {
        const me = engine.myAddresses();
        for (const e of emails) {
          const from = e.from?.[0];
          // The user's own mail is counted by its recipients (the Sent scan), not by its sender.
          if (!e.id || !from || !e.receivedAt || e.keywords?.$draft || me.has(from.email.toLowerCase())) continue;
          count(e.id, [from], 'received', e.receivedAt);
        }
      }),
    );

  return {
    suggest: (query, exclude) => {
      version();
      if (!query.trim()) return [];
      return rank(index, query, { exclude: new Set([...exclude, ...engine.myAddresses()]), limit: SUGGESTIONS });
    },
    recordSent: (emailId, addresses) => whenLoaded(() => count(emailId, addresses, 'sent', new Date().toISOString())),
    start: async (user) => {
      username = user;
      const cache = await loadRecipients(user);
      if (cache) {
        Object.assign(index, cache.index);
        for (const id of cache.counted) counted.add(id);
      }
      const queued = pending ?? [];
      pending = null;
      for (const fn of queued) fn();
      setVersion((v) => v + 1);
    },
    scanSent: async () => {
      const emails = await engine.sentRecipients(SCAN_LIMIT);
      whenLoaded(() =>
        batch(() => {
          for (const e of emails) {
            if (e.id && e.receivedAt) count(e.id, [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])], 'sent', e.receivedAt);
          }
        }),
      );
    },
    stop: () => {
      stopped = true;
      if (saveTimer) clearTimeout(saveTimer);
    },
  };
}
