import { describe, expect, it } from 'vitest';
import { directoryIsFresh, DIRECTORY_MAX_AGE_MS, fromPrincipals, parseDirectoryCache } from './directory';

describe('fromPrincipals', () => {
  it('takes the display name from the description, and marks groups', () => {
    expect(
      fromPrincipals([
        { id: 'c', type: 'individual', name: 'bob@example.test', description: 'Bob Example', email: 'bob@example.test' },
        { id: 'g', type: 'group', name: 'support@example.test', description: ' Support ', email: 'support@example.test' },
      ]),
    ).toEqual([
      { email: 'bob@example.test', name: 'Bob Example', group: false },
      { email: 'support@example.test', name: 'Support', group: true },
    ]);
  });

  it('has no name for an account the administrator gave none', () => {
    expect(fromPrincipals([{ id: 'z', type: 'individual', name: 'dana@example.test', description: null, email: 'dana@example.test' }])).toEqual([
      { email: 'dana@example.test', name: '', group: false },
    ]);
  });

  it('leaves out what has no usable address, and an address listed twice', () => {
    expect(
      fromPrincipals([
        { id: 'a', type: 'individual', name: 'admin', description: 'Administrator', email: null },
        { id: 'b', type: 'individual', name: 'x', description: null, email: 'not-an-address' },
        { id: 'c', type: 'individual', name: 'bob@example.test', description: 'Bob', email: 'bob@example.test' },
        { id: 'd', type: 'individual', name: 'BOB@example.test', description: 'Bob again', email: 'BOB@example.test' },
        { id: 'e', type: 'resource', name: 'room@example.test', description: 'Room 1', email: 'room@example.test' },
      ]).map((e) => e.email),
    ).toEqual(['bob@example.test']);
  });
});

describe('the stored directory', () => {
  const entries = [{ email: 'bob@example.test', name: 'Bob', group: false }];

  it('is read back when it has the shape this version writes', () => {
    expect(parseDirectoryCache({ entries, fetchedAt: 5 })).toEqual({ entries, fetchedAt: 5 });
    for (const bad of [null, 'x', {}, { entries, fetchedAt: 'now' }, { entries: [{ email: 1 }], fetchedAt: 5 }, { entries: 'all', fetchedAt: 5 }]) {
      expect(parseDirectoryCache(bad)).toBeUndefined();
    }
  });

  it('is fresh for an hour', () => {
    expect(directoryIsFresh(1000, 1000 + DIRECTORY_MAX_AGE_MS - 1)).toBe(true);
    expect(directoryIsFresh(1000, 1000 + DIRECTORY_MAX_AGE_MS)).toBe(false);
    expect(DIRECTORY_MAX_AGE_MS).toBe(60 * 60 * 1000);
    // A clock set back must not keep an old list for ever.
    expect(directoryIsFresh(5000, 1000)).toBe(false);
  });
});
