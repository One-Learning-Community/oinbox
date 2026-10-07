import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailEngine, type EmailRec } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import { createComposers } from './composer';

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
    composers = createRoot(() => createComposers(engine, server.client(), vi.fn(), vi.fn(async () => true), vi.fn()));
  });
  afterEach(() => vi.useRealTimers());

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
