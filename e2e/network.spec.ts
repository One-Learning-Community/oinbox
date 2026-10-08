import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows, waitLive } from './support/app';
import { addRecipient, bodyEditor, deliveredCopy, floatingComposer, saveStatus, subjectInput, toast, typeBody } from './support/compose';
import { ALICE, BOB, PASSWORD, deliverToAlice, destroyEmails, emailsBySubject, mailboxByRole, threadEmails, waitFor } from './support/mail';

// What the user sees when the network or the server lets them down (docs/beta-audit.md, "Network").

const banner = (page: Page) => page.getByRole('status').filter({ hasText: "Can't reach the server. Retrying…" });
const openComposer = async (page: Page) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  const c = floatingComposer(page);
  await expect(c).toBeVisible();
  return c;
};

test('offline while reading: banner, loaded mail still opens, recovery without reload', async ({ page, context }) => {
  await openInbox(page);
  await waitLive(page);
  await rows(page).first().click();
  await page.locator('article.msg').first().waitFor();
  await page.goBack();
  await context.setOffline(true);
  await expect(banner(page)).toBeVisible({ timeout: 8000 });
  await rows(page).first().click();
  await expect(page.locator('article.msg').first()).toBeVisible();
  await context.setOffline(false);
  await expect(banner(page)).toHaveCount(0, { timeout: 40_000 });
  await waitLive(page);
});

