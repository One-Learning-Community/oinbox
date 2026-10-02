// A real IMAP client (imapflow) standing in for "another mail client" (e.g. Thunderbird)
// mutating a mailbox out-of-band while oinbox's own JMAP/push session is live. Connects
// over IMAPS to the port docker-compose.yml publishes for the dev stack's Stalwart.
import { ImapFlow } from 'imapflow';
import { PASSWORD } from './mail';

export const IMAP_HOST = process.env.E2E_IMAP_HOST ?? 'localhost';
export const IMAP_PORT = Number(process.env.E2E_IMAP_PORT ?? 1993);

/** Open an authenticated IMAP connection. Caller must `imapClose()` it when done. */
export async function imapConnect(user: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    tls: { rejectUnauthorized: false }, // the dev stack uses Stalwart's self-signed cert
    auth: { user, pass: PASSWORD },
    logger: false,
  });
  await client.connect();
  return client;
}

export async function imapClose(client: ImapFlow): Promise<void> {
  await client.logout().catch(() => undefined);
}

/**
 * Find a message's UID by its Message-ID header, in the currently-open mailbox. Uses a plain
 * envelope FETCH rather than SEARCH: Stalwart's IMAP SEARCH appears to depend on the same search
 * index JMAP's Email/query does, which can lag briefly right after delivery, whereas FETCH reads
 * the mailbox directly. Test mailboxes are small, so scanning every message is cheap.
 */
async function findUid(client: ImapFlow, messageId: string): Promise<number> {
  const target = `<${messageId}>`;
  for await (const msg of client.fetch('1:*', { uid: true, envelope: true })) {
    if (msg.envelope?.messageId === target) return msg.uid;
  }
  throw new Error(`IMAP: no message with Message-ID ${target} in the open mailbox`);
}

/** Mark a message (\Seen or not), as another IMAP client would. */
export async function imapSetSeen(client: ImapFlow, messageId: string, seen: boolean, mailbox = 'INBOX'): Promise<void> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const uid = await findUid(client, messageId);
    await (seen ? client.messageFlagsAdd([uid], ['\\Seen'], { uid: true }) : client.messageFlagsRemove([uid], ['\\Seen'], { uid: true }));
  } finally {
    lock.release();
  }
}

/** Move a message to another mailbox, as another IMAP client would (COPY + \Deleted + EXPUNGE, or MOVE). */
export async function imapMove(client: ImapFlow, messageId: string, toMailbox: string, fromMailbox = 'INBOX'): Promise<void> {
  const lock = await client.getMailboxLock(fromMailbox);
  try {
    const uid = await findUid(client, messageId);
    // imapflow reports a refused move (e.g. no such mailbox) by returning false.
    const moved = await client.messageMove([uid], toMailbox, { uid: true });
    if (!moved) throw new Error(`IMAP could not move ${messageId} to ${toMailbox}`);
  } finally {
    lock.release();
  }
}

/** Permanently delete a message, as another IMAP client would (\Deleted + EXPUNGE). */
export async function imapDelete(client: ImapFlow, messageId: string, mailbox = 'INBOX'): Promise<void> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const uid = await findUid(client, messageId);
    await client.messageDelete([uid], { uid: true });
  } finally {
    lock.release();
  }
}
