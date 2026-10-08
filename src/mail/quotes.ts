// Detect the quoted tail of a reply so the conversation view can hide it behind "…".
// Only a TRAILING quote is folded: inline-interleaved replies stay visible.

const WROTE_RE = /^(On\b.*|.*\bwrote:?)\s*$/i;
const ORIGINAL_RE = /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i;

export interface PlainSplit {
  body: string;
  quote: string | null;
}

export function splitPlainQuote(text: string): PlainSplit {
  const lines = text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');

  // Outlook-style separator: everything after it is quoted.
  const orig = lines.findIndex((l) => ORIGINAL_RE.test(l.trim()));
  if (orig > 0) return result(lines, orig);

  // Walk back over the trailing run of quoted (>) and blank lines.
  let start = lines.length;
  while (start > 0 && /^\s*(>|$)/.test(lines[start - 1]!)) start--;
  if (start === lines.length || !lines.slice(start).some((l) => l.trim().startsWith('>'))) {
    return { body: text, quote: null };
  }
  // Skip blank lines at the top of the quote block.
  while (lines[start]?.trim() === '') start++;

  // Include an "On … wrote:" attribution (possibly wrapped over two lines).
  const prev = lines[start - 1]?.trim() ?? '';
  const prev2 = lines[start - 2]?.trim() ?? '';
  if (/wrote:?$/i.test(prev) && /^On\b/i.test(prev2) && !/wrote:?$/i.test(prev2)) start -= 2;
  else if (WROTE_RE.test(prev) && prev !== '') start -= 1;

  if (start === 0) return { body: text, quote: null };
  return result(lines, start);
}

function result(lines: string[], start: number): PlainSplit {
  return {
    body: lines.slice(0, start).join('\n').replace(/\s+$/, ''),
    quote: lines.slice(start).join('\n'),
  };
}

const QUOTE_SELECTORS = [
  '.gmail_quote',
  'blockquote[type="cite"]',
  '#divRplyFwdMsg',
  '#appendonsend',
  '.moz-cite-prefix',
  '.yahoo_quoted',
  'blockquote.protonmail_quote',
];

/**
 * Wrap the trailing quoted part of an HTML body in a `[data-oinbox-quote]` element.
 * Returns true when something was folded.
 */
export function foldHtmlQuote(doc: Document): boolean {
  const marker = doc.body.querySelector<HTMLElement>(QUOTE_SELECTORS.join(','));
  if (!marker) return false;

  // Climb to the direct child of <body> that contains the marker, then fold from
  // there to the end, provided nothing substantive follows the quote.
  let top: Element = marker;
  while (top.parentElement && top.parentElement !== doc.body) {
    const parent: HTMLElement = top.parentElement;
    if (hasTextAfter(top, parent)) return false;
    top = parent;
  }
  let start: Element = top;
  if (hasTextAfter(top, doc.body)) {
    // Outlook's header block is followed by the quoted original as siblings; that is still the tail.
    if (!marker.matches('#divRplyFwdMsg, #appendonsend')) return false;
  }

  // Pull in a preceding "On … wrote:" attribution line.
  const prev = previousElement(start);
  if (prev && WROTE_RE.test((prev.textContent ?? '').trim()) && (prev.textContent ?? '').length < 300) start = prev;

  const fold = doc.createElement('div');
  fold.setAttribute('data-oinbox-quote', '');
  start.before(fold);
  let n: ChildNode | null = fold.nextSibling;
  while (n) {
    const next: ChildNode | null = n.nextSibling;
    fold.append(n);
    n = next;
  }
  return true;
}

function previousElement(el: Element): Element | null {
  let p = el.previousSibling;
  while (p && p.nodeType === 3 && !(p.textContent ?? '').trim()) p = p.previousSibling;
  return p && p.nodeType === 1 ? (p as Element) : null;
}

function hasTextAfter(node: Element, parent: Element): boolean {
  let n = node.nextSibling;
  while (n) {
    if (n.parentNode !== parent) break;
    const text = (n.textContent ?? '').trim();
    if (text) return true;
    if (n.nodeType === 1 && (n as Element).querySelector('img')) return true;
    n = n.nextSibling;
  }
  return false;
}

/**
 * Put the `[data-oinbox-quote]` element behind a "•••" toggle. It is a `<details>`, not a button
 * with a click handler: the message frame runs no scripts, and WebKit won't run a listener in such
 * a frame even when the parent page added it.
 */
export function foldBehindToggle(doc: Document): void {
  const quote = doc.body.querySelector('[data-oinbox-quote]');
  if (!quote) return;
  const details = doc.createElement('details');
  details.className = 'oinbox-quote';
  const summary = doc.createElement('summary');
  summary.className = 'oinbox-quote-toggle';
  summary.title = 'Show trimmed content';
  summary.setAttribute('aria-label', 'Show trimmed content');
  summary.textContent = '•••';
  quote.before(details);
  details.append(summary, quote);
}
