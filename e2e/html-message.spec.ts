import { expect, test } from '@playwright/test';
import { emailsBySubject, ensureInMailbox, mailboxByRole, markThreadRead, updateEmails } from './support/mail';
import { settleAfterArrange } from './support/app';

const REMOTE_HOSTS = ['picsum.photos', 'tracker.design.test'];

test('HTML message: remote images blocked with banner, quote folded, no remote requests', async ({ page }) => {
  const erin = (await emailsBySubject('Homepage redesign feedback')).find((e) => e.from?.[0]?.email === 'erin@design.test');
  expect(erin, 'seeded HTML reply from erin').toBeTruthy();
  const read = await markThreadRead(erin!.threadId);
  const moved = await ensureInMailbox([erin!], await mailboxByRole('inbox'));

  const remote: string[] = [];
  page.on('request', (req) => {
    const host = new URL(req.url()).hostname;
    if (REMOTE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) remote.push(req.url());
  });
  // Belt and braces: if anything did try, fail it fast rather than hitting the network.
  await page.route(/picsum\.photos|tracker\.design\.test/, (route) => route.abort());

  await page.goto(`/inbox/t/${erin!.threadId}`);
  await settleAfterArrange(page, !!read.changed || moved);
  const msg = page.locator(`article.msg[data-email-id="${erin!.id}"]`);
  await expect(msg).not.toHaveClass(/\bcollapsed\b/);

  // Banner shown, images not loaded.
  await expect(msg.locator('.images-banner')).toBeVisible();
  await expect(msg.locator('.images-banner')).toContainText('Images from this sender are hidden');

  const frame = msg.frameLocator('.msg-body iframe');
  await expect(frame.locator('body')).toContainText('updated mockup');
  await expect(frame.locator('img[src^="http"]')).toHaveCount(0);
  expect(await frame.locator('img').count()).toBeGreaterThan(0);

  // Quoted reply is folded behind the toggle.
  const toggle = frame.locator('.oinbox-quote-toggle');
  const quoted = frame.getByText('The new hero section looks great');
  await expect(toggle).toBeVisible();
  await expect(quoted).toBeHidden();
  await toggle.click();
  await expect(quoted).toBeVisible();
  await toggle.click();
  await expect(quoted).toBeHidden();

  // Give any stray loads a moment, then assert nothing went to the remote hosts.
  await page.waitForTimeout(1000);
  expect(remote).toEqual([]);
});

// FIXME(app bug, see e2e/README.md "Known failures"): any update to an open message (star,
// read/unread, label; locally or via push) re-mounts its Message/MessageBody, recreating the
// iframe. That silently re-folds an expanded quote and drops a one-off "Show images".
test('expanded quote stays expanded when the open message is starred', async ({ page }) => {
  const erin = (await emailsBySubject('Homepage redesign feedback')).find((e) => e.from?.[0]?.email === 'erin@design.test')!;
  await page.goto(`/inbox/t/${erin.threadId}`);
  await settleAfterArrange(page, false);
  const frame = page.locator(`article.msg[data-email-id="${erin.id}"]`).frameLocator('.msg-body iframe');
  const quoted = frame.getByText('The new hero section looks great');
  await frame.locator('.oinbox-quote-toggle').click();
  await expect(quoted).toBeVisible();
  try {
    await updateEmails({ [erin.id]: { 'keywords/$flagged': true } });
    await page.waitForTimeout(2000); // push + render
    await expect(quoted).toBeVisible();
  } finally {
    await updateEmails({ [erin.id]: { 'keywords/$flagged': null } });
  }
});
