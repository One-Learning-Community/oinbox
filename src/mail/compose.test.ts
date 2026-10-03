import { describe, expect, it } from 'vitest';
import type { EmailRec } from '../sync/engine';
import { buildEmailCreate, initialDraft, parseAddressList, formatAddress, splitDraftHtml } from './compose';

const me = new Set(['alice@example.test']);
const original: EmailRec = {
  id: 'e1',
  threadId: 't1',
  subject: 'Lunch',
  messageId: ['m1@x.test'],
  references: ['m0@x.test'],
  from: [{ name: 'Bob', email: 'bob@x.test' }],
  to: [{ name: 'Alice', email: 'alice@example.test' }, { name: 'Carol', email: 'carol@x.test' }],
  cc: [{ name: null, email: 'dan@x.test' }],
  receivedAt: '2026-09-23T17:00:00Z',
  sentAt: '2026-09-23T17:00:00Z',
  textBody: [{ partId: '1', type: 'text/plain' } as never],
  htmlBody: [],
  bodyValues: { '1': { value: 'Noon?\n', isEncodingProblem: false, isTruncated: false } },
};

describe('initialDraft', () => {
  it('reply goes to the sender with Re: and threading headers', () => {
    const d = initialDraft('reply', original, me);
    expect(d.to).toEqual([{ name: 'Bob', email: 'bob@x.test' }]);
    expect(d.cc).toEqual([]);
    expect(d.subject).toBe('Re: Lunch');
    expect(d.inReplyTo).toEqual(['m1@x.test']);
    expect(d.references).toEqual(['m0@x.test', 'm1@x.test']);
    expect(d.quoteHtml).toContain('Bob');
    expect(d.quoteHtml).toContain('Noon?');
  });

  it('reply-all includes everyone except me', () => {
    const d = initialDraft('replyAll', original, me);
    expect(d.to.map((a) => a.email)).toEqual(['bob@x.test', 'carol@x.test']);
    expect(d.cc.map((a) => a.email)).toEqual(['dan@x.test']);
  });

  it('prefers Reply-To', () => {
    const d = initialDraft('reply', { ...original, replyTo: [{ name: 'List', email: 'list@x.test' }] }, me);
    expect(d.to.map((a) => a.email)).toEqual(['list@x.test']);
  });

  it('replying to my own message goes to its original recipients', () => {
    const mine = { ...original, from: [{ name: 'Alice', email: 'alice@example.test' }], to: [{ name: 'Bob', email: 'bob@x.test' }], cc: [] };
    expect(initialDraft('reply', mine, me).to.map((a) => a.email)).toEqual(['bob@x.test']);
  });

  it('forward has no recipients, Fwd: subject, and the forwarded header block', () => {
    const d = initialDraft('forward', original, me);
    expect(d.to).toEqual([]);
    expect(d.subject).toBe('Fwd: Lunch');
    expect(d.quoteHtml).toContain('Forwarded message');
    expect(d.inReplyTo).toEqual([]);
  });

  it('does not stack Re: prefixes', () => {
    expect(initialDraft('reply', { ...original, subject: 'RE: Lunch' }, me).subject).toBe('RE: Lunch');
  });

  it('escapes quoted plain text', () => {
    const d = initialDraft('reply', { ...original, bodyValues: { '1': { value: '<script>x</script>', isEncodingProblem: false, isTruncated: false } } }, me);
    expect(d.quoteHtml).not.toContain('<script>');
  });
});

describe('addresses', () => {
  it('parses a pasted address list', () => {
    expect(parseAddressList('Bob <bob@x.test>, carol@x.test; "Smith, Dan" <dan@x.test>')).toEqual([
      { name: 'Bob', email: 'bob@x.test' },
      { name: null, email: 'carol@x.test' },
      { name: 'Smith, Dan', email: 'dan@x.test' },
    ]);
  });

  it('formats an address', () => {
    expect(formatAddress({ name: 'Bob', email: 'bob@x.test' })).toBe('Bob <bob@x.test>');
    expect(formatAddress({ name: null, email: 'bob@x.test' })).toBe('bob@x.test');
  });
});

