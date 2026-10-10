import { escapeHtml } from '../mail/sanitize';

/** How long a message's Drive folder is remembered: as long as the longest expiry a link is offered. */
export const KEEP_MS = 90 * 86_400_000;
const MOST = 100;

const KEY = 'oinbox.drive.linkFolders';

/** The folder made in Drive for one message, and the link to it that went into the message's text. */
export interface LinkFolder {
  url: string;
  path: string[];
  id: string;
  /** When the link stops working, in milliseconds since the epoch, if it does. */
  expires?: number | undefined;
  /** When it was made, in milliseconds since the epoch. */
  madeAt: number;
}

const valid = (e: unknown): e is LinkFolder => {
  const f = e as LinkFolder;
  return !!e && typeof e === 'object' && typeof f.url === 'string' && typeof f.id === 'string' && typeof f.madeAt === 'number' && Array.isArray(f.path) && f.path.every((p) => typeof p === 'string');
};

/** Whether this text of a message has the link in it. */
export const mentions = (html: string, url: string): boolean => html.includes(url) || html.includes(escapeHtml(url));

/**
 * The Drive folders of messages not yet sent, by the link each has in its text: a draft that is
 * closed and opened again, or rescued after a sign-out, is a new composer, and its text is all that
 * says which folder is its own. Pass localStorage: a draft can be reopened days later. Another
 * browser knows nothing of it, and there the folder stays when the draft is discarded.
 */
export function createLinkFolders(storage: Storage, now: () => number = Date.now) {
  const write = (entries: LinkFolder[]) => {
    try {
      if (entries.length) storage.setItem(KEY, JSON.stringify(entries.slice(-MOST)));
      else storage.removeItem(KEY);
    } catch {
      // Storage that is full or switched off: the folder is known only while its composer is open.
    }
  };
  const live = (): LinkFolder[] => {
    let all: LinkFolder[] = [];
    try {
      const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
      all = Array.isArray(raw) ? raw.filter(valid) : [];
    } catch {
      all = [];
    }
    const kept = all.filter((e) => now() - e.madeAt < KEEP_MS);
    if (kept.length !== all.length) write(kept);
    return kept;
  };

  return {
    remember: (f: LinkFolder) => write([...live().filter((e) => e.url !== f.url), f]),
    forget: (url: string) => write(live().filter((e) => e.url !== url)),
    /** The folder whose link this text has in it, if it is one of those remembered. */
    findIn: (html: string): LinkFolder | null => live().find((e) => mentions(html, e.url)) ?? null,
    clear: () => {
      try {
        storage.removeItem(KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

export type LinkFolders = ReturnType<typeof createLinkFolders>;
