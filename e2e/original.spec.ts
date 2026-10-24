import { expect, test, type Page } from '@playwright/test';
import { openInbox, rowFor } from './support/app';
import { destroyBySubject } from './support/compose';
import { deliverToAlice, uniqueTag } from './support/mail';

const subjects: string[] = [];
test.afterEach(async () => {
  for (const s of subjects.splice(0)) await destroyBySubject(s);
});

async function openMessage(page: Page) {
  const subject = `Show original test ${uniqueTag()}`;
  subjects.push(subject);
  const mail = await deliverToAlice({ from: 'Bob <bob@example.test>', subject, text: 'The body, as sent.' });
  await openInbox(page);
  await rowFor(page, mail.threadId).click();
  await expect(page.locator('.msg').last().locator('.msg-body')).toBeVisible();
  return { subject, mail };
}

const panel = (page: Page) => page.getByRole('dialog', { name: 'Original message' });
const source = (page: Page) => panel(page).getByLabel('Message source');

test('"Show original" opens the message as Stalwart holds it, and Back, Escape and Close shut it', async ({ page }) => {
  const { subject } = await openMessage(page);
  const more = page.locator('.msg').last().getByRole('button', { name: 'More' });

  await more.click();
  await page.getByRole('menuitem', { name: 'Show original' }).click();
  await expect(page).toHaveURL(/[?&]original=/);
  await expect(source(page)).toContainText(`Subject: ${subject}`);
  // What Stalwart added on delivery is there, above what the sender wrote.
  await expect(source(page)).toContainText('Authentication-Results:');
  await expect(source(page)).toContainText('The body, as sent.');
  await expect(panel(page).getByRole('rowheader', { name: 'Subject' })).toBeVisible();
  await expect(panel(page).locator('tr', { hasText: 'From' })).toContainText('bob@example.test');

  // A reload keeps it open: it is in the address.
  await page.reload();
  await expect(source(page)).toContainText(`Subject: ${subject}`);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/original=/);

  await more.click();
  await page.getByRole('menuitem', { name: 'Show original' }).click();
  await expect(source(page)).toBeVisible();
  await page.goBack();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/t\//);

  await more.click();
  await page.getByRole('menuitem', { name: 'Show original' }).click();
  await panel(page).getByRole('button', { name: 'Close' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/t\//);
  await expect(page).not.toHaveURL(/original=/);
});

// The browser has the last word on the name: Linux WebKit (Ubuntu 26.04) saves spaces as underscores.
const savedAs = (name: string) => name.replace(/_/g, ' ');

test('the message downloads as an .eml file, from the menu and from the panel', async ({ page }) => {
  const { subject } = await openMessage(page);
  const more = page.locator('.msg').last().getByRole('button', { name: 'More' });

  await more.click();
  const fromMenu = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download message' }).click();
  const file = await fromMenu;
  expect(savedAs(file.suggestedFilename())).toBe(`${subject}.eml`);
  const text = await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(text).toContain(`Subject: ${subject}`);

  await more.click();
  await page.getByRole('menuitem', { name: 'Show original' }).click();
  const fromPanel = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Download original' }).click();
  expect(savedAs((await fromPanel).suggestedFilename())).toBe(`${subject}.eml`);
});

test('@phone the panel fills the screen, nothing is wider than it, and its buttons are finger-sized', async ({ page }) => {
  await openMessage(page);
  await page.locator('.msg').last().getByRole('button', { name: 'More' }).tap();
  await page.getByRole('menuitem', { name: 'Show original' }).tap();
  await expect(source(page)).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const screen = page.viewportSize()!;
  const box = (await panel(page).boundingBox())!;
  expect(box.x).toBe(0);
  expect(Math.round(box.width)).toBe(screen.width);
  expect(await panel(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the panel is no wider than the screen').toBe(true);
  for (const button of await panel(page).getByRole('button').all()) {
    const b = (await button.boundingBox())!;
    expect(Math.min(b.width, b.height), (await button.textContent()) || 'Close').toBeGreaterThanOrEqual(44);
    expect(b.x + b.width).toBeLessThanOrEqual(screen.width);
  }
  await panel(page).getByRole('button', { name: 'Close' }).tap();
  await expect(panel(page)).toHaveCount(0);
});
