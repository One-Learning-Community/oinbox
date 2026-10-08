import type { Email, EmailAddress, EmailBodyPart, EmailBodyStructure } from '../jmap/types';
import type { EmailRec } from '../sync/engine';
import { displayName } from './participants';
import { escapeHtml, plainTextToHtml, sanitizeEmailHtml } from './sanitize';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface DraftAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export interface InlineImage {
  /** Content-ID without angle brackets; the HTML refers to it as cid:<cid>. */
  cid: string;
  blobId: string;
  type: string;
  name: string;
  size: number;
}

export interface Draft {
  mode: ComposeMode;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  inReplyTo: string[];
  references: string[];
  /** Quoted original (reply) or forwarded message, appended after the user's text. */
  quoteHtml: string;
  /** The identity's signature, kept apart from the text so From can swap it; '' for none. */
  signatureHtml: string;
  bodyHtml: string;
  attachments: DraftAttachment[];
  /** Images the HTML refers to by cid:. The HTML never holds an object URL. */
  inline: InlineImage[];
}

const lower = (a: EmailAddress) => a.email.toLowerCase();

function dedupe(list: EmailAddress[], exclude: Set<string>): EmailAddress[] {
  const seen = new Set(exclude);
  const out: EmailAddress[] = [];
  for (const a of list) {
    if (seen.has(lower(a))) continue;
    seen.add(lower(a));
    out.push(a);
  }
  return out;
}

function prefixed(subject: string, prefix: 'Re' | 'Fwd'): string {
  const re = prefix === 'Re' ? /^\s*re\s*:/i : /^\s*(fwd?|fw)\s*:/i;
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

// Only the src attribute is rewritten, never the document: the editor must get back exactly what it gave.
const IMG_SRC = /(<img\b[^>]*?\ssrc=)(["'])(.*?)\2/gi;

const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The content id a cid: source names, or null for any other source. */
function cidOf(src: string): string | null {
  const v = unescapeAttr(src).trim();
  return /^cid:/i.test(v) ? v.slice(4).replace(/^<|>$/g, '') : null;
}

/** Content ids of the images this HTML refers to. */
export function referencedCids(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(IMG_SRC)) {
    const cid = cidOf(m[3]!);
    if (cid) out.add(cid);
  }
  return out;
}

/** For the editor: cid: sources become the object URLs in `urls` (content id to URL). An image without one keeps its cid:. */
export function toEditorHtml(html: string, urls: Record<string, string>): string {
  return html.replace(IMG_SRC, (all, pre: string, q: string, src: string) => {
    const cid = cidOf(src);
    const url = cid === null ? undefined : urls[cid];
    return url ? `${pre}${q}${url}${q}` : all;
  });
}

/** From the editor: object URLs become cid: sources again. */
export function fromEditorHtml(html: string, urls: Record<string, string>): string {
  const cids = new Map(Object.entries(urls).map(([cid, url]) => [url, cid]));
  return html.replace(IMG_SRC, (all, pre: string, q: string, src: string) => {
    const cid = cids.get(unescapeAttr(src));
    return cid === undefined ? all : `${pre}${q}cid:${escapeHtml(cid)}${q}`;
  });
}

const bareCid = (cid: string | null) => cid?.replace(/^<|>$/g, '') ?? '';

/** Sort a stored message's parts: an image the HTML refers to by content id is inline, the rest are attachments. */
export function splitParts(html: string, parts: EmailBodyPart[]): { inline: InlineImage[]; attachments: DraftAttachment[] } {
  const used = referencedCids(html);
  const inline: InlineImage[] = [];
  const attachments: DraftAttachment[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    // Stalwart can list one image under both htmlBody and attachments.
    if (!p.blobId || seen.has(p.blobId)) continue;
    seen.add(p.blobId);
    const cid = bareCid(p.cid);
    if (cid && p.type.startsWith('image/') && used.has(cid)) {
      if (!inline.some((i) => i.cid === cid)) inline.push({ cid, blobId: p.blobId, type: p.type, name: p.name ?? 'image', size: p.size });
    } else attachments.push({ blobId: p.blobId, name: p.name ?? 'attachment', type: p.type, size: p.size });
  }
  return { inline, attachments };
}

/** Old blob id to new, for a draft's parts as the server stored them: images by content id, attachments by name and type, in order. */
export function blobIdChanges(draft: Draft, stored: EmailBodyPart[]): Map<string, string> {
  const now = splitParts(draftHtml(draft), stored);
  const changes = new Map<string, string>();
  for (const i of draft.inline) {
    const s = now.inline.find((x) => x.cid === i.cid);
    if (s && s.blobId !== i.blobId) changes.set(i.blobId, s.blobId);
  }
  const left = [...now.attachments];
  for (const a of draft.attachments) {
    const at = left.findIndex((s) => s.name === a.name && s.type === a.type);
    if (at < 0) continue;
    const [s] = left.splice(at, 1);
    if (s!.blobId !== a.blobId) changes.set(a.blobId, s!.blobId);
  }
  return changes;
}

export function withBlobIds(draft: Draft, changes: Map<string, string>): Draft {
  const swap = <T extends { blobId: string }>(x: T): T => (changes.has(x.blobId) ? { ...x, blobId: changes.get(x.blobId)! } : x);
  return { ...draft, inline: draft.inline.map(swap), attachments: draft.attachments.map(swap) };
}

/** Parse "Name <a@b>, c@d; "Last, First" <e@f>" into addresses. Invalid bits are dropped. */
export function parseAddressList(input: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  const re = /\s*(?:"([^"]*)"|([^,;<"]*?))\s*<([^>\s]+@[^>\s]+)>|([^\s,;<>"]+@[^\s,;<>"]+)/g;
  for (const m of input.matchAll(re)) {
    if (m[3]) out.push({ name: (m[1] ?? m[2] ?? '').trim() || null, email: m[3] });
    else if (m[4]) out.push({ name: null, email: m[4] });
  }
  return out;
}