describe('buildEmailCreate', () => {
  it('creates a draft with text and html alternatives and attachments', () => {
    const e = buildEmailCreate(
      {
        mode: 'reply', to: [{ name: 'Bob', email: 'bob@x.test' }], cc: [], bcc: [], subject: 'Re: Lunch',
        inReplyTo: ['m1@x.test'], references: ['m0@x.test', 'm1@x.test'], quoteHtml: '<blockquote>q</blockquote>', signatureHtml: '', bodyHtml: '<p>Yes <b>12</b></p>',
        attachments: [{ blobId: 'B1', name: 'a.pdf', type: 'application/pdf', size: 3 }],
      },
      { name: 'Alice', email: 'alice@example.test' },
      'D',
    );
    expect(e.mailboxIds).toEqual({ D: true });
    expect(e.keywords).toEqual({ $draft: true, $seen: true });
    expect(e.from).toEqual([{ name: 'Alice', email: 'alice@example.test' }]);
    expect(e.inReplyTo).toEqual(['m1@x.test']);
    expect(e.bodyValues!.html!.value).toBe('<p>Yes <b>12</b></p><blockquote>q</blockquote>');
    expect(e.bodyValues!.text!.value).toContain('Yes 12');
    expect(e.htmlBody).toEqual([{ partId: 'html', type: 'text/html' }]);
    expect(e.textBody).toEqual([{ partId: 'text', type: 'text/plain' }]);
    expect(e.attachments).toEqual([{ blobId: 'B1', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' }]);
  });
});

describe('the signature in a saved draft', () => {
  const draft = { ...initialDraft('new', null, me), to: [{ name: null, email: 'bob@x.test' }], bodyHtml: '<p>Hello</p>' };
  const parts = (e: ReturnType<typeof buildEmailCreate>) => ({ html: e.bodyValues!.html!.value, text: e.bodyValues!.text!.value });

  it('goes between the text and the quote, with a -- line in the text part', () => {
    const e = buildEmailCreate({ ...draft, signatureHtml: '<b>Alice</b>', quoteHtml: '<br><div class="gmail_quote">Old</div>' }, { name: 'A', email: 'alice@example.test' }, 'D');
    const { html, text } = parts(e);
    expect(html).toBe('<p>Hello</p><div class="oinbox-signature"><b>Alice</b></div><br><div class="gmail_quote">Old</div>');
    expect(text).toBe('Hello\n-- \nAlice\nOld\n');
  });

  it('adds nothing without a signature', () => {
    const { html, text } = parts(buildEmailCreate({ ...draft, signatureHtml: '' }, { name: null, email: 'alice@example.test' }, 'D'));
    expect(html).toBe('<p>Hello</p>');
    expect(text).toBe('Hello\n');
  });

  it('starts empty in a new draft', () => {
    expect(initialDraft('reply', original, me).signatureHtml).toBe('');
  });
});

describe('splitDraftHtml', () => {
  it('splits the body, the signature and what follows it', () => {
    const html = '<p>Hello</p><div class="oinbox-signature"><b>Alice</b></div><br><div class="gmail_quote">Old</div>';
    expect(splitDraftHtml(html)).toEqual({ bodyHtml: '<p>Hello</p>', signatureHtml: '<b>Alice</b>', quoteHtml: '<br><div class="gmail_quote">Old</div>' });
  });
  it('reads a full HTML document as the server may return it', () => {
    const html = '<html><head></head><body><p>Hi</p><div class="oinbox-signature">S</div></body></html>';
    expect(splitDraftHtml(html)).toEqual({ bodyHtml: '<p>Hi</p>', signatureHtml: 'S', quoteHtml: '' });
  });
  it('leaves HTML without a signature block as the body', () => {
    expect(splitDraftHtml('<p>Hi</p><div class="x">S</div>')).toEqual({ bodyHtml: '<p>Hi</p><div class="x">S</div>', signatureHtml: '', quoteHtml: '' });
  });
  it('ignores a signature block nested inside the quote', () => {
    const html = '<p>Hi</p><div class="gmail_quote"><div class="oinbox-signature">Theirs</div></div>';
    expect(splitDraftHtml(html).signatureHtml).toBe('');
  });
});
