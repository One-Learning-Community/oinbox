import type { EmailAddress } from '../jmap/types';
import { parseAddressList } from '../mail/compose';
import { escapeHtml } from '../mail/sanitize';

/** What an email link fills in. */
export interface MailtoFields {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  /** The body as editor HTML, one paragraph a line; '' for none. */
  bodyHtml: string;
}

/** Where the browser sends an email link: it puts the whole link, encoded, in place of %s. */
export const MAILTO_HANDLER = '/compose?mailto=%s';

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Plain text to paragraphs, as the editor writes them. */
const textToHtml = (text: string): string =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : '<p></p>'))
    .join('');

/**
 * A mailto: link (RFC 6068) as composer fields. Only to, cc, bcc, subject and body are read: other
 * headers (In-Reply-To, attachments some clients accept) are ignored, so a link cannot do more than
 * a person typing could. Anything that is no mailto: link gives empty fields.
 */
export function parseMailto(link: string): MailtoFields {
  const out: MailtoFields = { to: [], cc: [], bcc: [], subject: '', bodyHtml: '' };
  const m = /^mailto:([^?#]*)(?:\?([^#]*))?/i.exec(link.trim());
  if (!m) return out;
  const to: string[] = [decode(m[1] ?? '')];
  const cc: string[] = [];
  const bcc: string[] = [];
  let body = '';
  for (const pair of (m[2] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    // RFC 6068 has no "+" for a space, but links written for forms do: there it is still a "+".
    const name = decode(pair.slice(0, eq)).toLowerCase();
    const value = decode(pair.slice(eq + 1));
    if (name === 'to') to.push(value);
    else if (name === 'cc') cc.push(value);
    else if (name === 'bcc') bcc.push(value);
    else if (name === 'subject' && !out.subject) out.subject = value.replace(/[\r\n]+/g, ' ').trim();
    else if (name === 'body' && !body) body = value;
  }
  const list = (parts: string[]) => {
    const seen = new Set<string>();
    return parts.flatMap(parseAddressList).filter((a) => !seen.has(a.email.toLowerCase()) && !!seen.add(a.email.toLowerCase()));
  };
  out.to = list(to);
  out.cc = list(cc);
  out.bcc = list(bcc);
  out.bodyHtml = body ? textToHtml(body) : '';
  return out;
}

/** The link the browser handed over at /compose?mailto=…, or empty fields for a plain /compose. */
export const fieldsFromSearch = (search: string): MailtoFields => parseMailto(new URLSearchParams(search).get('mailto') ?? '');
