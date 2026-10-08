import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailEngine, type EmailRec } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import { RequestError } from '../jmap/client';
import { createComposers, UNDO_SEND_MS } from './composer';

const original: EmailRec = {
  id: 'e1', threadId: 't1', subject: 'Hi', messageId: ['m1@x'], from: [{ name: 'Bob', email: 'bob@x.test' }],
  to: [{ name: null, email: 'support@example.test' }], receivedAt: '2026-09-01T10:00:00Z', textBody: [], htmlBody: [], bodyValues: {},
};

describe('composer signatures', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  let composers: ReturnType<typeof createComposers>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = new FakeJmap();
    server.addMailbox('D', 'Drafts', 'drafts');
    server.identities.get('id1')!.htmlSignature = '<b>Alice</b>';
    server.identities.set('id2', { id: 'id2', name: 'Support', email: 'support@example.test', replyTo: null, bcc: null, textSignature: 'Support team', htmlSignature: '', mayDelete: true });
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    composers = createRoot(() => createComposers(engine, vi.fn(), vi.fn(async () => true), vi.fn()));
  });
  afterEach(() => vi.useRealTimers());

  it("writes a new message from the mailbox's own address, wherever the server lists that identity", async () => {
    // Stalwart may list a group's address before the member's own.
    const server2 = new FakeJmap();
    server2.addMailbox('D', 'Drafts', 'drafts');
    const own = server2.identities.get('id1')!;
    server2.identities.clear();
    server2.identities.set('id0', { id: 'id0', name: 'Support', email: 'support@example.test', replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: true });
    server2.identities.set('id1', own);
    const engine2 = createRoot(() => new MailEngine(server2.client(), { settleDelayMs: 0 }));
    await engine2.start();
    const composers2 = createRoot(() => createComposers(engine2, vi.fn(), vi.fn(async () => true), vi.fn()));
    expect(engine2.state.identities[0]!.email).toBe('support@example.test');
    expect(composers2.open('new').identityId()).toBe('id1');
  });

  it('starts every mode with the default identity\'s signature', () => {
    expect(composers.open('new').draft().signatureHtml).toBe('<b>Alice</b>');
    // A reply defaults to the identity the message was sent to.
    expect(composers.open('reply', original).draft().signatureHtml).toBe('Support team');
  });

  it('swaps the signature when From changes', () => {
    const c = composers.open('new');
    c.setIdentityId('id2');
    expect(c.draft().signatureHtml).toBe('Support team');
  });

  it('stops swapping once the signature is removed or moved into the text', () => {
    const a = composers.open('new');
    a.removeSignature();
    a.setIdentityId('id2');
    expect(a.draft().signatureHtml).toBe('');

    const b = composers.open('new');
    b.inlineSignature('<p>Hi</p><b>Alice</b>');
    expect(b.draft()).toMatchObject({ bodyHtml: '<p>Hi</p><b>Alice</b>', signatureHtml: '' });
    b.setIdentityId('id2');
    expect(b.draft().signatureHtml).toBe('');
  });

  it('reopens a saved draft with its signature and quote in order, and From still swaps it', () => {
    composers.openDraft({
      id: 'd1', threadId: 't9', from: [{ name: null, email: 'alice@example.test' }], to: [], receivedAt: '2026-09-01T10:00:00Z',
      htmlBody: [{ partId: 'h', type: 'text/html' } as never],
      bodyValues: { h: { value: '<p>Hi</p><div class="oinbox-signature"><b>Old</b></div><div class="gmail_quote">Q</div>', isEncodingProblem: false, isTruncated: false } },
    });
    const c = composers.list().at(-1)!;
    expect(c.draft()).toMatchObject({ bodyHtml: '<p>Hi</p>', signatureHtml: '<b>Old</b>', quoteHtml: '<div class="gmail_quote">Q</div>' });
    c.setIdentityId('id2');
    expect(c.draft().signatureHtml).toBe('Support team');
  });

  it('does not add a signature to a reopened draft that had none', () => {
    composers.openDraft({
      id: 'd2', threadId: 't9', from: [{ name: null, email: 'alice@example.test' }], to: [], receivedAt: '2026-09-01T10:00:00Z',
      htmlBody: [{ partId: 'h', type: 'text/html' } as never],
      bodyValues: { h: { value: '<p>Plain</p>', isEncodingProblem: false, isTruncated: false } },
    });
    const c = composers.list().at(-1)!;
    c.setIdentityId('id2');
    expect(c.draft().signatureHtml).toBe('');
  });

  it('adds a signature to a reopened draft from an identity that has none when From changes to one that does', async () => {
    await engine.updateIdentity('id2', { name: 'Support', htmlSignature: '', textSignature: '' });
    composers.openDraft({
      id: 'd3', threadId: 't9', from: [{ name: null, email: 'support@example.test' }], to: [], receivedAt: '2026-09-01T10:00:00Z',
      htmlBody: [{ partId: 'h', type: 'text/html' } as never],
      bodyValues: { h: { value: '<p>Plain</p>', isEncodingProblem: false, isTruncated: false } },
    });
    const c = composers.list().at(-1)!;
    c.setIdentityId('id1');
    expect(c.draft().signatureHtml).toBe('<b>Alice</b>');
  });
});

