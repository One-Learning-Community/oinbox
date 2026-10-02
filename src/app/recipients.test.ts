import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRecipients, saveRecipients } from '../cache/persist';
import { DEFAULT_SORT, MailEngine } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import { createRecipients } from './recipients';

vi.mock('../cache/persist', () => ({
  loadRecipients: vi.fn(async () => undefined),
  saveRecipients: vi.fn(async () => undefined),
}));

const ME = 'alice@example.test';
const bob = { name: 'Bob Example', email: 'bob@example.test' };
const inbox = { filter: { inMailbox: 'I' }, sort: DEFAULT_SORT, collapseThreads: true };
const nobody = new Set<string>();

function setup() {
  const server = new FakeJmap();
  server.addMailbox('I', 'Inbox', 'inbox');
  server.addMailbox('S', 'Sent', 'sent');
  // Sent: alice wrote to Bob (also cc'd, to check he counts once) and Dana.
  server.addEmail({
    id: 's1', threadId: 't1', receivedAt: '2026-09-02T10:00:00Z', mailboxIds: { S: true },
    from: [{ name: 'Alice', email: ME }], to: [bob], cc: [{ name: null, email: 'BOB@example.test' }, { name: 'Dana', email: 'dana@example.test' }],
  }, false);
  // Inbox: Carol wrote to alice.
  server.addEmail({ id: 'r1', threadId: 't2', receivedAt: '2026-09-03T10:00:00Z', mailboxIds: { I: true }, from: [{ name: 'Carol Nguyen', email: 'carol@partner.test' }] }, false);
  const engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
  const store = createRecipients(engine, { saveDelayMs: 0 });
  return { server, engine, store };
}

async function openInbox(engine: MailEngine) {
  const key = engine.openQuery(inbox);
  await engine.ensureRange(key, 0, 10);
}

describe('createRecipients', () => {
  beforeEach(() => {
    vi.mocked(loadRecipients).mockReset().mockResolvedValue(undefined);
    vi.mocked(saveRecipients).mockReset().mockResolvedValue(undefined);
  });

  it('fills the index from the Sent scan, counting a person once per message', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await store.scanSent();
    expect(store.suggest('bob', nobody)).toEqual([{ email: 'bob@example.test', name: 'Bob Example', sent: 1, received: 0, last: '2026-09-02T10:00:00Z' }]);
    expect(store.suggest('dan', nobody).map((r) => r.email)).toEqual(['dana@example.test']);
  });

  it('adds the senders of merged emails', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await openInbox(engine);
    expect(store.suggest('car', nobody)).toEqual([{ email: 'carol@partner.test', name: 'Carol Nguyen', sent: 0, received: 1, last: '2026-09-03T10:00:00Z' }]);
  });

  it('counts an email once across a scan, a repeated scan, a merge, a reload and recordSent', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await store.scanSent();
    await store.scanSent();
    store.recordSent('s1', [bob]);
    await openInbox(engine);
    await openInbox(engine);
    await engine.loadThread('t2');
    expect(store.suggest('bob', nobody)[0]!.sent).toBe(1);
    expect(store.suggest('car', nobody)[0]!.received).toBe(1);
  });

  it('skips the user\'s own addresses and drafts', async () => {
    const { server, engine, store } = setup();
    server.addEmail({ id: 'm1', threadId: 't3', receivedAt: '2026-09-04T10:00:00Z', mailboxIds: { I: true }, from: [{ name: 'Alice', email: ME }] }, false);
    server.addEmail({ id: 'd1', threadId: 't4', receivedAt: '2026-09-04T11:00:00Z', mailboxIds: { I: true }, keywords: { $draft: true }, from: [{ name: 'Dave', email: 'dave@partner.test' }] }, false);
    await engine.start();
    await store.start(ME);
    await openInbox(engine);
    store.recordSent('x1', [{ name: 'Alice', email: ME }]);
    expect(store.suggest('ali', nobody)).toEqual([]);
    expect(store.suggest('dav', nobody)).toEqual([]);
  });

  it('leaves out excluded addresses', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await store.scanSent();
    expect(store.suggest('bob', new Set(['bob@example.test']))).toEqual([]);
  });

  it('holds back emails reported before the cache has loaded, then counts them once', async () => {
    vi.mocked(loadRecipients).mockResolvedValue({
      index: { 'carol@partner.test': { email: 'carol@partner.test', name: 'Carol Nguyen', sent: 0, received: 1, last: '2026-09-03T10:00:00Z' } },
      counted: ['r1'],
    });
    const { engine, store } = setup();
    await engine.start();
    await openInbox(engine); // reports r1 before the cache is loaded
    expect(store.suggest('car', nobody)).toEqual([]);
    await store.start(ME);
    expect(store.suggest('car', nobody)[0]!.received).toBe(1);
  });

  it('counts emails reported before the cache has loaded when the cache does not know them', async () => {
    const { engine, store } = setup();
    await engine.start();
    await openInbox(engine);
    await store.start(ME);
    expect(store.suggest('car', nobody)[0]!.received).toBe(1);
  });

  it('stays usable when the scan fails', async () => {
    const { engine, store } = setup();
    vi.spyOn(engine, 'sentRecipients').mockRejectedValueOnce(new Error('boom'));
    await engine.start();
    await store.start(ME);
    await expect(store.scanSent()).rejects.toThrow('boom');
    store.recordSent('n1', [{ name: 'Eve', email: 'eve@example.test' }]);
    expect(store.suggest('eve', nobody).map((r) => r.email)).toEqual(['eve@example.test']);
  });

  it('saves the index and the counted ids under the username', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    await store.scanSent();
    await vi.waitFor(() => expect(saveRecipients).toHaveBeenCalled());
    const [user, cache] = vi.mocked(saveRecipients).mock.calls.at(-1)!;
    expect(user).toBe(ME);
    expect(Object.keys(cache.index).sort()).toEqual(['bob@example.test', 'dana@example.test']);
    expect(cache.counted).toContain('s1');
  });

  it('does not save after stop()', async () => {
    const { engine, store } = setup();
    await engine.start();
    await store.start(ME);
    store.stop();
    store.recordSent('n1', [bob]);
    await new Promise((r) => setTimeout(r, 20));
    expect(saveRecipients).not.toHaveBeenCalled();
  });
});
