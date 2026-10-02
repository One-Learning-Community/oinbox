import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../mail/labels';
import { MailEngine } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import type { ConfirmFn, ConfirmOptions } from '../ui/ConfirmDialog';
import type { ToastFn } from './actions';
import { createLabels, deleteMessage } from './labels';

describe('deleteMessage', () => {
  it('says an empty label is empty', () => {
    expect(deleteMessage(0, 0, 0)).toBe('This label is empty.');
  });

  it('says how many conversations stay and how many move to Archive', () => {
    expect(deleteMessage(14, 12, 5)).toBe('Its 12 conversations stay in your mail. 5 that are only in this label move to Archive.');
    expect(deleteMessage(1, 1, 1)).toBe('Its 1 conversation stays in your mail. 1 that is only in this label moves to Archive.');
  });

  it('leaves the Archive sentence out when nothing is only in the label', () => {
    expect(deleteMessage(3, 3, 0)).toBe('Its 3 conversations stay in your mail.');
  });

  it('stays general when the count is unknown', () => {
    expect(deleteMessage(3, 3, null)).toBe('Its 3 conversations stay in your mail. Any that are only in this label move to Archive.');
  });
});

describe('createLabels', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  let toast: ReturnType<typeof vi.fn<ToastFn>>;
  let asked: ConfirmOptions | null;
  let answer: boolean;
  let labels: ReturnType<typeof createLabels>;

  beforeEach(async () => {
    server = new FakeJmap();
    server.addMailbox('I', 'Inbox', 'inbox');
    server.addMailbox('A', 'Archive', 'archive');
    server.addMailbox('W', 'Work');
    server.addMailbox('C', 'Clients');
    server.addMailbox('K', 'Acme', null, 'C');
    server.addEmail({ id: 'w1', threadId: 't1', receivedAt: '2026-09-01T10:00:00Z', mailboxIds: { W: true } }, false);
    server.addEmail({ id: 'w2', threadId: 't2', receivedAt: '2026-09-01T11:00:00Z', mailboxIds: { W: true, I: true } }, false);
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    toast = vi.fn<ToastFn>();
    asked = null;
    answer = true;
    const confirm: ConfirmFn = async (opts) => {
      asked = opts;
      if (!answer) return false;
      await opts.run?.();
      return true;
    };
    labels = createLabels(engine, toast, confirm, () => DEFAULT_LIMITS);
  });

  it('creates a label and says so', async () => {
    const id = await labels.create('clients/New');
    expect(engine.state.mailboxes[id]).toMatchObject({ name: 'New', parentId: 'C' });
    expect(toast).toHaveBeenCalledWith("Created 'Clients/New'.", 'success');
  });

  it('creates quietly for the pickers', async () => {
    await labels.create('Quiet', { quiet: true });
    expect(toast).not.toHaveBeenCalled();
  });

  it('rejects an invalid path with the validation message and sends nothing', async () => {
    server.calls = [];
    await expect(labels.create('work')).rejects.toThrow("A label named 'Work' already exists.");
    expect(server.calls).toEqual([]);
  });

  it('renames and says so', async () => {
    await labels.rename('W', 'Jobs');
    expect(engine.state.mailboxes.W?.name).toBe('Jobs');
    expect(toast).toHaveBeenCalledWith("Renamed to 'Jobs'.", 'success');
  });

  it('sends nothing for a rename that changes nothing', async () => {
    server.calls = [];
    await labels.rename('W', ' Work ');
    expect(server.calls).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('refuses to delete a label that has sub-labels, without asking', async () => {
    expect(await labels.remove('C')).toBe(false);
    expect(asked).toBeNull();
    expect(server.mailboxes.has('C')).toBe(true);
  });

  it('refuses to delete a system mailbox', async () => {
    expect(await labels.remove('I')).toBe(false);
    expect(asked).toBeNull();
  });

  it('asks with the counts, deletes, and says so', async () => {
    expect(await labels.remove('W')).toBe(true);
    expect(asked).toMatchObject({
      title: "Delete 'Work'?",
      message: 'Its 2 conversations stay in your mail. 1 that is only in this label moves to Archive.',
      confirmLabel: 'Delete',
      pendingLabel: 'Deleting…',
    });
    expect(server.mailboxes.has('W')).toBe(false);
    expect(server.emails.get('w1')?.mailboxIds).toEqual({ A: true });
    expect(labels.deletedHere('W')).toBe(true);
    expect(toast).toHaveBeenCalledWith("Deleted 'Work'.", 'success');
  });

  it('marks the label as deleted here before the store drops it', async () => {
    const seen: boolean[] = [];
    server.onCall = (name, args) => {
      if (name === 'Mailbox/set' && args.destroy) seen.push(labels.deletedHere('W'));
    };
    await labels.remove('W');
    expect(seen).toEqual([true]);
  });

  it('keeps the wording general when the count fails', async () => {
    server.onCall = (name, args) => {
      if (name === 'Email/query' && args.limit === 1) throw new Error('boom');
    };
    await labels.remove('W');
    expect(asked?.message).toBe('Its 2 conversations stay in your mail. Any that are only in this label move to Archive.');
    expect(server.mailboxes.has('W')).toBe(false);
  });

  it('does nothing when the user cancels', async () => {
    answer = false;
    expect(await labels.remove('W')).toBe(false);
    expect(server.mailboxes.has('W')).toBe(true);
    expect(labels.deletedHere('W')).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('says so plainly when the server has a sub-label this session has not seen, and removes nothing', async () => {
    server.addMailbox('N', 'New elsewhere', null, 'W');
    expect(await labels.remove('W')).toBe(false);
    expect(server.emails.get('w1')?.mailboxIds).toEqual({ W: true });
    expect(toast).toHaveBeenCalledWith("Couldn't delete 'Work': it has sub-labels. Delete those first.", 'error');
  });

  it('reports a delete that stopped halfway', async () => {
    server.rejectUpdates.add('w1');
    expect(await labels.remove('W')).toBe(false);
    expect(server.mailboxes.has('W')).toBe(true);
    expect(labels.deletedHere('W')).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      "Couldn't finish deleting 'Work'. Some conversations may already have been removed from it; try again. (forbidden)",
      'error',
    );
  });
});
