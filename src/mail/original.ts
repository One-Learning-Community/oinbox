/**
 * "Show original": a message's headers, and what the checks Stalwart ran on it found. Only the
 * headers Stalwart writes by default are read; anything else is in the raw source below the summary.
 */

export interface Header {
  name: string;
  value: string;
}

/** The header lines of a raw message, unfolded, in order; the body is not read. */
export function headersOf(raw: string): Header[] {
  const end = raw.search(/\r?\n\r?\n/);
  const head = end < 0 ? raw : raw.slice(0, end);
  const out: Header[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) out.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return out;
}

export interface Check {
  result: string;
  detail?: string;
}

export interface SpamRule {
  name: string;
  score: number;
}

export interface Checks {
  spf?: Check;
  dkim: Check[];
  dmarc?: Check;
  spam?: { spam: boolean; score?: string; rules: SpamRule[] };
}

/** One `method=result (comment) prop=value …` clause of an Authentication-Results header. */
interface Clause {
  method: string;
  result: string;
  comment?: string;
  props: Record<string, string>;
}

/** Split on `;` outside parentheses: a comment may hold one. */
function clauses(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function clause(text: string): Clause | null {
  const m = /^([\w.-]+)\s*=\s*([\w.-]+)/.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const comment = /\(([^)]*)\)/.exec(rest)?.[1]?.trim();
  const props: Record<string, string> = {};
  for (const p of rest.replace(/\([^)]*\)/g, ' ').matchAll(/([\w.-]+)=("[^"]*"|\S+)/g)) props[p[1]!.toLowerCase()] = p[2]!.replace(/^"|"$/g, '');
  return { method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), comment, props };
}

const domainOf = (address: string | undefined) => address?.split('@').pop() || undefined;
/** The IP a SPF comment names: "designates 1.2.3.4 as …" or "… soft fail for 1.2.3.4". */
const ipIn = (text: string | undefined) => (text ? /(?:designates|for)\s+([0-9a-f.:]+[0-9a-f])/i.exec(text)?.[1] : undefined);

function spfCheck(result: string, comment: string | undefined, ip: string | undefined, domain: string | undefined): Check {
  const at = ipIn(comment) ?? ip;
  const detail = at ? `with IP ${at}` : domain ? `with domain ${domain}` : undefined;
  return detail ? { result, detail } : { result };
}

const get = (headers: Header[], name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

export function checksOf(headers: Header[]): Checks {
  const out: Checks = { dkim: [] };

  // Stalwart puts its own on top; ones further down came with the message, from other servers or the sender.
  const results = get(headers, 'Authentication-Results');
  const parsed = results ? clauses(results).slice(1).map(clause).filter((c): c is Clause => !!c && c.result !== 'none') : [];
  // SPF can be checked on the HELO name and on the mail-from address: the mail-from one is the one that counts.
  const spf = parsed.find((c) => c.method === 'spf' && c.props['smtp.mailfrom']) ?? parsed.find((c) => c.method === 'spf');
  if (spf) out.spf = spfCheck(spf.result, spf.comment, undefined, domainOf(spf.props['smtp.mailfrom'] ?? spf.props['smtp.helo']));
  else {
    const received = get(headers, 'Received-SPF');
    const m = received && /^([\w-]+)\s*(?:\(([^)]*)\))?/.exec(received);
    if (m && m[1]!.toLowerCase() !== 'none') {
      const ip = /client-ip=([^;\s]+)/i.exec(received!)?.[1];
      out.spf = spfCheck(m[1]!.toLowerCase(), m[2], ip, domainOf(/envelope-from="?([^";\s]+)/i.exec(received!)?.[1]));
    }
  }
  for (const c of parsed.filter((x) => x.method === 'dkim')) {
    const domain = c.props['header.d'] ?? domainOf(c.props['header.i']);
    out.dkim.push(domain ? { result: c.result, detail: `with domain ${domain}` } : { result: c.result });
  }
  const dmarc = parsed.find((c) => c.method === 'dmarc');
  if (dmarc) out.dmarc = dmarc.comment ? { result: dmarc.result, detail: dmarc.comment } : { result: dmarc.result };

  const status = get(headers, 'X-Spam-Status');
  const score = get(headers, 'X-Spam-Score');
  if (status || score) {
    const spam = status ? /^\s*yes\b/i.test(status) : /^\s*spam\b/i.test(score!);
    const value = /score=(-?[\d.]+)/i.exec(`${score ?? ''} ${status ?? ''}`)?.[1];
    const rules = [...(get(headers, 'X-Spam-Result') ?? '').matchAll(/([\w-]+)\s*\((-?[\d.]+)\)/g)]
      .map((m) => ({ name: m[1]!, score: Number(m[2]) }))
      .filter((r) => r.score !== 0)
      .sort((a, b) => b.score - a.score);
    out.spam = value ? { spam, score: value, rules } : { spam, rules };
  }
  return out;
}

/** About a megabyte of text: more than this and the page crawls, while the download still has it all. */
export const SHOWN_CHARS = 1_000_000;

export function shownSource(raw: string): { text: string; cut: boolean } {
  return raw.length > SHOWN_CHARS ? { text: raw.slice(0, SHOWN_CHARS), cut: true } : { text: raw, cut: false };
}
