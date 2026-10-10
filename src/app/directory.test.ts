import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDirectory, saveDirectory } from '../cache/persist';
import type { Principal } from '../jmap/types';
import { DIRECTORY_MAX_AGE_MS } from '../mail/directory';
import { FakeJmap } from '../sync/fake-jmap';
import { createDirectory } from './directory';

vi.mock('../cache/persist', () => ({
  loadDirectory: vi.fn(async () => undefined),
  saveDirectory: vi.fn(async () => undefined),
}));

const bob: Principal = { id: 'c', type: 'individual', name: 'bob@example.test', description: 'Bob Example', email: 'bob@example.test' };
const support: Principal = { id: 'g', type: 'group', name: 'support@example.test', description: 'Support', email: 'support@example.test' };
const bobEntry = { email: 'bob@example.test', name: 'Bob Example', group: false };

function setup(list: Principal[] = [bob, support]) {
  let time = 1_000_000;
  const fetch = vi.fn(async () => list);
  const directory = createRoot(() => createDirectory(fetch, { now: () => time }));
  return { fetch, directory, later: (ms: number) => (time += ms) };
}

describe('createDirectory', () => {
  beforeEach(() => {
    vi.mocked(loadDirectory).mockReset().mockResolvedValue(undefined);
    vi.mocked(saveDirectory).mockClear();
  });

  it('fetches the list on a first start and stores it with the time', async () => {
    const { fetch, directory } = setup();
    expect(directory.entries()).toEqual([]);
    await directory.start('alice:a1');
    expect(directory.entries()).toEqual([bobEntry, { email: 'support@example.test', name: 'Support', group: true }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(saveDirectory).toHaveBeenCalledWith('alice:a1', { entries: directory.entries(), fetchedAt: 1_000_000 });
  });

  it('uses a stored list under an hour old without asking the server', async () => {
    vi.mocked(loadDirectory).mockResolvedValue({ entries: [bobEntry], fetchedAt: 1_000_000 - DIRECTORY_MAX_AGE_MS + 1 });
    const { fetch, directory } = setup();
    await directory.start('alice:a1');
    expect(directory.entries()).toEqual([bobEntry]);
    expect(fetch).not.toHaveBeenCalled();
    expect(loadDirectory).toHaveBeenCalledWith('alice:a1');
  });

  it('shows an old stored list at once and replaces it from the server', async () => {
    vi.mocked(loadDirectory).mockResolvedValue({ entries: [{ email: 'gone@example.test', name: 'Gone', group: false }], fetchedAt: 1_000_000 - DIRECTORY_MAX_AGE_MS });
    const { fetch, directory } = setup([bob]);
    await directory.start('alice:a1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(directory.entries()).toEqual([bobEntry]);
  });

  it('refresh asks again only once the hour is up, and once however often it is called', async () => {
    const { fetch, directory, later } = setup();
    await directory.start('alice:a1');
    later(DIRECTORY_MAX_AGE_MS - 1);
    directory.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    later(1);
    directory.refresh();
    directory.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(saveDirectory).toHaveBeenCalledTimes(2));
    directory.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does nothing before it is started', () => {
    const { fetch, directory } = setup();
    directory.refresh();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps what it has when a fetch fails, says so from start, and waits a minute to try again', async () => {
    vi.mocked(loadDirectory).mockResolvedValue({ entries: [bobEntry], fetchedAt: 1_000_000 - DIRECTORY_MAX_AGE_MS });
    const { fetch, directory, later } = setup();
    fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(directory.start('alice:a1')).rejects.toThrow('offline');
    expect(directory.entries()).toEqual([bobEntry]);
    directory.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    later(60_000);
    directory.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(directory.entries()).toHaveLength(2));
  });
});

describe('JmapClient.principals', () => {
  it('reads the whole directory, a page at a time', async () => {
    const server = new FakeJmap();
    server.principals = Array.from({ length: 1001 }, (_, i) => ({ id: `p${i}`, type: 'individual', name: `u${i}@example.test`, description: `User ${i}`, email: `u${i}@example.test` }));
    const list = await server.client().principals();
    expect(list).toHaveLength(1001);
    expect(list[1000]).toEqual(server.principals[1000]);
    expect(server.calls).toEqual(['Principal/query', 'Principal/get', 'Principal/query', 'Principal/get', 'Principal/query', 'Principal/get']);
    expect(server.sent[2]![1]).toMatchObject({ position: 500, limit: 500 });
  });

  it('is empty, with nothing asked, where the server has no directory', async () => {
    const server = new FakeJmap();
    expect(await server.client().principals()).toEqual([]);
    expect(server.calls).toEqual([]);
  });
});
