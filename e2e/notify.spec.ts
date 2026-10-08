import { expect, test, type Page } from '@playwright/test';
import { destroyEmails, emailsBySubject, sendMail, waitFor, ALICE, uniqueTag } from './support/mail';
import { openInbox, waitLive } from './support/app';

const created: string[] = [];
test.afterEach(async () => {
  await destroyEmails(created.splice(0));
});

interface Shown { title: string; body: string; tag: string }

/** Stand in for the browser's Notification, record what is shown, and say whether the user is looking. */
async function stubNotifications(page: Page, opts: { switchedOn: boolean; away: boolean }) {
  await page.addInitScript(({ switchedOn, away }) => {
    const shown: unknown[] = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = () => Promise.resolve('granted');
      onclick: (() => void) | null = null;
      constructor(public title: string, options: { body: string; tag: string }) {
        Object.assign(this, options);
        shown.push(this);
      }
    }
    Object.assign(window, { Notification: FakeNotification, __shown: shown });
    if (switchedOn) localStorage.setItem('oinbox.notify', '1');
    else localStorage.removeItem('oinbox.notify');
    if (away) document.hasFocus = () => false;
  }, opts);
}
const shown = (page: Page) => page.evaluate(() => (window as unknown as { __shown: Shown[] }).__shown.map(({ title, body, tag }) => ({ title, body, tag })));

async function deliver(subject: string) {
  const messageId = await sendMail({ from: 'Nora Notifier <nora@partner.test>', to: [ALICE], subject, text: 'Delivered during an e2e run.' });
  const mine = await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.messageId?.includes(messageId)), 15_000, 'delivered email');
  created.push(mine.id);
  return mine;
}

test('new mail raises a desktop notification while the user is away; clicking it opens the conversation', async ({ page }) => {
  await stubNotifications(page, { switchedOn: true, away: true });
  await openInbox(page);
  await waitLive(page);
  const subject = `Push test ${uniqueTag()}`;
  const mail = await deliver(subject);

  await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual([{ title: 'Nora Notifier', body: subject, tag: `oinbox-${mail.threadId}` }]);
  await page.evaluate(() => (window as unknown as { __shown: { onclick: () => void }[] }).__shown[0]!.onclick());
  await expect(page).toHaveURL(new RegExp(`/inbox/t/${mail.threadId}$`));
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
});

test('no notification while the user is looking at the inbox, but the tab counts the unread conversation', async ({ page }) => {
  await stubNotifications(page, { switchedOn: true, away: false });
  await openInbox(page);
  await waitLive(page);
  const before = Number((await page.title()).match(/^\((\d+)\)/)?.[1] ?? 0);
  const subject = `Push test ${uniqueTag()}`;
  await deliver(subject);

  await expect(page).toHaveTitle(new RegExp(`^\\(${before + 1}\\) Inbox – oinbox$`), { timeout: 15_000 });
  expect(await shown(page)).toEqual([]);
});

test('no notification when the setting is off', async ({ page }) => {
  await stubNotifications(page, { switchedOn: false, away: true });
  await openInbox(page);
  await waitLive(page);
  const subject = `Push test ${uniqueTag()}`;
  await deliver(subject);
  await expect(page.locator('.subject', { hasText: subject })).toBeVisible({ timeout: 15_000 });
  expect(await shown(page)).toEqual([]);
});

test('the Settings switch asks the browser and remembers the answer', async ({ page }) => {
  await stubNotifications(page, { switchedOn: false, away: false });
  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: 'Desktop notifications for new mail' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => localStorage.getItem('oinbox.notify'))).toBe('1');
});
