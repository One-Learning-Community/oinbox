import { describe, expect, it } from 'vitest';
import { buildFrameDocument, plainTextToHtml, sanitizeEmailHtml } from './sanitize';

function body(html: string) {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

describe('sanitizeEmailHtml', () => {
  it('strips scripts, event handlers, forms, and javascript: links', () => {
    const r = sanitizeEmailHtml(
      '<p onclick="x()">Hi<script>alert(1)</script></p><form action="/x"><input name=a></form><a href="javascript:alert(1)">x</a><iframe src="https://x"></iframe>',
      { allowRemote: false },
    );
    const b = body(r.html);
    expect(b.querySelector('script, form, input, iframe')).toBeNull();
    expect(b.querySelector('p')!.getAttribute('onclick')).toBeNull();
    expect(b.querySelector('a')!.getAttribute('href')).toBeNull();
  });

  it('blocks remote images by default and reports them', () => {
    const r = sanitizeEmailHtml('<img src="https://track.example/p.gif" srcset="https://x/a.png 2x"><img src="data:image/png;base64,AAAA">', {
      allowRemote: false,
    });
    const imgs = body(r.html).querySelectorAll('img');
    expect(r.hasRemoteContent).toBe(true);
    expect(imgs[0]!.getAttribute('src')).toBeNull();
    expect(imgs[0]!.getAttribute('srcset')).toBeNull();
    expect(imgs[0]!.getAttribute('data-oinbox-src')).toBe('https://track.example/p.gif');
    expect(imgs[1]!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('flags remote CSS backgrounds', () => {
    expect(sanitizeEmailHtml('<div style="background:url(https://x/bg.png)">x</div>', { allowRemote: false }).hasRemoteContent).toBe(true);
    expect(sanitizeEmailHtml('<table><tr><td background="http://x/bg.png">x</td></tr></table>', { allowRemote: false }).hasRemoteContent).toBe(true);
  });

  it('keeps remote images when allowed', () => {
    const r = sanitizeEmailHtml('<img src="https://x/a.png">', { allowRemote: true });
    expect(body(r.html).querySelector('img')!.getAttribute('src')).toBe('https://x/a.png');
    expect(r.hasRemoteContent).toBe(true);
  });

  it('rewrites cid: images for later blob substitution', () => {
    const r = sanitizeEmailHtml('<img src="cid:logo@x">', { allowRemote: false });
    const img = body(r.html).querySelector('img')!;
    expect(img.getAttribute('src')).toBeNull();
    expect(img.getAttribute('data-oinbox-cid')).toBe('logo@x');
    expect(r.cids).toEqual(['logo@x']);
  });

  it('opens links in a new tab without opener or referrer', () => {
    const a = body(sanitizeEmailHtml('<a href="https://x.test">x</a>', { allowRemote: false }).html).querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps embedded style sheets', () => {
    expect(sanitizeEmailHtml('<style>p{color:red}</style><p>x</p>', { allowRemote: false }).html).toContain('p{color:red}');
  });
});

describe('buildFrameDocument', () => {
  it('sets a CSP that allows remote images only when asked', () => {
    expect(buildFrameDocument('<p>x</p>', { allowRemote: false, dark: false })).toMatch(/img-src data: blob:;/);
    expect(buildFrameDocument('<p>x</p>', { allowRemote: true, dark: false })).toMatch(/img-src data: blob: https: http:;/);
    expect(buildFrameDocument('<p>x</p>', { allowRemote: false, dark: false })).toMatch(/default-src 'none'/);
  });
});

describe('plainTextToHtml', () => {
  it('escapes HTML and links URLs', () => {
    expect(plainTextToHtml('<b>hi</b> see https://x.test/a?b=1&c=2.')).toBe(
      '&lt;b&gt;hi&lt;/b&gt; see <a href="https://x.test/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https://x.test/a?b=1&amp;c=2</a>.',
    );
  });
});

describe('snippetHtml', () => {
  it('keeps <mark> and strips everything else', async () => {
    const { snippetHtml } = await import('./sanitize');
    expect(snippetHtml('the <mark>budget</mark> <img src=x onerror=alert(1)><b>x</b>')).toBe('the <mark>budget</mark> x');
  });
});
