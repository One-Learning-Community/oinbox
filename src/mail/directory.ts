// The organisation's people and groups, as the server lists them (JMAP Principals).
// Pure: no Solid, no JMAP.
import type { Principal } from '../jmap/types';

export interface DirectoryEntry {
  email: string;
  /** The display name the administrator gave, else ''. */
  name: string;
  /** A group account, such as a shared mailbox, and not a person. */
  group: boolean;
}

/** What is kept in IndexedDB: the list and when it was fetched (ms since the epoch). */
export interface DirectoryCache {
  entries: DirectoryEntry[];
  fetchedAt: number;
}

/** New accounts are rare, and the server cannot say when there is one: the list is fetched again once it is this old. */
export const DIRECTORY_MAX_AGE_MS = 60 * 60 * 1000;

export function directoryIsFresh(fetchedAt: number, now: number): boolean {
  return now >= fetchedAt && now - fetchedAt < DIRECTORY_MAX_AGE_MS;
}

/** People and groups that can be written to. Rooms and the like, and accounts with no address, are left out. */
export function fromPrincipals(list: Principal[]): DirectoryEntry[] {
  const seen = new Set<string>();
  const out: DirectoryEntry[] = [];
  for (const p of list) {
    if (p.type !== 'individual' && p.type !== 'group') continue;
    const email = p.email?.trim() ?? '';
    const key = email.toLowerCase();
    const at = key.lastIndexOf('@');
    if (at < 1 || at === key.length - 1 || seen.has(key)) continue;
    seen.add(key);
    out.push({ email, name: p.description?.trim() ?? '', group: p.type === 'group' });
  }
  return out;
}

/** A stored directory, if it has the shape this version writes; anything else is ignored. */
export function parseDirectoryCache(value: unknown): DirectoryCache | undefined {
  const c = value as Partial<DirectoryCache> | null | undefined;
  if (!c || typeof c !== 'object' || typeof c.fetchedAt !== 'number' || !Array.isArray(c.entries)) return undefined;
  const ok = c.entries.every((e) => e && typeof e.email === 'string' && typeof e.name === 'string' && typeof e.group === 'boolean');
  return ok ? { entries: c.entries, fetchedAt: c.fetchedAt } : undefined;
}
