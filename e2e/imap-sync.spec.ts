// Verifies oinbox stays in sync when mail is mutated by *another client* — modeled here as a
// real IMAP connection (see support/imap.ts), the way Thunderbird or any other IMAP client
// would touch the same mailbox while oinbox's own JMAP/push session is live.
import type { ImapFlow } from 'imapflow';
import { expect, test } from '@playwright/test';
import { openInbox, rowFor, waitLive } from './support/app';
import { imapClose, imapConnect, imapDelete, imapMove, imapSetSeen } from './support/imap';
import { createLabel, destroyLabel } from './support/labels';
import { ALICE, deliverToAlice, destroyEmails, sendMail, threadEmails, uniqueTag, waitFor } from './support/mail';

const created: string[] = [];
const labels: string[] = [];
test.afterEach(async () => {
  await destroyEmails(created.splice(0));
  for (const id of labels.splice(0)) await destroyLabel(id);
});

let imap: ImapFlow;
test.beforeAll(async () => {
  imap = await imapConnect(ALICE);
});
test.afterAll(async () => {
  await imapClose(imap);
});

test('marking a message read from another IMAP client updates the row live', async ({ page }) => {
  const msg = await deliverToAlice({ from: 'Reader Test <reader@partner.test>', subject: `IMAP read test ${uniqueTag()}`, text: 'hi' });
  created.push(msg.id);

  await openInbox(page);
  await waitLive(page);
  const row = rowFor(page, msg.threadId);
  await expect(row).toHaveClass(/\bunread\b/);

  await imapSetSeen(imap, msg.messageId![0]!, true);

  await expect(row).not.toHaveClass(/\bunread\b/, { timeout: 10_000 });
});

test('moving a message out of the inbox from another IMAP client removes the row live', async ({ page }) => {
  const msg = await deliverToAlice({ from: 'Mover Test <mover@partner.test>', subject: `IMAP move test ${uniqueTag()}`, text: 'hi' });
  created.push(msg.id);

  await openInbox(page);
  await waitLive(page);
  await expect(rowFor(page, msg.threadId)).toBeVisible();

  // Its own destination: a new account has no Archive mailbox until something is archived.
  const folder = uniqueTag();
  labels.push(await createLabel(folder));
  await imapMove(imap, msg.messageId![0]!, folder);

  await expect(rowFor(page, msg.threadId)).toHaveCount(0, { timeout: 10_000 });
});

test('deleting one message of an open thread from another IMAP client updates the conversation live', async ({ page }) => {
  const subject = `IMAP thread delete test ${uniqueTag()}`;
  const first = await deliverToAlice({ from: 'Thread Starter <starter@partner.test>', subject, text: 'first message' });
  // Note: not deliverToAlice here — its wait matches by subject search, which Stalwart's
  // search backend silently fails for any subject containing a colon (e.g. every "Re: ..."
  // reply). Waiting on thread membership instead sidesteps that and is what we actually want.
  await sendMail({ from: 'Thread Starter <starter@partner.test>', to: [ALICE], subject: `Re: ${subject}`, text: 'second message', inReplyTo: first.messageId![0]! });
  const emails = await waitFor(async () => {
    const es = await threadEmails(first.threadId);
    return es.length === 2 ? es : null;
  }, 15_000, 'reply to thread');
  // `first` gets deleted by the test itself (via IMAP); only the reply needs cleanup.
  created.push(...emails.map((e) => e.id).filter((id) => id !== first.id));

  await openInbox(page);
  await waitLive(page);
  await rowFor(page, first.threadId).click();
  await expect(page.locator('article.msg')).toHaveCount(2);

  await imapDelete(imap, first.messageId![0]!);

  await expect(page.locator('article.msg')).toHaveCount(1, { timeout: 10_000 });
});

// Not covered here: the cannotCalculateChanges full-resync path ("tab asleep for a while, then
// the server can no longer diff from our last-known state"). There's no reliable way to force
// Stalwart into that exact condition from a live e2e test without server-internal access, so
// that path is covered deterministically instead at the engine unit level — see
// src/sync/engine.test.ts, "fully resyncs when the server can no longer calculate type-level
// changes", which forces the error via FakeJmap and asserts the recovery.
