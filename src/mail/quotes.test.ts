import { describe, expect, it } from 'vitest';
import { foldHtmlQuote, splitPlainQuote } from './quotes';

describe('splitPlainQuote', () => {
  it('splits an "On … wrote:" block of > lines', () => {
    const text = 'Sounds good.\n\nOn Tue, Sep 23, 2026 at 10:00 AM Bob <bob@x.test> wrote:\n> Lunch?\n>\n> Bob\n';
    expect(splitPlainQuote(text)).toEqual({
      body: 'Sounds good.',
      quote: 'On Tue, Sep 23, 2026 at 10:00 AM Bob <bob@x.test> wrote:\n> Lunch?\n>\n> Bob',
    });
  });

  it('handles an attribution wrapped over two lines', () => {
    const text = 'Yes\n\nOn Tue, Sep 23, 2026 at 10:00 AM Bob Smith <bob@x.test>\nwrote:\n> Lunch?';
    expect(splitPlainQuote(text).body).toBe('Yes');
  });

  it('splits an Outlook original-message block', () => {
    const text = 'Ok\n\n-----Original Message-----\nFrom: Bob\nSent: Tuesday\n\nLunch?';
    expect(splitPlainQuote(text)).toEqual({ body: 'Ok', quote: '-----Original Message-----\nFrom: Bob\nSent: Tuesday\n\nLunch?' });
  });

  it('keeps inline quoting that is followed by a reply', () => {
    const text = '> Lunch?\nYes!\n> Where?\nThe usual.';
    expect(splitPlainQuote(text)).toEqual({ body: text, quote: null });
  });

  it('folds a trailing bare > block', () => {
    expect(splitPlainQuote('Yes\n\n> Lunch?\n> Bob')).toEqual({ body: 'Yes', quote: '> Lunch?\n> Bob' });
  });

  it('returns no quote for plain text', () => {
    expect(splitPlainQuote('Hello\nthere')).toEqual({ body: 'Hello\nthere', quote: null });
  });
});

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

describe('foldHtmlQuote', () => {
  it('folds a gmail_quote and its attribution', () => {
    const d = doc('<div>Sure</div><div class="gmail_quote"><div class="gmail_attr">On Tue Bob wrote:</div><blockquote>Lunch?</blockquote></div>');
    expect(foldHtmlQuote(d)).toBe(true);
    const fold = d.querySelector('[data-oinbox-quote]')!;
    expect(fold.textContent).toContain('Lunch?');
    expect(d.body.textContent!.replace(fold.textContent!, '').trim()).toBe('Sure');
  });

  it('folds an Apple/Thunderbird cite blockquote and the "wrote:" line before it', () => {
    const d = doc('<p>Sure</p><div>On Sep 23, Bob wrote:</div><blockquote type="cite">Lunch?</blockquote>');
    foldHtmlQuote(d);
    expect(d.querySelector('[data-oinbox-quote]')!.textContent).toBe('On Sep 23, Bob wrote:Lunch?');
  });

  it('folds from the Outlook reply header to the end', () => {
    const d = doc('<p>Ok</p><div id="divRplyFwdMsg"><b>From:</b> Bob</div><div>Lunch?</div>');
    foldHtmlQuote(d);
    const fold = d.querySelector('[data-oinbox-quote]')!;
    expect(fold.textContent).toContain('From: Bob');
    expect(fold.textContent).toContain('Lunch?');
  });

  it('does not fold a quote that is followed by more reply text', () => {
    const d = doc('<blockquote type="cite">Lunch?</blockquote><p>Yes, at noon.</p>');
    expect(foldHtmlQuote(d)).toBe(false);
  });

  it('folds nothing when there is no quote', () => {
    expect(foldHtmlQuote(doc('<p>Hi</p>'))).toBe(false);
  });
});
