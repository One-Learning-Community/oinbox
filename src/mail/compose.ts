import type { Email, EmailAddress } from '../jmap/types';
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

function originalHtml(e: EmailRec): string {
  const values = e.bodyValues ?? {};
  const html = (e.htmlBody ?? []).filter((p) => p.type === 'text/html' && p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('');
  if (html.trim()) return sanitizeEmailHtml(html, { allowRemote: false }).html;
  const text = (e.textBody ?? []).filter((p) => p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('\n');
  return `<div style="white-space:pre-wrap">${plainTextToHtml(text || e.preview || '')}</div>`;
}

function when(e: EmailRec): string {
  const d = new Date(e.sentAt ?? e.receivedAt ?? Date.now());
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function initialDraft(mode: ComposeMode, original: EmailRec | null, me: Set<string>): Draft {
  const empty: Draft = { mode, to: [], cc: [], bcc: [], subject: '', inReplyTo: [], references: [], quoteHtml: '', signatureHtml: '', bodyHtml: '', attachments: [] };
  if (!original || mode === 'new') return empty;

  const from = original.from ?? [];
  const sender = from[0];
  const subject = original.subject ?? '';

  if (mode === 'forward') {
    const header = [
      '---------- Forwarded message ---------',
      `From: ${escapeHtml(from.map(formatAddress).join(', '))}`,
      `Date: ${escapeHtml(when(original))}`,
      `Subject: ${escapeHtml(subject)}`,
      `To: ${escapeHtml((original.to ?? []).map(formatAddress).join(', '))}`,
      ...(original.cc?.length ? [`Cc: ${escapeHtml(original.cc.map(formatAddress).join(', '))}`] : []),
    ].join('<br>');
    return { ...empty, subject: prefixed(subject, 'Fwd'), quoteHtml: `<br><div class="gmail_quote">${header}<br><br>${originalHtml(original)}</div>` };
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
    quoteHtml: `<br><div class="gmail_quote"><div class="gmail_attr">${attribution}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${originalHtml(original)}</blockquote></div>`,
  };
}

/** Plain-text alternative of an HTML body. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
  for (const el of doc.querySelectorAll('p, div, li, h1, h2, h3, blockquote, tr')) el.append('\n');
  for (const bq of doc.querySelectorAll('blockquote')) {
    bq.textContent = (bq.textContent ?? '').replace(/\n+$/, '').split('\n').map((l) => `> ${l}`).join('\n') + '\n';
  }
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** The Email object for Email/set create (RFC 8621 §4.6), stored as a draft. */
export function buildEmailCreate(draft: Draft, from: EmailAddress, draftsId: string): Partial<Email> {
  const signature = draft.signatureHtml ? `<div class="oinbox-signature">${draft.signatureHtml}</div>` : '';
  const html = draft.bodyHtml + signature + draft.quoteHtml;
  // "-- " on its own line is the delimiter mail clients use to recognise a signature.
  const text = [
    htmlToText(draft.bodyHtml).trimEnd(),
    draft.signatureHtml ? `-- \n${htmlToText(draft.signatureHtml).trimEnd()}` : '',
    draft.quoteHtml ? htmlToText(draft.quoteHtml).trim() : '',
  ].filter(Boolean).join('\n\n') + '\n';
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
    textBody: [{ partId: 'text', type: 'text/plain' }] as Email['textBody'],
    htmlBody: [{ partId: 'html', type: 'text/html' }] as Email['htmlBody'],
    attachments: draft.attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' })) as Email['attachments'],
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
