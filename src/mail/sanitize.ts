import DOMPurify from 'dompurify';

export interface SanitizeOptions {
  allowRemote: boolean;
}

export interface SanitizedHtml {
  html: string;
  /** The message references remote images or backgrounds (blocked unless allowed). */
  hasRemoteContent: boolean;
  /** Content-IDs of inline images to resolve to blob URLs. */
  cids: string[];
}

const REMOTE_RE = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_RE = /url\(\s*['"]?\s*(https?:)?\/\//i;

const FORBID_TAGS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'base', 'meta', 'link', 'svg', 'math'];

/**
 * Sanitize an HTML email body. The result is still only ever rendered inside a
 * script-less sandboxed iframe with a strict CSP (see buildFrameDocument); this
 * pass removes active content and rewrites remote/cid images.
 */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions): SanitizedHtml {
  let hasRemoteContent = false;
  const cids: string[] = [];

  const hook = (node: Element) => {
    if (node.nodeName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    for (const attr of ['background', 'poster']) {
      const v = node.getAttribute(attr);
      if (v && REMOTE_RE.test(v)) {
        hasRemoteContent = true;
        if (!opts.allowRemote) node.removeAttribute(attr);
      }
    }
    const style = node.getAttribute('style');
    if (style && CSS_REMOTE_RE.test(style)) hasRemoteContent = true;

    if (node.nodeName === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      if (/^cid:/i.test(src)) {
        const cid = src.slice(4).replace(/^<|>$/g, '');
        cids.push(cid);
        node.setAttribute('data-oinbox-cid', cid);
        node.removeAttribute('src');
      } else if (REMOTE_RE.test(src) || node.hasAttribute('srcset')) {
        hasRemoteContent = true;
        if (!opts.allowRemote) {
          if (src) node.setAttribute('data-oinbox-src', src);
          node.removeAttribute('src');
          node.removeAttribute('srcset');
        }
      }
    }
  };

  DOMPurify.addHook('afterSanitizeAttributes', hook);
  try {
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: false,
      FORCE_BODY: true,
      ADD_TAGS: ['style'],
      ADD_ATTR: ['target', 'background', 'bgcolor', 'align', 'valign', 'cellpadding', 'cellspacing', 'border'],
      FORBID_TAGS,
      ALLOW_DATA_ATTR: false,
      // cid: is rewritten in the hook; keep it past the URI filter.
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    });
    // style tags can also pull remote content (@import, url()).
    if (/@import|url\(\s*['"]?\s*(https?:)?\/\//i.test(clean) && /<style/i.test(clean)) hasRemoteContent = true;
    return { html: clean, hasRemoteContent, cids };
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

export interface FrameOptions {
  allowRemote: boolean;
  dark: boolean;
  /** Inset HTML mail from its white card. */
  padded?: boolean;
}

/** Full srcdoc for the message iframe. No script-src: the iframe has no allow-scripts either. */
export function buildFrameDocument(bodyHtml: string, opts: FrameOptions): string {
  const img = opts.allowRemote ? 'data: blob: https: http:' : 'data: blob:';
  const csp = `default-src 'none'; img-src ${img}; media-src ${img}; style-src 'unsafe-inline'${opts.allowRemote ? ' https:' : ''}; font-src data:${opts.allowRemote ? ' https:' : ''}; form-action 'none'; base-uri 'none'`;
  const scheme = opts.dark ? 'dark' : 'light';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${scheme}"><style>
html,body{margin:0;padding:0;overflow:hidden}
body{${opts.padded ? 'padding:12px 16px;box-sizing:border-box;' : ''}font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:${opts.dark ? '#e3e3e3' : '#1f1f1f'};overflow-wrap:anywhere}
img{max-width:100%;height:auto}
pre{white-space:pre-wrap}
a{color:${opts.dark ? '#8ab4f8' : '#0b57d0'}}
blockquote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex}
details.oinbox-quote>summary{list-style:none}
details.oinbox-quote>summary::-webkit-details-marker{display:none}
.oinbox-quote-toggle{display:inline-block;margin:6px 0;padding:0 8px;border:0;border-radius:8px;background:${opts.dark ? '#444' : '#e8eaed'};color:inherit;font:bold 14px/1.2 system-ui;cursor:pointer;letter-spacing:1px}
</style></head><body>${bodyHtml}</body></html>`;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function plainTextToHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += escapeHtml(text.slice(last, m.index));
    const url = escapeHtml(m[0]);
    out += `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** SearchSnippet/get returns HTML with <mark> highlights; allow nothing else. */
export function snippetHtml(s: string): string {
  return DOMPurify.sanitize(s, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] });
}
