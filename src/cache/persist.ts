import { createStore as createIdbStore, del, get, set, type UseStore } from 'idb-keyval';
import type { Session } from '../jmap/types';
import { parseRecipientCache, type RecipientCache } from '../mail/recipients';
import type { Snapshot } from '../sync/engine';

// Warm-start cache. Never the source of truth: everything here is reconciled
// with /changes right after load.

const SESSION_KEY = 'oinbox.session';
let store: UseStore | null = null;

function idb(): UseStore | null {
  try {
    store ??= createIdbStore('oinbox', 'kv');
    return store;
  } catch {
    return null;
  }
}

export function loadCachedSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
  } catch {
    return null;
  }
}

export function saveCachedSession(s: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // Storage full or blocked: warm start just won't be as warm.
  }
}

export async function loadSnapshot(username: string): Promise<Snapshot | undefined> {
  const s = idb();
  if (!s) return undefined;
  try {
    return await get<Snapshot>(`snap:${username}`, s);
  } catch {
    return undefined;
  }
}

export async function saveSnapshot(username: string, snap: Snapshot): Promise<void> {
  const s = idb();
  if (!s) return;
  try {
    await set(`snap:${username}`, snap, s);
  } catch {
    // Ignore: best effort.
  }
}

/** Sign-out: forget the session and what was stored under `key`. */
export async function clearCache(key: string): Promise<void> {
  localStorage.removeItem(SESSION_KEY);
  await clearSnapshots(key);
}

/** Drop one mailbox's snapshot and recipient cache, and nothing else: the session stays. */
export async function clearSnapshots(key: string): Promise<void> {
  const s = idb();
  if (!s) return;
  try {
    await del(`snap:${key}`, s);
    await del(`recipients:${key}`, s);
  } catch {
    // Ignore: best effort.
  }
}

export async function loadRecipients(username: string): Promise<RecipientCache | undefined> {
  const s = idb();
  if (!s) return undefined;
  try {
    return parseRecipientCache(await get<unknown>(`recipients:${username}`, s));
  } catch {
    return undefined;
  }
}

export async function saveRecipients(username: string, cache: RecipientCache): Promise<void> {
  const s = idb();
  if (!s) return;
  try {
    await set(`recipients:${username}`, cache, s);
  } catch {
    // Ignore: best effort.
  }
}

export async function loadImageAllowList(): Promise<string[]> {
  const s = idb();
  if (!s) return [];
  return (await get<string[]>('images:allow', s).catch(() => undefined)) ?? [];
}

export async function saveImageAllowList(list: string[]): Promise<void> {
  const s = idb();
  if (s) await set('images:allow', list, s).catch(() => undefined);
}
