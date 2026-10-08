// Test-side helpers that talk to the running dev stack directly:
//  - JMAP over Basic auth (Stalwart accepts it; handy for arranging and verifying state)
//  - raw SMTP to the MTA on localhost:2525 (no host tooling needed)
import net from 'node:net';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
export const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 2525);
export const PASSWORD = 'oinbox-dev-pass';
export const ALICE = 'alice@example.test';
export const BOB = 'bob@example.test';

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
type Invocation = [string, Record<string, unknown>, string];

const auth = (user: string) => 'Basic ' + Buffer.from(`${user}:${PASSWORD}`).toString('base64');
const accountIds = new Map<string, string>();

export async function accountId(user = ALICE): Promise<string> {
  let id = accountIds.get(user);
  if (!id) {
    const res = await fetch(`${BASE}/jmap/session`, { headers: { authorization: auth(user) } });
    if (!res.ok) throw new Error(`session for ${user}: HTTP ${res.status}`);
    const s = (await res.json()) as { primaryAccounts: Record<string, string> };
    id = s.primaryAccounts['urn:ietf:params:jmap:mail']!;
    accountIds.set(user, id);
  }
  return id;
}

/** Run method calls; returns responses keyed by call tag. Throws on method-level errors. */
export async function jmap(calls: Invocation[], user = ALICE, using: string[] = USING): Promise<Record<string, any>> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${BASE}/jmap/`, {
      method: 'POST',
      headers: { authorization: auth(user), 'content-type': 'application/json' },
      body: JSON.stringify({ using, methodCalls: calls }),
    });
    if (res.ok) break;
    const detail = await res.text();
    // Stalwart runs four requests per account at once; the page under test shares that allowance.
    if (attempt < 5 && detail.includes('maxConcurrentRequests')) {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      continue;
    }
    throw new Error(`JMAP HTTP ${res.status}: ${detail}`);
  }
  const body = (await res.json()) as { methodResponses: Invocation[] };
  const out: Record<string, any> = {};
  for (const [name, args, tag] of body.methodResponses) {
    if (name === 'error') throw new Error(`JMAP error in ${tag}: ${JSON.stringify(args)}`);
    for (const k of ['notCreated', 'notUpdated', 'notDestroyed'])
      if (args[k] && Object.keys(args[k] as object).length) throw new Error(`${name} ${k}: ${JSON.stringify(args[k])}`);
    out[tag] = args;
  }
  return out;
}

export async function mailboxByRole(role: string, user = ALICE): Promise<string> {
  const acct = await accountId(user);
  const r = await jmap([['Mailbox/get', { accountId: acct, properties: ['role'] }, 'm']], user);
  const mb = (r.m.list as { id: string; role: string | null }[]).find((m) => m.role === role);
  if (!mb) throw new Error(`no ${role} mailbox`);
  return mb.id;
}

export interface EmailInfo {
  id: string;
  threadId: string;
  subject: string;
  receivedAt: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: { name: string | null; email: string }[] | null;
  messageId: string[] | null;
}

const EMAIL_PROPS = ['threadId', 'subject', 'receivedAt', 'mailboxIds', 'keywords', 'from', 'messageId'];

/** All emails (any mailbox) whose subject contains `subject`, oldest first. */
export async function emailsBySubject(subject: string, user = ALICE): Promise<EmailInfo[]> {
  const acct = await accountId(user);
  const r = await jmap(
    [
      ['Email/query', { accountId: acct, filter: { subject }, sort: [{ property: 'receivedAt', isAscending: true }] }, 'q'],
      ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: EMAIL_PROPS }, 'g'],
    ],
    user,
  );
  return r.g.list as EmailInfo[];
}

/** Every email of a thread, oldest first (by receivedAt, as the conversation view orders them). */
export async function threadEmails(threadId: string, user = ALICE): Promise<EmailInfo[]> {
  const acct = await accountId(user);
  const r = await jmap(
    [
      ['Thread/get', { accountId: acct, ids: [threadId] }, 't'],
      ['Email/get', { accountId: acct, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: EMAIL_PROPS }, 'g'],
    ],
    user,
  );
  return (r.g.list as EmailInfo[]).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

export async function updateEmails(patches: Record<string, Record<string, unknown>>, user = ALICE): Promise<void> {
  if (!Object.keys(patches).length) return;
  await jmap([['Email/set', { accountId: await accountId(user), update: patches }, 's']], user);
}

export async function destroyEmails(ids: string[], user = ALICE): Promise<void> {
  if (!ids.length) return;
  await jmap([['Email/set', { accountId: await accountId(user), destroy: ids }, 'd']], user);
}

/**
 * Mark every email in a thread read. Only sends a request when something is unread, so an
 * already-arranged mailbox produces no StateChange that could reach a page opened next.
 * Returns the (updated) emails and whether anything changed.
 */
export async function markThreadRead(threadId: string, user = ALICE): Promise<EmailInfo[] & { changed?: boolean }> {
  const emails: EmailInfo[] & { changed?: boolean } = await threadEmails(threadId, user);
  const unread = emails.filter((e) => !e.keywords?.$seen);
  await updateEmails(Object.fromEntries(unread.map((e) => [e.id, { 'keywords/$seen': true }])), user);
  for (const e of unread) e.keywords = { ...e.keywords, $seen: true };
  emails.changed = unread.length > 0;
  return emails;
}

/** Put emails back into a mailbox if they aren't there. Returns true when anything changed. */
export async function ensureInMailbox(emails: EmailInfo[], mailboxId: string, user = ALICE): Promise<boolean> {
  const missing = emails.filter((e) => !e.mailboxIds[mailboxId]);
  await updateEmails(Object.fromEntries(missing.map((e) => [e.id, { [`mailboxIds/${mailboxId}`]: true }])), user);
  return missing.length > 0;
}

/** Poll until `fn` returns a truthy value. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function uniqueTag(prefix = 'e2e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------- SMTP

export interface OutgoingMail {
  from: string; // "Name <addr>" or addr
  to: string[]; // envelope + To header
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
}

const addrOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim();

/** Deliver one message to Stalwart's MTA over plain SMTP. Returns the Message-ID (without <>). */
export async function sendMail(m: OutgoingMail): Promise<string> {
  const messageId = m.messageId ?? `${uniqueTag('msg')}@e2e.test`;
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to.join(', ')}`,
    `Subject: ${m.subject}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`, `References: <${m.inReplyTo}>`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const body = m.text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  const data = `${headers.join('\r\n')}\r\n\r\n${body}\r\n.\r\n`;

  const sock = net.connect(SMTP_PORT, 'localhost');
  sock.setEncoding('utf8');
  let buf = '';
  const waiters: ((line: string) => void)[] = [];
  sock.on('data', (chunk: string) => {
    buf += chunk;
    // A reply is complete at a line "NNN <text>" (space, not dash, after the code).
    for (;;) {
      const m2 = /^(\d{3}) .*\r?\n/m.exec(buf);
      if (!m2) break;
      const end = m2.index + m2[0].length;
      const reply = buf.slice(0, end);
      buf = buf.slice(end);
      waiters.shift()?.(reply);
    }
  });
  const reply = () =>
    new Promise<string>((resolve, reject) => {
      waiters.push(resolve);
      sock.once('error', reject);
    });
  const expect = async (cmd: string | null, code: string) => {
    const p = reply();
    if (cmd !== null) sock.write(cmd);
    const r = await p;
    const last = r.trimEnd().split(/\r?\n/).pop()!;
    if (!last.startsWith(code)) throw new Error(`SMTP ${cmd?.trim() ?? 'greeting'} -> ${r.trim()}`);
  };
  try {
    await expect(null, '220');
    await expect('EHLO e2e.test\r\n', '250');
    await expect(`MAIL FROM:<${addrOf(m.from)}>\r\n`, '250');
    for (const rcpt of m.to) await expect(`RCPT TO:<${addrOf(rcpt)}>\r\n`, '250');
    await expect('DATA\r\n', '354');
    await expect(data, '250');
    await expect('QUIT\r\n', '221');
  } finally {
    sock.destroy();
  }
  return messageId;
}

/** Deliver to alice and wait until the message is visible over JMAP; returns its email record. */
export async function deliverToAlice(m: Omit<OutgoingMail, 'to'>): Promise<EmailInfo> {
  const messageId = await sendMail({ ...m, to: [ALICE] });
  return waitFor(
    async () => (await emailsBySubject(m.subject)).find((e) => e.messageId?.includes(messageId)),
    15_000,
    `delivery of "${m.subject}"`,
  );
}
