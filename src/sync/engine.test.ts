import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VACATION } from '../jmap/types';
import { DEFAULT_SORT, DraftSaveError, MailEngine, SetFailure } from './engine';
import { fakeClient, FakeJmap } from './fake-jmap';
import { archivePatch, keywordPatch, unlabelPatch } from './patch';

const inboxSpec = { filter: { inMailbox: 'I' }, sort: DEFAULT_SORT, collapseThreads: true };
/** The engine's remembered viewport ranges: private, but the only trace a revived dead query leaves. */
const rangesOf = (e: MailEngine) => (e as unknown as { ranges: Map<string, unknown> }).ranges;

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

  it('reports arrivals in an account whose lists were never opened', async () => {
    const arrived: string[][] = [];
    engine.onArrived = (emails) => arrived.push(emails.map((e) => e.id));
    server.addEmail({ id: 'e5', threadId: 't3', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { I: true } });
    await engine.catchUp();
    expect(arrived).toEqual([['e5']]);
  });

  it('reports mail that arrived since the last catch-up, once', async () => {
    const arrived: string[][] = [];
    engine.onArrived = (emails) => arrived.push(emails.map((e) => e.id));
    // Changes are followed from the state the first list was read at.
    await engine.ensureRange(engine.openQuery(inboxSpec), 0, 10);
    server.addEmail({ id: 'e5', threadId: 't3', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { I: true } });
    await engine.catchUp();
    expect(arrived).toEqual([['e5']]);
    // A change to mail already here is not an arrival.
    await engine.catchUp();
    expect(arrived).toEqual([['e5']]);
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

  it('updates a mailbox in place, so what is rendered from it is not rebuilt', async () => {
    const before = engine.state.mailboxes.W;
    server.mailboxes.get('W')!.name = 'Renamed elsewhere';
    server.bumpMailbox({ updated: ['W'] });
    await engine.catchUp();
    expect(engine.state.mailboxes.W?.name).toBe('Renamed elsewhere');
    expect(engine.state.mailboxes.W).toBe(before);
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

  it('brings the store in line with the server when the sweep stops halfway', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    server.rejectUpdates.add('x1');
    await expect(engine.destroyLabel('W')).rejects.toThrow('forbidden');
    // x2 did lose the label on the server: the store must not wait for a push to say so.
    expect(server.emails.get('x2')?.mailboxIds).toEqual({ I: true });
    expect(engine.state.emails.x2?.mailboxIds).toEqual({ I: true });
    expect(engine.state.queries[key]!.slots).toEqual(['x1']);
  });

  it('carries on when an email of the page was deleted elsewhere in the meantime', async () => {
    server.onCall = (name) => {
      if (name === 'Email/set' && server.emails.delete('x1')) server.bump({ destroyed: ['x1'] });
    };
    await engine.destroyLabel('W');
    expect(server.mailboxes.has('W')).toBe(false);
    expect(server.emails.get('x2')?.mailboxIds).toEqual({ I: true });
  });

  it('refuses to rename or delete a system mailbox, sending nothing', async () => {
    server.calls = [];
    await expect(engine.updateLabel('I', { parentId: null, ancestors: [], name: 'Mine' })).rejects.toThrow("'Inbox' is a system mailbox.");
    await expect(engine.destroyLabel('I')).rejects.toThrow("'Inbox' is a system mailbox.");
    expect(server.calls).toEqual([]);
  });

  it('refuses to delete a mailbox the server has since given a role, before touching its mail', async () => {
    server.mailboxes.get('W')!.role = 'junk';
    server.calls = [];
    await expect(engine.destroyLabel('W')).rejects.toThrow("'Work' is a system mailbox.");
    expect(server.calls).not.toContain('Email/set');
    expect(server.emails.get('x1')?.mailboxIds).toEqual({ W: true });
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

  const destroyWorkElsewhere = () => {
    for (const e of server.emails.values()) delete e.mailboxIds!.W;
    server.emails.get('x1')!.mailboxIds = { A: true };
    server.mailboxes.delete('W');
  };

  it('drops the query of a label that vanished while the change cursor was stale', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    const inboxKey = engine.openQuery(inboxSpec);
    await engine.ensureRange(inboxKey, 0, 10);
    destroyWorkElsewhere();
    server.changesUnsupported = true;
    await engine.catchUp();
    expect(engine.state.mailboxes.W).toBeUndefined();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(rangesOf(engine).has(key)).toBe(false);
    expect(engine.state.queries[inboxKey]!.slots).toEqual(['x3', 'x2']);
  });

  it('reports a failed page load as itself when the list was closed meanwhile', async () => {
    const key = engine.openQuery(workSpec);
    server.onCall = (name) => {
      if (name !== 'Email/query') return;
      engine.closeQuery(key, () => false);
      throw new Error('boom');
    };
    await expect(engine.ensureRange(key, 0, 10)).rejects.toThrow('boom');
  });

  it('rolls back a refused update when a list it had changed was closed meanwhile', async () => {
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    server.rejectUpdates.add('x2');
    server.onCall = (name) => {
      if (name === 'Email/set') engine.closeQuery(key, () => false);
    };
    await expect(engine.updateEmails(unlabelPatch(engine.threadEmails(['t2']), 'W', 'A'))).rejects.toThrow('forbidden');
    expect(engine.state.emails.x2?.mailboxIds).toEqual({ W: true, I: true });
  });

  it('leaves alone the query changes of a label destroyed in the same round', async () => {
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0, collapsedQueryChanges: true }));
    await engine.start();
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    destroyWorkElsewhere();
    server.bumpMailbox({ destroyed: ['W'] });
    server.queryChangesUnsupported = true;
    server.calls = [];
    await engine.catchUp();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(rangesOf(engine).has(key)).toBe(false);
    expect(server.calls).not.toContain('Email/query');
  });

  it('does not revive a list closed while another one was being reloaded', async () => {
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0, collapsedQueryChanges: true }));
    await engine.start();
    const inboxKey = engine.openQuery(inboxSpec);
    await engine.ensureRange(inboxKey, 0, 10);
    const key = engine.openQuery(workSpec);
    await engine.ensureRange(key, 0, 10);
    server.queryChangesUnsupported = true;
    // Both lists must be reloaded. The first reload's request closes the second list.
    server.onCall = (name) => {
      if (name === 'Email/query') engine.closeQuery(key, () => false);
    };
    await engine.catchUp();
    expect(engine.state.queries[key]).toBeUndefined();
    expect(rangesOf(engine).has(key)).toBe(false);
    expect(engine.state.queries[inboxKey]!.queryState).toBeTruthy();
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

