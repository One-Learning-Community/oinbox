import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SORT, MailEngine } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import { createActions, type ToastFn } from './actions';

describe('actions.removeLabel', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  let toast: ReturnType<typeof vi.fn<ToastFn>>;
  let actions: ReturnType<typeof createActions>;

  async function setup(withArchive: boolean) {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    if (withArchive) server.addMailbox('A', 'Archive', 'archive');
    server.addMailbox('W', 'Work');
    // Thread t1: one message only in Work, one in Work and Inbox.
    server.addEmail({ id: 'w1', threadId: 't1', receivedAt: '2026-09-01T10:00:00Z', mailboxIds: { W: true } }, false);
    server.addEmail({ id: 'w2', threadId: 't1', receivedAt: '2026-09-01T11:00:00Z', mailboxIds: { W: true, I: true } }, false);
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    const key = engine.openQuery({ filter: { inMailbox: 'W' }, sort: DEFAULT_SORT, collapseThreads: true });
    await engine.ensureRange(key, 0, 10);
    toast = vi.fn<ToastFn>();
    actions = createActions(engine, toast, async () => true);
  }

  beforeEach(() => setup(true));

  it('takes the label off the thread, archiving a message with no other mailbox', async () => {
    await actions.removeLabel(['t1'], 'W');
    expect(server.emails.get('w1')?.mailboxIds).toEqual({ A: true });
    expect(server.emails.get('w2')?.mailboxIds).toEqual({ I: true });
    expect(toast).toHaveBeenCalledWith("Removed 'Work'.", 'info', expect.objectContaining({ label: 'Undo' }));
  });

  it('undo puts the label back', async () => {
    await actions.removeLabel(['t1'], 'W');
    toast.mock.calls[0]![2]!.run();
    await vi.waitFor(() => expect(server.emails.get('w1')?.mailboxIds).toEqual({ W: true }));
    expect(server.emails.get('w2')?.mailboxIds).toEqual({ W: true, I: true });
  });

  it('creates Archive when it is needed and missing', async () => {
    await setup(false);
    await actions.removeLabel(['t1'], 'W');
    const archive = [...server.mailboxes.values()].find((m) => m.role === 'archive');
    expect(archive).toBeDefined();
    expect(server.emails.get('w1')?.mailboxIds).toEqual({ [archive!.id]: true });
  });
});
