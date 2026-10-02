import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SORT, MailEngine } from './engine';
import { FakeJmap } from './fake-jmap';
import { archivePatch, keywordPatch } from './patch';

const inboxSpec = { filter: { inMailbox: 'I' }, sort: DEFAULT_SORT, collapseThreads: true };

function setup(opts: { collapsedQueryChanges?: boolean; settleDelayMs?: number } = {}) {
  const server = new FakeJmap();
  server.addMailbox('I', 'Inbox', 'inbox');
  server.addMailbox('S', 'Sent', 'sent');
  server.addMailbox('A', 'Archive', 'archive');
  // Thread t1: Bob → Alice (Sent) → Bob. Thread t2: one message.
  server.addEmail({ id: 'e1', threadId: 't1', receivedAt: '2026-09-01T10:00:00Z', mailboxIds: { I: true }, keywords: { $seen: true } }, false);
  server.addEmail({ id: 'e2', threadId: 't1', receivedAt: '2026-09-01T11:00:00Z', mailboxIds: { S: true }, keywords: { $seen: true } }, false);
  server.addEmail({ id: 'e3', threadId: 't1', receivedAt: '2026-09-01T12:00:00Z', mailboxIds: { I: true } }, false);
  server.addEmail({ id: 'e4', threadId: 't2', receivedAt: '2026-09-01T09:00:00Z', mailboxIds: { I: true } }, false);
  const engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0, ...opts }));
  return { server, engine };
}