describe('MailEngine settings', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  const value = { name: 'Support', email: 'alice@example.test', htmlSignature: '<b>S</b>', textSignature: 'S' };

  beforeEach(async () => {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    await vi.waitFor(() => expect(engine.state.vacationLoad).toBe('ready'));
  });

  it('creates an identity and adds it to the store', async () => {
    const id = await engine.createIdentity(value);
    expect(engine.state.identities.map((i) => i.id)).toEqual(['id1', id]);
    expect(engine.state.identities[1]).toMatchObject({ ...value, mayDelete: true, replyTo: null, bcc: null });
  });

  it('shares one round trip between overlapping settings refreshes', async () => {
    server.calls = [];
    await Promise.all([engine.refreshSettings(), engine.refreshSettings()]);
    expect(server.calls.filter((c) => c === 'Identity/get')).toHaveLength(1);
    expect(server.calls.filter((c) => c === 'VacationResponse/get')).toHaveLength(1);
  });

  it('throws a SetFailure carrying the type and property', async () => {
    const err = await engine.createIdentity({ ...value, email: 'bob@example.test' }).catch((e) => e);
    expect(err).toBeInstanceOf(SetFailure);
    expect(err).toMatchObject({ type: 'invalidProperties', properties: ['email'], message: 'E-mail address not configured for this account.' });
    expect(engine.state.identities).toHaveLength(1);
  });

  it('updates name and signatures only', async () => {
    await engine.updateIdentity('id1', { name: 'A', htmlSignature: '<i>x</i>', textSignature: 'x' });
    const [, args] = server.sent.findLast(([n]) => n === 'Identity/set')!;
    expect(args.update).toEqual({ id1: { name: 'A', htmlSignature: '<i>x</i>', textSignature: 'x' } });
    expect(engine.state.identities[0]).toMatchObject({ name: 'A', htmlSignature: '<i>x</i>', textSignature: 'x' });
  });

  it('destroys an identity, treats notFound as done, and refuses the only one locally', async () => {
    const id = await engine.createIdentity(value);
    server.identities.delete(id);
    await engine.destroyIdentity(id);
    expect(engine.state.identities.map((i) => i.id)).toEqual(['id1']);
    server.calls = [];
    await expect(engine.destroyIdentity('id1')).rejects.toThrow('This is your only identity.');
    expect(server.calls).toEqual([]);
  });

  it('refetches identities on an Identity push from elsewhere, but not after its own write', async () => {
    await engine.updateIdentity('id1', { name: 'Mine', htmlSignature: '', textSignature: '' });
    server.calls = [];
    engine.onStateChange({ '@type': 'StateChange', changed: { a1: { Identity: `i${server.identityState}` } } });
    await Promise.resolve();
    expect(server.calls).toEqual([]);
    server.identities.get('id1')!.name = 'Elsewhere';
    server.identityState++;
    engine.onStateChange({ '@type': 'StateChange', changed: { a1: { Identity: `i${server.identityState}` } } });
    await vi.waitFor(() => expect(engine.state.identities[0]!.name).toBe('Elsewhere'));
  });

  it('loads the vacation response at start with the capability in using', () => {
    expect(engine.state.vacation).toMatchObject({ id: 'singleton', isEnabled: false });
    expect(server.usings.some((u) => u.includes(VACATION))).toBe(true);
    expect(server.usings.filter((u) => !u.includes(VACATION)).length).toBeGreaterThan(0);
  });

  it('updates the vacation response and reloads it on a SieveScript push from elsewhere only', async () => {
    await engine.updateVacation({ isEnabled: true, textBody: 'Away' });
    expect(engine.state.vacation).toMatchObject({ isEnabled: true, textBody: 'Away', subject: null });
    server.calls = [];
    engine.onStateChange({ '@type': 'StateChange', changed: { a1: { SieveScript: `v${server.vacationState}` } } });
    await Promise.resolve();
    expect(server.calls).toEqual([]);
    server.vacation = { ...server.vacation, isEnabled: false };
    server.vacationState++;
    engine.onStateChange({ '@type': 'StateChange', changed: { a1: { SieveScript: `v${server.vacationState}` } } });
    await vi.waitFor(() => expect(engine.state.vacation?.isEnabled).toBe(false));
  });

  it('marks the vacation responder unsupported without the capability, and failed when the load fails', async () => {
    const s2 = new FakeJmap();
    s2.vacationSupported = false;
    const e2 = createRoot(() => new MailEngine(s2.client(), { settleDelayMs: 0 }));
    await e2.start();
    await vi.waitFor(() => expect(e2.state.vacationLoad).toBe('unsupported'));
    expect(s2.calls).not.toContain('VacationResponse/get');

    const s3 = new FakeJmap();
    s3.onCall = (name) => {
      if (name === 'VacationResponse/get') throw new Error('down');
    };
    const e3 = createRoot(() => new MailEngine(s3.client(), { settleDelayMs: 0 }));
    await e3.start();
    await vi.waitFor(() => expect(e3.state.vacationLoad).toBe('failed'));
  });

  it('does not put the vacation response in the snapshot', async () => {
    let snap: unknown;
    engine.onPersist = (s) => (snap = s);
    await engine.createIdentity(value);
    await vi.waitFor(() => expect(snap).toBeTruthy(), { timeout: 3000 });
    expect(JSON.stringify(snap)).not.toContain('singleton');
  });
});

