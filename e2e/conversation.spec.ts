import { expect, test } from '@playwright/test';
import { emailsBySubject, ensureInMailbox, markThreadRead, mailboxByRole } from './support/mail';
import { settleAfterArrange } from './support/app';

test('thread alice replied to shows every message incl. her Sent copy, oldest first, latest expanded', async ({ page }) => {
  // Arrange: the seeded "Q3 planning offsite" thread (carol, dave, ALICE (Sent), carol, carol), all read.
  const seeded = (await emailsBySubject('Q3 planning offsite')).filter((e) => /Q3 planning offsite/.test(e.subject));
  expect(seeded.length).toBeGreaterThan(0);
  const threadId = seeded[0]!.threadId;
  const emails = await markThreadRead(threadId);
  const sentId = await mailboxByRole('sent');
  const inboxId = await mailboxByRole('inbox');
  // Undo any archiving from earlier manual runs: every non-Sent message back in the Inbox.
  const moved = await ensureInMailbox(emails.filter((e) => !e.mailboxIds[sentId]), inboxId);

  expect(emails).toHaveLength(5);
  const aliceCopy = emails.find((e) => e.mailboxIds[sentId]);
  expect(aliceCopy?.from?.[0]?.email).toBe('alice@example.test');

  await page.goto(`/inbox/t/${threadId}`);
  await settleAfterArrange(page, !!emails.changed || moved);
  const msgs = page.locator('article.msg[data-email-id]');
  await expect(msgs.last()).toBeVisible();

  // 4 older read messages collapse into "first, N older messages, last-of-run"; expand them.
  const older = page.locator('.older-pill');
  if (await older.isVisible()) await older.click();

  await expect(msgs).toHaveCount(emails.length);
  const shown = await msgs.evaluateAll((els) => els.map((el) => el.getAttribute('data-email-id')));
  expect(shown).toEqual(emails.map((e) => e.id)); // oldest -> newest, Sent copy in place

  // Alice's own reply is rendered as "me".
  await expect(page.locator(`article.msg[data-email-id="${aliceCopy!.id}"] .from`)).toHaveText('me');

  // Latest expanded (with a body), all older (read) ones collapsed.
  const latest = page.locator(`article.msg[data-email-id="${emails.at(-1)!.id}"]`);
  await expect(latest).not.toHaveClass(/\bcollapsed\b/);
  await expect(latest.locator('.msg-body iframe')).toBeVisible();
  for (const e of emails.slice(0, -1)) {
    await expect(page.locator(`article.msg[data-email-id="${e.id}"]`)).toHaveClass(/\bcollapsed\b/);
  }
});
