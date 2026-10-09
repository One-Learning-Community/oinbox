/** How long a Drive link's password can be read back in the tab that made the link. */
export const RECALL_MS = 30 * 60_000;

const KEY = 'oinbox.drive.linkPasswords';

export interface Recalled {
  url: string;
  password: string;
  /** When it will be forgotten, in milliseconds since the epoch. */
  until: number;
}

const valid = (e: unknown): e is Recalled =>
  !!e && typeof e === 'object' && typeof (e as Recalled).url === 'string' && typeof (e as Recalled).password === 'string' && typeof (e as Recalled).until === 'number';

/**
 * The passwords of Drive links made in this tab, kept for half an hour: OpenCloud never gives one
 * back, and a password copied to be sent another way is easily lost to the next copy. Pass
 * sessionStorage: it ends with the tab and is not shared with other tabs or devices.
 */
export function createLinkPasswords(storage: Storage, now: () => number = Date.now) {
  const write = (entries: Recalled[]) => {
    try {
      if (entries.length) storage.setItem(KEY, JSON.stringify(entries));
      else storage.removeItem(KEY);
    } catch {
      // Storage that is full or switched off: the password is simply not kept.
    }
  };
  /** What is still remembered. Whatever has run out is removed from the storage as it is found. */
  const live = (): Recalled[] => {
    let all: Recalled[] = [];
    try {
      const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
      all = Array.isArray(raw) ? raw.filter(valid) : [];
    } catch {
      all = [];
    }
    const kept = all.filter((e) => e.until > now());
    if (kept.length !== all.length) write(kept);
    return kept;
  };

  return {
    remember: (url: string, password: string) => write([...live().filter((e) => e.url !== url), { url, password, until: now() + RECALL_MS }]),
    recall: (url: string): Recalled | null => live().find((e) => e.url === url) ?? null,
    /** The remembered links this text mentions. */
    findIn: (text: string): Recalled[] => live().filter((e) => text.includes(e.url)),
    clear: () => {
      try {
        storage.removeItem(KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

export type LinkPasswords = ReturnType<typeof createLinkPasswords>;