describe('draftState', () => {
  it('tells a draft from a sent message from a deleted one', async () => {
    const { server, engine } = setup();
    server.addEmail({ id: 'd1', threadId: 't9', receivedAt: '2026-09-02T10:00:00Z', mailboxIds: { I: true }, keywords: { $draft: true } }, false);
    server.addEmail({ id: 's1', threadId: 't10', receivedAt: '2026-09-02T11:00:00Z', mailboxIds: { S: true }, keywords: { $seen: true } }, false);
    await engine.start();
    expect(await engine.draftState('d1')).toBe('draft');
    expect(await engine.draftState('s1')).toBe('sent');
    expect(await engine.draftState('nope')).toBe('gone');
  });
});

describe('an engine for a shared account', () => {
  const two = () => {
    const mine = new FakeJmap();
    const shared = new FakeJmap();
    shared.accountId = 'g';
    shared.accountName = 'support@example.test';
    for (const s of [mine, shared]) {
      s.addMailbox('I', 'Inbox', 'inbox');
      s.addMailbox('S', 'Sent', 'sent');
    }
    mine.addEmail({ id: 'm1', threadId: 'tm1', receivedAt: '2026-09-01T00:00:00Z', mailboxIds: { I: true } });
    shared.addEmail({ id: 'g1', threadId: 'tg1', receivedAt: '2026-09-01T00:00:00Z', mailboxIds: { I: true } });
    const client = fakeClient([mine, shared]);
    return { mine, shared, client, own: new MailEngine(client), group: new MailEngine(client, { accountId: 'g' }) };
  };

  it('reads only its own account', async () => {
    const { group, own } = two();
    await Promise.all([own.start(), group.start()]);
    const key = group.openQuery(inboxSpec);
    await group.ensureRange(key, 0, 10);
    expect(group.accountId).toBe('g');
    expect(own.accountId).toBe('a1');
    expect(group.state.queries[key]!.slots).toEqual(['g1']);
    expect(own.state.emails.g1).toBeUndefined();
  });

  it('ignores a state change for the other account', async () => {
    const { group, own, mine, shared } = two();
    await Promise.all([own.start(), group.start()]);
    await own.ensureRange(own.openQuery(inboxSpec), 0, 10);
    await group.ensureRange(group.openQuery(inboxSpec), 0, 10);
    shared.addEmail({ id: 'g2', threadId: 'tg2', receivedAt: '2026-09-02T00:00:00Z', mailboxIds: { I: true } });
    mine.calls = [];
    const change = { '@type': 'StateChange' as const, changed: { g: { Email: 'new', Mailbox: 'new', Thread: 'new' } } };
    own.onStateChange(change);
    group.onStateChange(change);
    await vi.waitFor(() => expect(group.state.emails.g2).toBeDefined());
    expect(mine.calls).toEqual([]);
  });

  it('uploads into its own account', async () => {
    const { group, client } = two();
    const upload = vi.spyOn(client, 'upload').mockResolvedValue({ accountId: 'g', blobId: 'b', type: 't', size: 1 });
    await group.upload(new Blob(['x']));
    expect(upload).toHaveBeenCalledWith(expect.any(Blob), 'g');
  });
});

