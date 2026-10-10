import { createSignal } from 'solid-js';
import { loadDirectory, saveDirectory } from '../cache/persist';
import type { Principal } from '../jmap/types';
import { directoryIsFresh, fromPrincipals, type DirectoryEntry } from '../mail/directory';

/** After a fetch that failed, the next is not tried for this long: typing must not hammer a server that is down. */
const RETRY_MS = 60 * 1000;

export interface Directory {
  /** Reactive: the organisation's people and groups, empty until known. */
  entries(): DirectoryEntry[];
  /** Read the stored list, then fetch if it is missing or old. Rejects if that fetch fails. */
  start(key: string): Promise<void>;
  /** Fetch again if the list is over an hour old. Cheap to call often; a failure is kept quiet. */
  refresh(): void;
}

/** The organisation's directory for recipient suggestions: fetched whole, kept for an hour, stored for the next start. */
export function createDirectory(fetchPrincipals: () => Promise<Principal[]>, opts: { now?: () => number } = {}): Directory {
  const now = opts.now ?? Date.now;
  const [entries, setEntries] = createSignal<DirectoryEntry[]>([]);
  let key: string | null = null;
  let fetchedAt: number | null = null;
  let failedAt: number | null = null;
  let running: Promise<void> | null = null;

  const due = () => {
    if (key === null) return false;
    if (failedAt !== null && now() - failedAt < RETRY_MS && now() >= failedAt) return false;
    return fetchedAt === null || !directoryIsFresh(fetchedAt, now());
  };

  const fetchNow = (): Promise<void> => {
    const storeUnder = key!;
    running ??= fetchPrincipals()
      .then(
        (list) => {
          const fresh = fromPrincipals(list);
          fetchedAt = now();
          failedAt = null;
          setEntries(fresh);
          void saveDirectory(storeUnder, { entries: fresh, fetchedAt });
        },
        (e) => {
          failedAt = now();
          throw e;
        },
      )
      .finally(() => (running = null));
    return running;
  };

  return {
    entries,
    start: async (storageKey) => {
      key = storageKey;
      const cache = await loadDirectory(storageKey);
      if (cache && fetchedAt === null) {
        fetchedAt = cache.fetchedAt;
        setEntries(cache.entries);
      }
      if (due()) await fetchNow();
    },
    refresh: () => {
      if (due()) fetchNow().catch(() => {});
    },
  };
}
