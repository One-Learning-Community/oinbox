import { expect, test } from '@playwright/test';
import { destroyEmails, emailsBySubject, sendMail, threadEmails, waitFor, ALICE, uniqueTag } from './support/mail';
import { openInbox, rows, visibleThreadOrder, waitLive } from './support/app';

const created: string[] = [];
test.afterEach(async () => {
  await destroyEmails(created.splice(0));
});

async function deliverWhileOpen(page: import('@playwright/test').Page) {
  await openInbox(page);
  await waitLive(page);

  // Detect any full reload / navigation.
  await page.evaluate(() => ((window as any).__e2eMarker = 1));
  let navigations = 0;
  page.on('framenavigated', (f) => f === page.mainFrame() && navigations++);

  const subject = `Push test ${uniqueTag()}`;
  const sentAt = Date.now();
  const messageId = await sendMail({ from: 'Pusher <pusher@partner.test>', to: [ALICE], subject, text: 'Delivered during an e2e run.' });

  const row = rows(page).filter({ has: page.locator('.subject', { hasText: subject }) });
  try {
    await expect(row).toBeVisible({ timeout: 10_000 });
    test.info().annotations.push({ type: 'push-latency', description: `${Date.now() - sentAt} ms` });
  } finally {
    // Register for cleanup (the search index may lag delivery slightly, hence the wait).
    const mine = await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.messageId?.includes(messageId)), 10_000, 'pushed email');
    created.push(mine.id);
  }
  return { row, navigations: () => navigations };
}

test('new mail delivered over SMTP shows up live as an unread row, without a reload', async ({ page }) => {
  const { row, navigations } = await deliverWhileOpen(page);
  await expect(row).toHaveClass(/\bunread\b/);
  expect(navigations()).toBe(0);
  expect(await page.evaluate(() => (window as any).__e2eMarker)).toBe(1);
});

// FIXME(app bug, see e2e/README.md "Known failures"): the pushed thread is appended at the
// BOTTOM of the inbox, not the top. Stalwart announces the StateChange ~0-100 ms before the
// new email's receivedAt sort key is queryable, so the app's immediate collapsed Email/query
// returns it last; the app never re-reads the window afterwards (and a reload keeps the stale
// order from the IndexedDB snapshot until the next change).
test('new mail delivered over SMTP appears at the TOP of the inbox', async ({ page }) => {
  const { row } = await deliverWhileOpen(page);
  const tid = await row.getAttribute('data-thread-id');
  await expect.poll(async () => (await visibleThreadOrder(page))[0], { timeout: 10_000 }).toBe(tid);
});

test('a reply delivered while its conversation is open appears as the newest message', async ({ page }) => {
  const subject = `Push test ${uniqueTag()}`;
  const firstId = await sendMail({ from: 'Pusher <pusher@partner.test>', to: [ALICE], subject, text: 'First message.' });
  const first = await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.messageId?.includes(firstId)), 15_000, 'first message');
  created.push(first.id);

  await page.goto(`/inbox/t/${first.threadId}`);
  await expect(page.locator('article.msg')).toHaveCount(1);
  await waitLive(page);

  const replyId = await sendMail({ from: 'Pusher <pusher@partner.test>', to: [ALICE], subject, text: 'Second message.', inReplyTo: firstId });
  try {
    const messages = page.locator('article.msg');
    await expect(messages).toHaveCount(2);
    await expect(messages.last()).not.toHaveClass(/\bcollapsed\b/);
    await expect(messages.last().locator('iframe').contentFrame().locator('body')).toContainText('Second message.');
  } finally {
    const reply = await waitFor(async () => (await threadEmails(first.threadId)).find((e) => e.messageId?.includes(replyId)), 10_000, 'the reply');
    created.push(reply.id);
  }
});