describe('saveDraft', () => {
  const setup = async () => {
    const server = new FakeJmap();
    server.addMailbox('D', 'Drafts', 'drafts');
    server.uploads.add('up1');
    const client = server.client();
    const engine = createRoot(() => new MailEngine(client, { settleDelayMs: 0 }));
    await engine.start();
    return { server, client, engine };
  };
  const draft = (blobId: string, subject = 'v') => ({
    mailboxIds: { D: true as const }, subject, bodyValues: { text: { value: 't', isEncodingProblem: false, isTruncated: false } },
    bodyStructure: { type: 'multipart/mixed', subParts: [{ partId: 'text', type: 'text/plain' }, { blobId, type: 'text/plain', name: 'a.txt', disposition: 'attachment' }] },
  });

  it('returns the new version\'s parts and removes the versions it replaces', async () => {
    const { server, engine } = await setup();
    const v1 = await engine.saveDraft(draft('up1'), []);
    expect(v1.parts!.map((p) => p.name)).toEqual(['a.txt']);
    expect(v1.parts![0]!.blobId).not.toBe('up1');
    const v2 = await engine.saveDraft(draft(v1.parts![0]!.blobId!, 'v2'), [v1.id]);
    expect(v2.replaced).toBe(true);
    expect([...server.emails.keys()]).toEqual([v2.id]);
  });

  it('leaves the previous version alone when the new one cannot be created', async () => {
    const { server, engine } = await setup();
    const v1 = await engine.saveDraft(draft('up1'), []);
    const failed = engine.saveDraft(draft('gone'), [v1.id]);
    await expect(failed).rejects.toBeInstanceOf(DraftSaveError);
    await expect(failed).rejects.toMatchObject({ type: 'blobNotFound' });
    expect(server.emails.has(v1.id)).toBe(true);
  });

  it('still reports the save when the follow-up request fails', async () => {
    const { server, client, engine } = await setup();
    const v1 = await engine.saveDraft(draft('up1'), []);
    // The request that would destroy the old version never gets out.
    const real = client.send.bind(client);
    const destroys = (b: Parameters<typeof client.send>[0]) => b.build([]).methodCalls.some(([name, args]) => name === 'Email/set' && !!args.destroy);
    vi.spyOn(client, 'send').mockImplementation((b) => (destroys(b) ? Promise.reject(new TypeError('Failed to fetch')) : real(b)));
    const v2 = await engine.saveDraft(draft('up1', 'v2'), [v1.id]);
    expect(v2).toMatchObject({ parts: null, replaced: false });
    expect(server.emails.has(v1.id)).toBe(true);
    expect(server.emails.has(v2.id)).toBe(true);
  });

  it('reads a draft\'s parts, and null for one that is gone', async () => {
    const { engine } = await setup();
    const v1 = await engine.saveDraft(draft('up1'), []);
    expect((await engine.draftParts(v1.id))!.map((p) => p.blobId)).toEqual(v1.parts!.map((p) => p.blobId));
    expect(await engine.draftParts('nope')).toBeNull();
  });
});