describe('composer safety', () => {
  const bob = { name: null, email: 'bob@example.test' };

  async function setup(opts: { onRecovered?: (fn: () => void) => void } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = new FakeJmap();
    server.addMailbox('D', 'Drafts', 'drafts');
    server.addMailbox('S', 'Sent', 'sent');
    const engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    const toast = vi.fn();
    const confirm = vi.fn(async () => true);
    const composers = createRoot(() => createComposers(engine, toast, confirm, vi.fn(), opts.onRecovered));
    return { server, engine, toast, confirm, composers };
  }
  afterEach(() => vi.useRealTimers());

  describe('a failed send', () => {
    it('reopens the composer with its text and offers Retry', async () => {
      const { composers, engine, toast } = await setup();
      const c = composers.open('new');
      c.update({ to: [bob], subject: 'Hello', bodyHtml: '<p>keep me</p>' });
      vi.spyOn(engine, 'sendDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));
      vi.spyOn(engine, 'draftState').mockResolvedValue('draft');
      await composers.send(c);
      expect(composers.list()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
      expect(composers.list()).toHaveLength(1);
      expect(composers.list()[0]!.draft().bodyHtml).toBe('<p>keep me</p>');
      expect(toast).toHaveBeenLastCalledWith("Couldn't send. Your message is still here.", 'error', expect.objectContaining({ label: 'Retry' }));
    });

    it('does not send twice when the first send reached the server', async () => {
      const { composers, engine, toast } = await setup();
      const c = composers.open('new');
      c.update({ to: [bob], subject: 'Once' });
      const send = vi.spyOn(engine, 'sendDraft').mockRejectedValueOnce(new RequestError(0, 'timeout'));
      vi.spyOn(engine, 'draftState').mockResolvedValue('sent');
      await composers.send(c);
      await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
      expect(composers.list()).toHaveLength(0);
      expect(toast).toHaveBeenLastCalledWith('Message sent.', 'success');
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('checks again before the reopened composer saves, when the first check could not run', async () => {
      const { composers, engine, toast } = await setup();
      const c = composers.open('new');
      c.update({ to: [bob], subject: 'Maybe' });
      const send = vi.spyOn(engine, 'sendDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const state = vi.spyOn(engine, 'draftState').mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue('sent');
      const save = vi.spyOn(engine, 'saveDraft');
      await composers.send(c);
      await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
      const reopened = composers.list()[0]!;
      const saves = save.mock.calls.length;
      await composers.send(reopened);
      expect(state).toHaveBeenCalledTimes(2);
      // Saving would have destroyed the copy that was sent.
      expect(save).toHaveBeenCalledTimes(saves);
      expect(send).toHaveBeenCalledTimes(1);
      expect(composers.list()).toHaveLength(0);
      expect(toast).toHaveBeenLastCalledWith('Message sent.', 'success');
    });

    it('keeps the composer when the save before sending fails', async () => {
      const { composers, engine, toast } = await setup();
      const c = composers.open('new');
      c.update({ to: [bob], subject: 'Offline' });
      vi.spyOn(engine, 'saveDraft').mockRejectedValue(new TypeError('Failed to fetch'));
      await composers.send(c);
      expect(composers.list()).toEqual([c]);
      expect(toast).toHaveBeenLastCalledWith("Couldn't send. Your message is still here.", 'error', expect.objectContaining({ label: 'Retry' }));
    });
  });

  describe('a failed save', () => {
    it('keeps the composer open on close unless the user confirms', async () => {
      const { composers, engine, confirm } = await setup();
      const c = composers.open('new');
      c.update({ subject: 'unsaved' });
      vi.spyOn(engine, 'saveDraft').mockRejectedValue(new TypeError('Failed to fetch'));
      confirm.mockResolvedValueOnce(false);
      await composers.close(c);
      expect(composers.list()).toHaveLength(1);
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Close without saving?' }));
      confirm.mockResolvedValueOnce(true);
      await composers.close(c);
      expect(composers.list()).toHaveLength(0);
    });

    it('saves again by itself when the connection returns', async () => {
      let recovered = () => {};
      const { composers, engine } = await setup({ onRecovered: (fn) => (recovered = fn) });
      const c = composers.open('new');
      const save = vi.spyOn(engine, 'saveDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));
      c.update({ subject: 'later' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(c.status()).toBe('error');
      recovered();
      await vi.waitFor(() => expect(c.status()).toBe('saved'));
      expect(save).toHaveBeenCalledTimes(2);
    });
  });

  describe('a send that may have gone through', () => {
    const failedSend = async (state: 'draft' | 'sent') => {
      const s = await setup();
      const c = s.composers.open('new');
      c.update({ to: [bob], subject: 'Maybe', bodyHtml: '<p>v1</p>' });
      vi.spyOn(s.engine, 'sendDraft').mockRejectedValueOnce(new RequestError(0, 'timeout'));
      const draftState = vi.spyOn(s.engine, 'draftState').mockResolvedValueOnce('draft').mockResolvedValue(state);
      await s.composers.send(c);
      await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
      return { ...s, draftState, reopened: s.composers.list()[0]! };
    };

    it('checks again before saving even when the first check said it was still a draft', async () => {
      const { composers, engine, toast, reopened, draftState } = await failedSend('sent');
      const save = vi.spyOn(engine, 'saveDraft');
      await composers.send(reopened);
      expect(draftState).toHaveBeenCalledTimes(2);
      expect(save).not.toHaveBeenCalled();
      expect(composers.list()).toHaveLength(0);
      expect(toast).toHaveBeenLastCalledWith('Message sent.', 'success');
    });

    it('does not delete the sent copy when the reopened composer is discarded', async () => {
      const { composers, engine, reopened } = await failedSend('sent');
      const destroy = vi.spyOn(engine, 'destroyEmails');
      await composers.discard(reopened);
      expect(destroy).not.toHaveBeenCalled();
      expect(composers.list()).toHaveLength(0);
    });

    it('closes the composer and says so when an autosave finds the message was sent', async () => {
      const { composers, toast, reopened } = await failedSend('sent');
      reopened.update({ bodyHtml: '<p>v2</p>' });
      await vi.advanceTimersByTimeAsync(2500);
      expect(composers.list()).toHaveLength(0);
      expect(toast).toHaveBeenLastCalledWith('This message had already been sent, so your latest changes were not included.', 'info');
    });
  });
});

describe('a draft\'s blob ids', () => {
  const start = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = new FakeJmap();
    server.addMailbox('D', 'Drafts', 'drafts');
    server.uploads.add('up1');
    const client = server.client();
    const engine = createRoot(() => new MailEngine(client, { settleDelayMs: 0 }));
    await engine.start();
    const toast = vi.fn();
    const composers = createRoot(() => createComposers(engine, toast, vi.fn(async () => true), vi.fn()));
    return { server, client, engine, composers, toast };
  };
  afterEach(() => vi.useRealTimers());
  const file = { blobId: 'up1', name: 'a.pdf', type: 'application/pdf', size: 3 };
  const autosave = () => vi.advanceTimersByTimeAsync(2000);

  it('are the stored version\'s after each save, so a third save still works', async () => {
    const { server, composers } = await start();
    const c = composers.open('new');
    for (const subject of ['one', 'two', 'three']) {
      c.update({ subject, attachments: c.draft().attachments.length ? c.draft().attachments : [file] });
      await autosave();
      expect(c.status()).toBe('saved');
    }
    expect(server.emails.size).toBe(1);
    const stored = [...server.emails.values()][0]!;
    expect(stored.subject).toBe('three');
    expect(c.draft().attachments[0]!.blobId).toBe(stored.attachments![0]!.blobId);
  });

  it('let a draft reopened from Drafts be saved more than once', async () => {
    const { server, composers } = await start();
    const first = composers.open('new');
    first.update({ subject: 'kept', attachments: [file] });
    await autosave();
    await composers.close(first);
    composers.openDraft(structuredClone([...server.emails.values()][0]!));
    const c = composers.list().at(-1)!;
    expect(c.draft().attachments.map((a) => a.name)).toEqual(['a.pdf']);
    for (const subject of ['again', 'and again']) {
      c.update({ subject });
      await autosave();
      expect(c.status()).toBe('saved');
    }
    expect([...server.emails.values()].map((e) => e.subject)).toEqual(['and again']);
  });

  it('are not touched for an attachment added while the save was on its way', async () => {
    const { server, composers } = await start();
    server.uploads.add('up2');
    const c = composers.open('new');
    c.update({ subject: 's', attachments: [file] });
    let release = () => {};
    server.holds.push(new Promise((r) => (release = r)));
    const saving = autosave();
    await vi.waitFor(() => expect(c.status()).toBe('saving'));
    c.update({ attachments: [...c.draft().attachments, { blobId: 'up2', name: 'b.txt', type: 'text/plain', size: 1 }] });
    release();
    await saving;
    await vi.waitFor(() => expect(c.draft().attachments.map((a) => a.blobId)).toEqual([[...server.emails.values()][0]!.attachments![0]!.blobId, 'up2']));
  });

  it('keep the last saved version on the server when a save fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { server, composers } = await start();
      const c = composers.open('new');
      c.update({ subject: 'good' });
      await autosave();
      c.update({ subject: 'bad', attachments: [{ ...file, blobId: 'never-uploaded' }] });
      await autosave();
      expect(c.status()).toBe('error');
      expect([...server.emails.values()].map((e) => e.subject)).toEqual(['good']);
    } finally {
      log.mockRestore();
    }
  });

  it('are read again from the server when it says a blob is gone', async () => {
    const { server, client, composers } = await start();
    const c = composers.open('new');
    c.update({ subject: 'one', attachments: [file] });
    await autosave();
    // The next save's follow-up is lost on the way back: the old version is destroyed, but we never learn the new ids.
    const real = client.send.bind(client);
    let lost = false;
    vi.spyOn(client, 'send').mockImplementation(async (b) => {
      const r = await real(b);
      if (!lost && b.build([]).methodCalls.some(([name, args]) => name === 'Email/set' && !!args.destroy)) {
        lost = true;
        throw new TypeError('Failed to fetch');
      }
      return r;
    });
    c.update({ subject: 'two' });
    await autosave();
    expect(c.status()).toBe('saved');
    c.update({ subject: 'three' });
    await autosave();
    expect(c.status()).toBe('saved');
    expect([...server.emails.values()].map((e) => e.subject)).toEqual(['three']);
  });

  it('are current in the composer Undo brings back after Send', async () => {
    const { server, composers, toast } = await start();
    const c = composers.open('new');
    c.update({ to: [{ name: null, email: 'bob@x.test' }], subject: 'undo me', attachments: [file] });
    await composers.send(c);
    const undo = toast.mock.calls.find((call) => call[0] === 'Sending…')![2] as { run: () => void };
    undo.run();
    const back = composers.list().at(-1)!;
    expect(back.draft().attachments[0]!.blobId).toBe([...server.emails.values()][0]!.attachments![0]!.blobId);
    for (const subject of ['x', 'y']) {
      back.update({ subject });
      await autosave();
      expect(back.status()).toBe('saved');
    }
  });
});