describe('MailEngine', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  beforeEach(async () => {
    ({ server, engine } = setup());
    await engine.start();
  });

  it('loads a collapsed thread list with every thread member in one request', async () => {
    const key = engine.openQuery(inboxSpec);
    server.calls = [];
    await engine.ensureRange(key, 0, 10);
    expect(server.calls).toEqual(['Email/query', 'Email/get', 'Thread/get', 'Email/get']);
    const q = engine.state.queries[key]!;
    expect(q.slots).toEqual(['e3', 'e4']);
    expect(q.total).toBe(2);
    // The Sent reply is known even though it isn't in the inbox.
    expect(engine.state.emails.e2?.mailboxIds).toEqual({ S: true });
    expect(engine.state.threads.t1?.emailIds).toEqual(['e1', 'e2', 'e3']);
  });

  it('applies new mail via Email/changes + Email/queryChanges when the server supports it', async () => {
    ({ server, engine } = setup({ collapsedQueryChanges: true }));
    await engine.start();
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    server.addEmail({ id: 'e5', threadId: 't3', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { I: true } });
    server.calls = [];
    await engine.catchUp();
    expect(server.calls).not.toContain('Email/query');
    expect(server.calls).toContain('Email/queryChanges');
    expect(engine.state.queries[key]!.slots).toEqual(['e5', 'e3', 'e4']);
    expect(engine.state.emails.e5?.subject).toBe('S e5');
  });

  it('by default re-reads only the visible window of a collapsed list after changes', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    server.addEmail({ id: 'e6', threadId: 't1', receivedAt: '2026-09-03T00:00:00Z', mailboxIds: { I: true } });
    server.calls = [];
    await engine.catchUp();
    expect(server.calls).not.toContain('Email/queryChanges');
    // A new reply replaces its thread's row rather than adding a second one.
    expect(engine.state.queries[key]!.slots).toEqual(['e6', 'e4']);
  });

  it('re-reads the window again after a delay, fixing late server ordering', async () => {
    vi.useFakeTimers();
    try {
      ({ server, engine } = setup({ settleDelayMs: 500 }));
      await engine.start();
      const key = engine.openQuery(inboxSpec);
      await engine.ensureRange(key, 0, 10);
      server.addEmail({ id: 'e7', threadId: 't9', receivedAt: '2026-09-04T00:00:00Z', mailboxIds: { I: true } });
      await engine.catchUp();
      server.calls = [];
      await vi.advanceTimersByTimeAsync(600);
      expect(server.calls).toContain('Email/query');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing to lists when no emails changed', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    server.calls = [];
    await engine.catchUp();
    expect(server.calls).not.toContain('Email/query');
  });

  it('falls back to refetching the visible window when queryChanges is unsupported', async () => {
    ({ server, engine } = setup({ collapsedQueryChanges: true }));
    await engine.start();
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    server.queryChangesUnsupported = true;
    server.addEmail({ id: 'e5', threadId: 't3', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { I: true } });
    await engine.catchUp();
    expect(engine.state.queries[key]!.slots).toEqual(['e5', 'e3', 'e4']);
  });

  it('fully resyncs when the server can no longer calculate type-level changes', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    expect(engine.state.queries[key]!.slots).toEqual(['e3', 'e4']);

    // Simulate a stale cursor: the server can no longer diff from our last-known state.
    server.changesUnsupported = true;
    server.addEmail({ id: 'e5', threadId: 't3', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { I: true } });
    await engine.catchUp();

    // A full resync ran (fresh Mailbox/get, not an incremental Email/changes), and the
    // previously-open query was reloaded from scratch rather than left stale or empty.
    expect(engine.state.mailboxes.I).toBeDefined();
    expect(engine.state.queries[key]!.slots).toEqual(['e5', 'e3', 'e4']);
    expect(engine.state.queries[key]!.queryState).toBeTruthy();
  });

  it('archives optimistically and keeps the change when the server accepts it', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    const p = engine.updateEmails(archivePatch(engine.threadEmails(['t1']), 'I', 'A'));
    // Gone from the inbox before the server answers.
    expect(engine.state.queries[key]!.slots).toEqual(['e4']);
    await p;
    expect(server.emails.get('e3')!.mailboxIds).toEqual({ A: true });
    await engine.catchUp();
    expect(engine.state.queries[key]!.slots).toEqual(['e4']);
  });

  it('rolls back rejected updates, restoring the row', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    server.rejectUpdates.add('e3');
    await expect(engine.updateEmails(archivePatch(engine.threadEmails(['t1']), 'I', 'A'))).rejects.toThrow('forbidden');
    expect(engine.state.queries[key]!.slots).toEqual(['e3', 'e4']);
    expect(engine.state.emails.e3!.mailboxIds).toEqual({ I: true });
  });

  it('marks a whole thread read', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    await engine.updateEmails(keywordPatch(engine.threadEmails(['t1']), '$seen', true));
    expect(engine.state.emails.e3!.keywords).toEqual({ $seen: true });
    expect(server.emails.get('e3')!.keywords).toEqual({ $seen: true });
  });

  it('loads a thread with bodies once and serves repeats from cache', async () => {
    await engine.loadThread('t1');
    server.calls = [];
    await engine.loadThread('t1');
    expect(server.calls).toEqual([]);
    expect(engine.state.bodies.e2).toBe(true);
  });

  it('snapshots and hydrates, then catches up from the saved states', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    const snap = engine.snapshot();
    const fresh = createRoot(() => new MailEngine(server.client(), { collapsedQueryChanges: true }));
    expect(fresh.hydrate(snap)).toBe(true);
    expect(fresh.state.queries[key]!.slots).toEqual(['e3', 'e4']);
    server.addEmail({ id: 'e5', threadId: 't3', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { I: true } });
    server.calls = [];
    await fresh.start();
    expect(server.calls).not.toContain('Email/query');
    expect(fresh.state.queries[key]!.slots).toEqual(['e5', 'e3', 'e4']);
  });

  it('reports merged emails through onEmails', async () => {
    const seen = new Set<string>();
    engine.onEmails = (emails) => emails.forEach((e) => seen.add(e.id!));
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    expect([...seen].sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('reports the emails of an applied snapshot through onEmails', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    const snap = engine.snapshot();
    const fresh = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    const seen: string[] = [];
    fresh.onEmails = (emails) => seen.push(...emails.map((e) => e.id!));
    expect(fresh.hydrate(snap)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.sort()).toEqual(Object.keys(snap.emails).sort());
  });

  it('reads the recipients of the newest Sent messages in one request', async () => {
    const to = [{ name: 'Bob Example', email: 'bob@example.test' }];
    const cc = [{ name: null, email: 'carol@partner.test' }];
    server.addEmail({ id: 's1', threadId: 't9', receivedAt: '2026-09-03T00:00:00Z', mailboxIds: { S: true }, to, cc }, false);
    server.calls = [];
    const list = await engine.sentRecipients(1);
    expect(server.calls).toEqual(['Email/query', 'Email/get']);
    // limit 1: only the newest Sent message, not the older e2.
    expect(list).toEqual([{ id: 's1', receivedAt: '2026-09-03T00:00:00Z', to, cc }]);
  });

  it('skips the Sent scan when the account has no Sent mailbox', async () => {
    const bare = new FakeJmap();
    bare.addMailbox('I', 'Inbox', 'inbox');
    const e = createRoot(() => new MailEngine(bare.client(), { settleDelayMs: 0 }));
    await e.start();
    bare.calls = [];
    expect(await e.sentRecipients(500)).toEqual([]);
    expect(bare.calls).toEqual([]);
  });
});

