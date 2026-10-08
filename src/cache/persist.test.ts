import { beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../jmap/types';
import { clearCache, clearSnapshots, loadCachedSession, saveCachedSession } from './persist';

const session = { username: 'alice@example.test', accounts: {}, primaryAccounts: {} } as unknown as Session;

beforeEach(() => localStorage.clear());

describe('browser cache', () => {
  it('forgets the session on sign-out', async () => {
    saveCachedSession(session);
    await clearCache('alice@example.test');
    expect(loadCachedSession()).toBeNull();
  });
  it("keeps the session when only one mailbox's snapshot is dropped", async () => {
    saveCachedSession(session);
    await clearSnapshots('alice@example.test');
    expect(loadCachedSession()?.username).toBe('alice@example.test');
  });
});