test('offline during archive: the thread comes back and a toast says so', async ({ page, context }) => {
  const subject = `e2e net archive ${Date.now()}`;
  const mail = await deliverToAlice({ from: 'Net Test <net@partner.test>', subject, text: 'stay put' });
  try {
    await page.goto(`/inbox/t/${mail.threadId}`);
    await page.locator('article.msg').first().waitFor();
    await waitLive(page);
    await context.setOffline(true);
    await page.getByRole('button', { name: /^Archive/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
    await expect(page.locator('.toast[data-type=error]')).toBeVisible({ timeout: 40_000 });
    await context.setOffline(false);
    await page.goto('/inbox');
    await expect(rows(page).filter({ hasText: subject })).toBeVisible();
    const inbox = await mailboxByRole('inbox');
    expect((await threadEmails(mail.threadId)).every((e) => e.mailboxIds[inbox])).toBe(true);
  } finally {
    await context.setOffline(false);
    await destroyEmails([mail.id]);
  }
});

test('offline during send: the composer returns with its text; sending again delivers exactly one copy', async ({ page, context }) => {
  test.setTimeout(120_000);
  const subject = `e2e net send ${Date.now()}`;
  await openInbox(page);
  await waitLive(page);
  let c = await openComposer(page);
  await addRecipient(c, BOB);
  await subjectInput(c).fill(subject);
  await typeBody(c, 'must not be lost');
  await expect(saveStatus(c)).toHaveText('Draft saved', { timeout: 15_000 });
  await c.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(toast(page, 'Sending…')).toBeVisible();
  await context.setOffline(true);
  await expect(toast(page, "Couldn't send. Your message is still here.")).toBeVisible({ timeout: 60_000 });
  c = floatingComposer(page);
  await expect(bodyEditor(c)).toContainText('must not be lost');
  await expect(subjectInput(c)).toHaveValue(subject);
  await context.setOffline(false);
  await expect(banner(page)).toHaveCount(0, { timeout: 40_000 });
  await c.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(toast(page, 'Message sent.')).toBeVisible({ timeout: 40_000 });
  const bobInbox = await mailboxByRole('inbox', BOB);
  const got = await deliveredCopy(subject, BOB, bobInbox);
  // Give a duplicate time to arrive, then count.
  await page.waitForTimeout(3000);
  const copies = (await emailsBySubject(subject, BOB)).filter((e) => e.mailboxIds[bobInbox]);
  expect(copies).toHaveLength(1);
  await destroyEmails([got.id], BOB);
  await destroyEmails((await emailsBySubject(subject)).map((e) => e.id));
});

test('a draft that could not be saved says so, and saves by itself after reconnect', async ({ page, context }) => {
  test.setTimeout(120_000);
  const subject = `e2e net draft ${Date.now()}`;
  await openInbox(page);
  await waitLive(page);
  const c = await openComposer(page);
  await context.setOffline(true);
  await subjectInput(c).fill(subject);
  await expect(saveStatus(c)).toContainText('Couldn’t save draft', { timeout: 45_000 });
  await expect(c.getByRole('button', { name: 'Retry' })).toBeVisible();
  await context.setOffline(false);
  await expect(saveStatus(c)).toHaveText('Draft saved', { timeout: 60_000 });
  await expect(subjectInput(c)).toHaveValue(subject);
  await c.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
});

test('503 from the server: one banner, no storm of toasts, recovery', async ({ page }) => {
  await openInbox(page);
  await waitLive(page);
  // Long enough for the warm-start snapshot to be written.
  await page.waitForTimeout(4000);
  await page.route('**/jmap/**', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.reload();
  await expect(banner(page)).toBeVisible({ timeout: 20_000 });
  // The warm-start snapshot is still on screen.
  await expect(rows(page).first()).toBeVisible();
  await page.waitForTimeout(10_000);
  expect(await page.locator('.toast').count()).toBeLessThanOrEqual(1);
  await page.unroute('**/jmap/**');
  await expect(banner(page)).toHaveCount(0, { timeout: 45_000 });
  await waitLive(page);
});

test('an upload cut off by the network fails visibly and leaves the draft intact', async ({ page, context }) => {
  test.setTimeout(120_000);
  const subject = `e2e net upload ${Date.now()}`;
  await openInbox(page);
  await waitLive(page);
  const c = await openComposer(page);
  await subjectInput(c).fill(subject);
  await typeBody(c, 'draft text');
  await context.setOffline(true);
  await c.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(toast(page, /Couldn't attach notes\.txt/)).toBeVisible({ timeout: 45_000 });
  await expect(bodyEditor(c)).toContainText('draft text');
  await context.setOffline(false);
  await expect(banner(page)).toHaveCount(0, { timeout: 45_000 });
  await c.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(c.getByText('notes.txt')).toBeVisible({ timeout: 20_000 });
  await c.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
});

test('a rejected refresh token signs out in place; the unsaved draft returns after signing in', async ({ browser }) => {
  test.setTimeout(120_000);
  // Its own context: signing in again issues new tokens, which must not disturb the shared session file.
  const context = await browser.newContext({ storageState: 'e2e/.auth/alice.json' });
  const page = await context.newPage();
  const subject = `e2e net rescue ${Date.now()}`;
  try {
    await openInbox(page);
    await waitLive(page);
    const c = await openComposer(page);
    await page.route('**/jmap/**', (route) => route.fulfill({ status: 401, body: '' }));
    await page.route('**/auth/token', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"invalid_grant"}' }));
    await subjectInput(c).fill(subject);
    const signedOut = page.getByRole('status').filter({ hasText: "You've been signed out." });
    await expect(signedOut).toBeVisible({ timeout: 45_000 });
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('oinbox.rescue.')).length)).toBe(1);
    await expect(subjectInput(c)).toHaveValue(subject);
    await page.unroute('**/jmap/**');
    await page.unroute('**/auth/token');
    await signedOut.getByRole('button', { name: 'Sign in again' }).click();
    await page.waitForURL((u) => u.pathname === '/login');
    await page.locator('#username').fill(ALICE);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#submit-btn').click();
    await expect(subjectInput(floatingComposer(page))).toHaveValue(subject, { timeout: 30_000 });
    await expect(toast(page, 'Your unsent draft was restored.')).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('oinbox.rescue.')).length)).toBe(0);
    await floatingComposer(page).getByRole('button', { name: 'Discard draft' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
  } finally {
    await waitFor(async () => true);
    await destroyEmails((await emailsBySubject(subject)).map((e) => e.id)).catch(() => undefined);
    await context.close();
  }
});