describe('MailEngine labels: create and rename', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  beforeEach(async () => {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    server.addMailbox('A', 'Archive', 'archive');
    server.addMailbox('W', 'Work');
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
  });

  it('creates a label and its missing ancestors in one Mailbox/set', async () => {
    server.calls = [];
    const id = await engine.createLabel({ parentId: 'W', ancestors: ['Clients'], name: 'Acme' });
    expect(server.calls).toEqual(['Mailbox/set']);
    const acme = engine.state.mailboxes[id]!;
    const clients = engine.state.mailboxes[acme.parentId!]!;
    expect([clients.name, clients.parentId, acme.name]).toEqual(['Clients', 'W', 'Acme']);
    expect(acme).toMatchObject({ role: null, isSubscribed: true, totalEmails: 0 });
    expect(server.mailboxes.get(id)).toMatchObject({ name: 'Acme', parentId: clients.id, isSubscribed: true });
  });

  it('throws the server\'s message when a create is refused', async () => {
    await expect(engine.createLabel({ parentId: null, ancestors: [], name: 'work' })).rejects.toThrow("A mailbox with name 'work' already exists.");
    expect(Object.keys(engine.state.mailboxes).sort()).toEqual(['A', 'I', 'W']);
  });

  it('renames a label in place with one request', async () => {
    server.calls = [];
    await engine.updateLabel('W', { parentId: null, ancestors: [], name: 'Jobs' });
    expect(server.calls).toEqual(['Mailbox/set']);
    expect(engine.state.mailboxes.W).toMatchObject({ name: 'Jobs', parentId: null });
    expect(server.mailboxes.get('W')?.name).toBe('Jobs');
  });

  it('moves a label under new ancestors, creating them first', async () => {
    server.calls = [];
    await engine.updateLabel('W', { parentId: null, ancestors: ['Old', '2025'], name: 'Work' });
    expect(server.calls).toEqual(['Mailbox/set', 'Mailbox/set']);
    const year = engine.state.mailboxes[engine.state.mailboxes.W!.parentId!]!;
    const old = engine.state.mailboxes[year.parentId!]!;
    expect([old.name, old.parentId, year.name]).toEqual(['Old', null, '2025']);
    expect(server.mailboxes.get('W')?.parentId).toBe(year.id);
  });

  it('throws the server\'s message when a rename is refused, leaving the store alone', async () => {
    await expect(engine.updateLabel('W', { parentId: null, ancestors: [], name: 'Archive' })).rejects.toThrow('already exists');
    expect(engine.state.mailboxes.W?.name).toBe('Work');
  });

  it('changes only the letter case of a name, which Stalwart refuses as a clash with itself', async () => {
    await engine.updateLabel('W', { parentId: null, ancestors: [], name: 'WORK' });
    expect(server.mailboxes.get('W')?.name).toBe('WORK');
    expect(engine.state.mailboxes.W?.name).toBe('WORK');
  });

  it('picks up a label renamed by another client', async () => {
    server.mailboxes.get('W')!.name = 'Renamed elsewhere';
    server.bumpMailbox({ updated: ['W'] });
    await engine.catchUp();
    expect(engine.state.mailboxes.W?.name).toBe('Renamed elsewhere');
  });
});

