import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SORT, MailEngine } from './engine';
import { FakeJmap } from './fake-jmap';
import { archivePatch, keywordPatch } from './patch';

const inboxSpec = { filter: { inMailbox: 'I' }, sort: DEFAULT_SORT, collapseThreads: true };

function setup(opts: { collapsedQueryChanges?: boolean } = {}) {
  const server = new FakeJmap();
  server.addMailbox('I', 'Inbox', 'inbox');
  server.addMailbox('S', 'Sent', 'sent');
  server.addMailbox('A', 'Archive', 'archive');
  // Thread t1: Bob → Alice (Sent) → Bob. Thread t2: one message.
  server.addEmail({ id: 'e1', threadId: 't1', receivedAt: '2026-09-01T10:00:00Z', mailboxIds: { I: true }, keywords: { $seen: true } }, false);
  server.addEmail({ id: 'e2', threadId: 't1', receivedAt: '2026-09-01T11:00:00Z', mailboxIds: { S: true }, keywords: { $seen: true } }, false);
  server.addEmail({ id: 'e3', threadId: 't1', receivedAt: '2026-09-01T12:00:00Z', mailboxIds: { I: true } }, false);
  server.addEmail({ id: 'e4', threadId: 't2', receivedAt: '2026-09-01T09:00:00Z', mailboxIds: { I: true } }, false);
  const engine = createRoot(() => new MailEngine(server.client(), opts));
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

  it('archives optimistically and keeps the change when the server accepts it', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    const p = engine.updateEmails(archivePatch(engine.threadEmails(['t1']), 'I'));
    // Gone from the inbox before the server answers.
    expect(engine.state.queries[key]!.slots).toEqual(['e4']);
    await p;
    expect(server.emails.get('e3')!.mailboxIds).toEqual({});
    await engine.catchUp();
    expect(engine.state.queries[key]!.slots).toEqual(['e4']);
  });

  it('rolls back rejected updates, restoring the row', async () => {
    const key = engine.openQuery(inboxSpec);
    await engine.ensureRange(key, 0, 10);
    server.rejectUpdates.add('e3');
    await expect(engine.updateEmails(archivePatch(engine.threadEmails(['t1']), 'I'))).rejects.toThrow('forbidden');
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
});