const CID_MARK = /<img\b[^>]*?\sdata-oinbox-cid="([^"]*)"[^>]*>/gi;

/** The original's parts a quote can refer to or carry along. */
function originalParts(e: EmailRec): EmailBodyPart[] {
  // Stalwart lists an inline image under htmlBody when the sender put it beside the body.
  return [...(e.attachments ?? []), ...(e.htmlBody ?? []).filter((p) => p.cid && p.type.startsWith('image/'))];
}

function originalHtml(e: EmailRec): string {
  const values = e.bodyValues ?? {};
  const html = (e.htmlBody ?? []).filter((p) => p.type === 'text/html' && p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('');
  if (html.trim()) {
    // The sanitizer takes the source off cid: images and marks them. In a quote, the ones the
    // original has a part for get their cid: back: the new message carries that part.
    const known = new Set(originalParts(e).filter((p) => p.blobId && p.type.startsWith('image/')).map((p) => bareCid(p.cid)));
    return sanitizeEmailHtml(html, { allowRemote: false }).html.replace(CID_MARK, (tag, raw: string) =>
      known.has(unescapeAttr(raw)) ? tag.replace(/\sdata-oinbox-cid="[^"]*"/, ` src="cid:${raw}"`) : tag,
    );
  }
  const text = (e.textBody ?? []).filter((p) => p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('\n');
  return `<div style="white-space:pre-wrap">${plainTextToHtml(text || e.preview || '')}</div>`;
}

function when(e: EmailRec): string {
  const d = new Date(e.sentAt ?? e.receivedAt ?? Date.now());
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function initialDraft(mode: ComposeMode, original: EmailRec | null, me: Set<string>): Draft {
  const empty: Draft = { mode, to: [], cc: [], bcc: [], subject: '', inReplyTo: [], references: [], quoteHtml: '', signatureHtml: '', bodyHtml: '', attachments: [], inline: [] };
  if (!original || mode === 'new') return empty;

  const from = original.from ?? [];
  const sender = from[0];
  const subject = original.subject ?? '';
  const quoted = originalHtml(original);
  // Blobs are reused, not uploaded again; the first save gives the draft copies of its own.
  const carried = splitParts(quoted, originalParts(original));

  if (mode === 'forward') {
    const header = [
      '---------- Forwarded message ---------',
      `From: ${escapeHtml(from.map(formatAddress).join(', '))}`,
      `Date: ${escapeHtml(when(original))}`,
      `Subject: ${escapeHtml(subject)}`,
      `To: ${escapeHtml((original.to ?? []).map(formatAddress).join(', '))}`,
      ...(original.cc?.length ? [`Cc: ${escapeHtml(original.cc.map(formatAddress).join(', '))}`] : []),
    ].join('<br>');
    return { ...empty, subject: prefixed(subject, 'Fwd'), quoteHtml: `<br><div class="gmail_quote">${header}<br><br>${quoted}</div>`, inline: carried.inline, attachments: carried.attachments };
  }

  const fromMe = !!sender && me.has(lower(sender));
  let to: EmailAddress[];
  let cc: EmailAddress[] = [];
  if (fromMe) {
    // Replying to my own message continues the conversation with its recipients.
    to = original.to ?? [];
    if (mode === 'replyAll') cc = original.cc ?? [];
  } else {
    to = original.replyTo?.length ? original.replyTo : from;
    if (mode === 'replyAll') {
      to = [...to, ...(original.to ?? [])];
      cc = original.cc ?? [];
    }
  }
  const toList = dedupe(to, fromMe ? new Set() : me);
  const ccList = dedupe(cc, new Set([...me, ...toList.map(lower)]));

  const messageId = original.messageId ?? [];
  const attribution = `On ${escapeHtml(when(original))} ${escapeHtml(displayName(sender))}${sender ? ` &lt;${escapeHtml(sender.email)}&gt;` : ''} wrote:`;
  return {
    ...empty,
    to: toList,
    cc: ccList,
    subject: prefixed(subject, 'Re'),
    inReplyTo: messageId,
    references: [...(original.references ?? []), ...messageId],
    inline: carried.inline,
    quoteHtml: `<br><div class="gmail_quote"><div class="gmail_attr">${attribution}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted}</blockquote></div>`,
  };
}

/** Plain-text alternative of an HTML body. An inline image reads "[image: name]". */
export function htmlToText(html: string, images: InlineImage[] = []): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of doc.querySelectorAll('img')) {
    const cid = cidOf(img.getAttribute('src') ?? '');
    const name = images.find((i) => i.cid === cid)?.name;
    img.replaceWith(name ? `[image: ${name}]\n` : '');
  }
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
  for (const el of doc.querySelectorAll('p, div, li, h1, h2, h3, blockquote, tr')) el.append('\n');
  for (const bq of doc.querySelectorAll('blockquote')) {
    bq.textContent = (bq.textContent ?? '').replace(/\n+$/, '').split('\n').map((l) => `> ${l}`).join('\n') + '\n';
  }
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** A draft's whole HTML: the text, the signature block, the quote. */
export function draftHtml(draft: Draft): string {
  const signature = draft.signatureHtml ? `<div class="oinbox-signature">${draft.signatureHtml}</div>` : '';
  return draft.bodyHtml + signature + draft.quoteHtml;
}

/**
 * The Email object for Email/set create (RFC 8621 §4.6), stored as a draft. The structure is
 * spelled out: given htmlBody and attachments, Stalwart puts an inline image beside the body
 * (multipart/mixed) instead of with the HTML (multipart/related), and some clients show it twice.
 */
export function buildEmailCreate(draft: Draft, from: EmailAddress, draftsId: string): Partial<Email> {
  const html = draftHtml(draft);
  // "-- " on its own line is the delimiter mail clients use to recognise a signature.
  const text = [
    htmlToText(draft.bodyHtml, draft.inline).trimEnd(),
    draft.signatureHtml ? `-- \n${htmlToText(draft.signatureHtml).trimEnd()}` : '',
    draft.quoteHtml ? htmlToText(draft.quoteHtml, draft.inline).trim() : '',
  ].filter(Boolean).join('\n\n') + '\n';

  // An image the user deleted from the text stays in the draft (undo brings it back) but not in the message.
  const used = referencedCids(html);
  const images: EmailBodyStructure[] = draft.inline.filter((i) => used.has(i.cid)).map((i) => ({ blobId: i.blobId, type: i.type, name: i.name, cid: i.cid, disposition: 'inline' }));
  const files: EmailBodyStructure[] = draft.attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' }));
  const htmlPart: EmailBodyStructure = { partId: 'html', type: 'text/html' };
  const body: EmailBodyStructure = {
    type: 'multipart/alternative',
    subParts: [{ partId: 'text', type: 'text/plain' }, images.length ? { type: 'multipart/related', subParts: [htmlPart, ...images] } : htmlPart],
  };
  return {
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true, $seen: true },
    from: [from],
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    ...(draft.inReplyTo.length ? { inReplyTo: draft.inReplyTo } : {}),
    ...(draft.references.length ? { references: draft.references } : {}),
    bodyValues: {
      text: { value: text, isEncodingProblem: false, isTruncated: false },
      html: { value: html, isEncodingProblem: false, isTruncated: false },
    },
    bodyStructure: files.length ? { type: 'multipart/mixed', subParts: [body, ...files] } : body,
  };
}

/** Take a saved draft's HTML apart again: the text, the top-level signature block, and what follows it (the quote). */
export function splitDraftHtml(html: string): { bodyHtml: string; signatureHtml: string; quoteHtml: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = [...doc.body.childNodes];
  const at = nodes.findIndex((n) => n instanceof Element && n.matches('div.oinbox-signature'));
  if (at < 0) return { bodyHtml: html, signatureHtml: '', quoteHtml: '' };
  const serialize = (list: ChildNode[]) => list.map((n) => (n instanceof Element ? n.outerHTML : escapeHtml(n.textContent ?? ''))).join('');
  return { bodyHtml: serialize(nodes.slice(0, at)), signatureHtml: sanitizeEmailHtml((nodes[at] as Element).innerHTML, { allowRemote: true }).html, quoteHtml: serialize(nodes.slice(at + 1)) };
}