describe('MailEngine labels: delete', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  const workSpec = { filter: { inMailbox: 'W' }, sort: DEFAULT_SORT, collapseThreads: true };
  const mailboxSets = () => server.sent.filter(([n]) => n === 'Mailbox/set').map(([, a]) => a);

  function setup(withArchive = true) {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    if (withArchive) server.addMailbox('A', 'Archive', 'archive');
    server.addMailbox('W', 'Work');
    server.addEmail({ id: 'x1', threadId: 't1', receivedAt: '2026-09-01T10:00:00Z', mailboxIds: { W: true } }, false);
    server.addEmail({ id: 'x2', threadId: 't2', receivedAt: '2026-09-01T11:00:00Z', mailboxIds: { W: true, I: true } }, false);
    server.addEmail({ id: 'x3', threadId: 't3', receivedAt: '2026-09-01T12:00:00Z', mailboxIds: { I: true } }, false);
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
  }

  beforeEach(async () => {
    setup();
    await engine.start();
  });

  it('counts the emails that are in the label and nowhere else, asking for one id', async () => {
    expect(await engine.countOrphans('W')).toBe(1);
    const [, args] = server.sent.filter(([n]) => n === 'Email/query').pop()!;
    expect(args).toMatchObject({
      filter: { operator: 'AND', conditions: [{ inMailbox: 'W' }, { operator: 'NOT', conditions: [{ inMailboxOtherThan: ['W'] }] }] },
      limit: 1,
      calculateTotal: true,
    });
  });

  it('strips the label from its mail, archives the orphans, then destroys the mailbox', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    await engine.destroyLabel('W');
    expect(server.emails.get('x1')?.mailboxIds).toEqual({ A: true });
    expect(server.emails.get('x2')?.mailboxIds).toEqual({ I: true });
    expect(server.emails.get('x3')?.mailboxIds).toEqual({ I: true });
    expect(server.mailboxes.has('W')).toBe(false);
    expect(engine.state.mailboxes.W).toBeUndefined();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(engine.state.emails.x1?.mailboxIds).toEqual({ A: true });
  });

  it('never asks the server to remove the emails', async () => {
    await engine.destroyLabel('W');
    expect(mailboxSets().length).toBeGreaterThan(0);
    for (const args of mailboxSets()) expect(args.onDestroyRemoveEmails).not.toBe(true);
  });

  it('works through a large label a page at a time', async () => {
    for (let i = 0; i < 501; i++) {
      server.addEmail({ id: `b${i}`, threadId: `bt${i}`, receivedAt: '2026-08-01T00:00:00Z', mailboxIds: { W: true } }, false);
    }
    server.calls = [];
    await engine.destroyLabel('W');
    expect(server.calls.filter((c) => c === 'Email/set')).toHaveLength(2);
    expect([...server.emails.values()].filter((e) => e.mailboxIds?.W)).toHaveLength(0);
    expect(server.emails.get('b500')?.mailboxIds).toEqual({ A: true });
    expect(server.mailboxes.has('W')).toBe(false);
  });

  it('creates Archive when an orphan needs it and the account has none', async () => {
    setup(false);
    await engine.start();
    await engine.destroyLabel('W');
    const archive = [...server.mailboxes.values()].find((m) => m.role === 'archive');
    expect(archive).toBeDefined();
    expect(server.emails.get('x1')?.mailboxIds).toEqual({ [archive!.id]: true });
  });

  it('does not create Archive when no email would be orphaned', async () => {
    setup(false);
    server.emails.get('x1')!.mailboxIds = { W: true, I: true };
    await engine.start();
    await engine.destroyLabel('W');
    expect([...server.mailboxes.values()].some((m) => m.role === 'archive')).toBe(false);
  });

  it('sweeps once more when mail arrives during the delete', async () => {
    let arrived = false;
    server.onCall = (name, args) => {
      if (name !== 'Mailbox/set' || !args.destroy || arrived) return;
      arrived = true;
      server.addEmail({ id: 'late', threadId: 't9', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { W: true } });
    };
    await engine.destroyLabel('W');
    expect(server.emails.get('late')?.mailboxIds).toEqual({ A: true });
    expect(server.mailboxes.has('W')).toBe(false);
  });

  it('gives up, keeping the label, when mail keeps arriving', async () => {
    let n = 0;
    server.onCall = (name, args) => {
      if (name === 'Mailbox/set' && args.destroy) server.addEmail({ id: `late${n++}`, threadId: `lt${n}`, receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { W: true } });
    };
    await expect(engine.destroyLabel('W')).rejects.toThrow();
    expect(server.mailboxes.has('W')).toBe(true);
    expect(engine.state.mailboxes.W).toBeDefined();
    expect(server.emails.size).toBe(5); // nothing was destroyed
  });

  it('leaves the label in place when a page of updates is refused', async () => {
    server.rejectUpdates.add('x1');
    await expect(engine.destroyLabel('W')).rejects.toThrow('forbidden');
    expect(server.mailboxes.has('W')).toBe(true);
    expect(engine.state.mailboxes.W).toBeDefined();
    expect(server.emails.has('x1')).toBe(true);
  });

  it('succeeds when the label is already gone on the server', async () => {
    for (const e of server.emails.values()) delete e.mailboxIds!.W;
    server.emails.get('x1')!.mailboxIds = { A: true };
    server.mailboxes.delete('W');
    await engine.destroyLabel('W');
    expect(engine.state.mailboxes.W).toBeUndefined();
  });

  it('refuses before touching any mail when the server has a sub-label the store has not seen', async () => {
    server.addMailbox('K', 'Kid', null, 'W');
    server.calls = [];
    await expect(engine.destroyLabel('W')).rejects.toThrow('sub-labels');
    expect(server.calls).not.toContain('Email/set');
    expect(server.emails.get('x1')?.mailboxIds).toEqual({ W: true });
    expect(server.mailboxes.has('W')).toBe(true);
  });

  it('drops a label destroyed by another client, with its live query', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    const inboxKey = engine.openQuery(inboxSpec);
    await engine.ensureRange(inboxKey, 0, 10);
    for (const e of server.emails.values()) delete e.mailboxIds!.W;
    server.emails.get('x1')!.mailboxIds = { A: true };
    server.mailboxes.delete('W');
    server.bumpMailbox({ destroyed: ['W'] });
    await engine.catchUp();
    expect(engine.state.mailboxes.W).toBeUndefined();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(engine.state.queries[inboxKey]).toBeDefined();
  });

  it('is synced only after reconciling with the server, not straight from a snapshot', async () => {
    expect(engine.state.synced).toBe(true);
    const warm = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    expect(warm.hydrate(engine.snapshot())).toBe(true);
    expect(warm.state.ready).toBe(true);
    expect(warm.state.synced).toBe(false);
    await warm.start();
    expect(warm.state.synced).toBe(true);
  });
});
