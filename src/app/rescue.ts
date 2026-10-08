import type { RescuedComposer } from './composer';

const PREFIX = 'oinbox.rescue.';
const MAX_AGE_MS = 7 * 24 * 3600_000;

interface Stored { savedAt: number; composer: RescuedComposer }

function keys(storage: Storage): string[] {
  try {
    return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => !!k && k.startsWith(PREFIX));
  } catch {
    return [];
  }
}

function remove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Blocked storage: nothing to remove.
  }
}

/** Unsaved composer text, kept across an involuntary sign-out. Best effort: storage may be full or blocked. */
export function saveRescue(storage: Storage, accountId: string, items: RescuedComposer[], now = Date.now()): void {
  items.forEach((composer, i) => {
    try {
      storage.setItem(`${PREFIX}${accountId}.${i}`, JSON.stringify({ savedAt: now, composer } satisfies Stored));
    } catch {
      // Keep going: a smaller draft may still fit.
    }
  });
}

/** This account's rescued composers, removed as they are read. Expired entries of any account go too. */
export function takeRescue(storage: Storage, accountId: string, now = Date.now()): RescuedComposer[] {
  const out: RescuedComposer[] = [];
  for (const key of keys(storage).sort()) {
    let stored: Stored | null = null;
    try {
      stored = JSON.parse(storage.getItem(key) ?? 'null') as Stored | null;
    } catch {
      stored = null;
    }
    const mine = key.startsWith(`${PREFIX}${accountId}.`);
    const expired = !stored || now - stored.savedAt > MAX_AGE_MS;
    if (mine || expired) remove(storage, key);
    if (mine && !expired && stored) out.push(stored.composer);
  }
  return out;
}

export function clearRescue(storage: Storage): void {
  for (const key of keys(storage)) remove(storage, key);
}
