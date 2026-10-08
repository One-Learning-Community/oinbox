import { describe, expect, it } from 'vitest';
import type { EmailRec } from '../sync/engine';
import type { EmailBodyStructure } from '../jmap/types';
import { buildEmailCreate, fromEditorHtml, initialDraft, parseAddressList, formatAddress, referencedCids, splitDraftHtml, toEditorHtml, type Draft } from './compose';

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
        attachments: [{ blobId: 'B1', name: 'a.pdf', type: 'application/pdf', size: 3 }], inline: [],
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
    expect(e.bodyStructure).toEqual({
      type: 'multipart/mixed',
      subParts: [
        { type: 'multipart/alternative', subParts: [{ partId: 'text', type: 'text/plain' }, { partId: 'html', type: 'text/html' }] },
        { blobId: 'B1', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' },
      ],
    });
    expect(e.htmlBody).toBeUndefined();
    expect(e.attachments).toBeUndefined();
  });
});

describe('the signature in a saved draft', () => {
  const draft = { ...initialDraft('new', null, me), to: [{ name: null, email: 'bob@x.test' }], bodyHtml: '<p>Hello</p>' };
  const parts = (e: ReturnType<typeof buildEmailCreate>) => ({ html: e.bodyValues!.html!.value, text: e.bodyValues!.text!.value });

  it('goes between the text and the quote, with a -- line in the text part', () => {
    const e = buildEmailCreate({ ...draft, signatureHtml: '<b>Alice</b>', quoteHtml: '<br><div class="gmail_quote">Old</div>' }, { name: 'A', email: 'alice@example.test' }, 'D');
    const { html, text } = parts(e);
    expect(html).toBe('<p>Hello</p><div class="oinbox-signature"><b>Alice</b></div><br><div class="gmail_quote">Old</div>');
    expect(text).toBe('Hello\n\n-- \nAlice\n\nOld\n');
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
  it('strips active content from a signature a draft arrives with', () => {
    const sig = splitDraftHtml('<p>Hi</p><div class="oinbox-signature"><img src="x" onerror="alert(1)"><script>alert(2)</script><b>A</b></div>').signatureHtml;
    expect(sig).not.toMatch(/onerror|script/i);
    expect(sig).toContain('<b>A</b>');
  });
  it('ignores a signature block nested inside the quote', () => {
    const html = '<p>Hi</p><div class="gmail_quote"><div class="oinbox-signature">Theirs</div></div>';
    expect(splitDraftHtml(html).signatureHtml).toBe('');
  });
});

describe('inline images in the HTML', () => {
  const urls = { 'c1@oinbox': 'blob:http://x/1', 'a&b@x': 'blob:http://x/2' };

  it('swaps cid: sources for object URLs and back, byte for byte', () => {
    const editor = '<p>a</p><img src="blob:http://x/1" alt="x"><p>b</p><img src="https://r.test/i.png"><img src="blob:http://x/2">';
    const stored = fromEditorHtml(editor, urls);
    expect(stored).toBe('<p>a</p><img src="cid:c1@oinbox" alt="x"><p>b</p><img src="https://r.test/i.png"><img src="cid:a&amp;b@x">');
    expect(toEditorHtml(stored, urls)).toBe(editor);
  });

  it('leaves an image it has no URL for, and HTML without images, untouched', () => {
    expect(toEditorHtml('<img src="cid:other@x">', urls)).toBe('<img src="cid:other@x">');
    expect(toEditorHtml('<p>data-src="cid:c1@oinbox"</p>', urls)).toBe('<p>data-src="cid:c1@oinbox"</p>');
  });

  it('finds the content ids referred to, with or without angle brackets', () => {
    expect([...referencedCids('<img src="cid:c1@oinbox"><img alt="" src=\'cid:&lt;c2@x&gt;\'><img src="cid:a&amp;b@x"><img src="x.png">')]).toEqual(['c1@oinbox', 'c2@x', 'a&b@x']);
  });
});

describe('buildEmailCreate with inline images', () => {
  const image = { cid: 'c1@oinbox', blobId: 'I1', type: 'image/png', name: 'chart.png', size: 9 };
  const base: Draft = { ...initialDraft('new', null, me), bodyHtml: '<p>See</p><img src="cid:c1@oinbox"><p>there</p>', inline: [image] };
  const from = { name: null, email: 'alice@example.test' };
  const html = { partId: 'html', type: 'text/html' };
  const text = { partId: 'text', type: 'text/plain' };
  const part = { blobId: 'I1', type: 'image/png', name: 'chart.png', cid: 'c1@oinbox', disposition: 'inline' };

  it('puts the image with the HTML in multipart/related', () => {
    expect(buildEmailCreate(base, from, 'D').bodyStructure).toEqual({ type: 'multipart/alternative', subParts: [text, { type: 'multipart/related', subParts: [html, part] }] });
  });

  it('wraps that in multipart/mixed when there are attachments too', () => {
    const e = buildEmailCreate({ ...base, attachments: [{ blobId: 'B1', name: 'a.pdf', type: 'application/pdf', size: 3 }] }, from, 'D');
    expect(e.bodyStructure).toEqual({
      type: 'multipart/mixed',
      subParts: [
        { type: 'multipart/alternative', subParts: [text, { type: 'multipart/related', subParts: [html, part] }] },
        { blobId: 'B1', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' },
      ],
    });
  });

  it('needs no multipart/related without images', () => {
    expect(buildEmailCreate({ ...base, bodyHtml: '<p>x</p>', inline: [] }, from, 'D').bodyStructure).toEqual({ type: 'multipart/alternative', subParts: [text, html] });
  });

  it('leaves out an image the text no longer refers to, and counts one in the quote', () => {
    const gone = buildEmailCreate({ ...base, bodyHtml: '<p>See</p>' }, from, 'D').bodyStructure as EmailBodyStructure;
    expect(gone.subParts).toEqual([text, html]);
    const quoted = buildEmailCreate({ ...base, bodyHtml: '<p>See</p>', quoteHtml: '<blockquote><img src="cid:c1@oinbox"></blockquote>' }, from, 'D').bodyStructure as EmailBodyStructure;
    expect(quoted.subParts![1]).toEqual({ type: 'multipart/related', subParts: [html, part] });
  });

  it('names the image in the plain-text alternative', () => {
    expect(buildEmailCreate(base, from, 'D').bodyValues!.text!.value).toBe('See\n[image: chart.png]\nthere\n');
  });
});
