import { describe, expect, it } from 'vitest';
import { fieldsFromSearch, parseMailto } from './mailto';

const addr = (email: string, name: string | null = null) => ({ name, email });

describe('parseMailto', () => {
  it('reads one address', () => {
    expect(parseMailto('mailto:bob@example.com')).toEqual({ to: [addr('bob@example.com')], cc: [], bcc: [], subject: '', bodyHtml: '' });
  });
  it('reads several addresses, cc, bcc, subject and body', () => {
    const f = parseMailto('mailto:a@x.test,b@x.test?cc=c@x.test&bcc=d@x.test&subject=Hello%20there&body=Line%20one%0D%0ALine%20two');
    expect(f.to).toEqual([addr('a@x.test'), addr('b@x.test')]);
    expect(f.cc).toEqual([addr('c@x.test')]);
    expect(f.bcc).toEqual([addr('d@x.test')]);
    expect(f.subject).toBe('Hello there');
    expect(f.bodyHtml).toBe('<p>Line one</p><p>Line two</p>');
  });
  it('adds to= addresses to the ones before the ?, without repeats', () => {
    expect(parseMailto('mailto:a@x.test?to=b@x.test&to=A@x.test').to).toEqual([addr('a@x.test'), addr('b@x.test')]);
  });
  it('takes a link with no address at all', () => {
    expect(parseMailto('mailto:?subject=Hi')).toMatchObject({ to: [], subject: 'Hi' });
  });
  it('takes a name with the address', () => {
    expect(parseMailto('mailto:%22Bob%20Smith%22%20%3Cbob@x.test%3E').to).toEqual([addr('bob@x.test', 'Bob Smith')]);
  });
  it('is case-blind about the scheme and the field names', () => {
    expect(parseMailto('MAILTO:a@x.test?Subject=Hi&CC=c@x.test')).toMatchObject({ subject: 'Hi', cc: [addr('c@x.test')] });
  });
  it('escapes the body: a link cannot put markup in the message', () => {
    expect(parseMailto('mailto:a@x.test?body=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E').bodyHtml).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });
  it('keeps blank lines in the body', () => {
    expect(parseMailto('mailto:?body=a%0A%0Ab').bodyHtml).toBe('<p>a</p><p></p><p>b</p>');
  });
  it('puts a subject on one line', () => {
    expect(parseMailto('mailto:?subject=a%0D%0ABcc:%20evil@x.test').subject).toBe('a Bcc: evil@x.test');
  });
  it('ignores other headers', () => {
    const f = parseMailto('mailto:a@x.test?in-reply-to=%3C1@x%3E&attach=/etc/passwd&from=boss@x.test');
    expect(f).toEqual({ to: [addr('a@x.test')], cc: [], bcc: [], subject: '', bodyHtml: '' });
  });
  it('survives bad percent-encoding', () => {
    expect(parseMailto('mailto:a@x.test?subject=100%').subject).toBe('100%');
  });
  it('gives empty fields for anything that is no mailto: link', () => {
    for (const link of ['', 'https://example.com', 'javascript:alert(1)', 'web+mailto:a@x.test']) {
      expect(parseMailto(link)).toEqual({ to: [], cc: [], bcc: [], subject: '', bodyHtml: '' });
    }
  });
});

describe('fieldsFromSearch', () => {
  it('reads the link the browser put in place of %s', () => {
    const search = `?mailto=${encodeURIComponent('mailto:bob@x.test?subject=Hi%20Bob')}`;
    expect(fieldsFromSearch(search)).toMatchObject({ to: [addr('bob@x.test')], subject: 'Hi Bob' });
  });
  it('gives empty fields for a plain /compose', () => {
    expect(fieldsFromSearch('')).toEqual({ to: [], cc: [], bcc: [], subject: '', bodyHtml: '' });
  });
});
