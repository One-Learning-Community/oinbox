import { expect, test, type Page } from '@playwright/test';
import { openInbox, rowFor } from './support/app';
import { inlineImageMail, toast } from './support/compose';
import { driveChildren, driveOn, driveToken, removeFromDrive, waitForDrive } from './support/drive';
import { deliverToAlice, destroyEmails, uniqueTag, type EmailInfo } from './support/mail';

// Save to Drive. The first test needs a real OpenCloud (a stack started with deploy/docker-compose.drive.yml)
// and skips itself without one; the other two play Drive's answers themselves and run everywhere, CI included.
const NOTES = 'notes for the chart';
let mail: EmailInfo;

test.beforeAll(async () => {
  mail = await deliverToAlice({ from: 'Bob Example <bob@example.test>', subject: `Drive ${uniqueTag()}`, text: '', mime: inlineImageMail(uniqueTag('cid'), NOTES) });
});
test.afterAll(async () => {
  await destroyEmails([mail.id]);
});

async function openMessage(page: Page) {
  await openInbox(page);
  await rowFor(page, mail.threadId).click();
  await expect(page.locator('.attachments .attachment', { hasText: 'notes.txt' })).toBeVisible();
}

const chip = (page: Page) => page.locator('.attachments').getByRole('button', { name: /notes\.txt/ });

test('an attachment is saved into a new Drive folder, and a second save keeps both', async ({ page }) => {
  test.skip(!(await driveOn()), 'needs the stack started with docker-compose.drive.yml');
  test.setTimeout(240_000);
  const folder = uniqueTag('e2e-drive');
  await openMessage(page);
  const token = await driveToken(page);
  await waitForDrive(token);
  try {
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'Save to Drive' }).click();
    const picker = page.getByRole('dialog');
    await expect(picker.getByRole('heading', { name: 'Save to Drive' })).toBeVisible();
    await picker.getByRole('button', { name: 'New folder' }).click();
    await picker.getByLabel('Folder name').fill(folder);
    await picker.getByLabel('Folder name').press('Enter');
    await expect(picker.getByRole('navigation', { name: 'Folder path' })).toContainText(folder);
    await picker.getByRole('button', { name: 'Save here' }).click();
    await expect(toast(page, `Saved to Drive: ${folder}`)).toBeVisible();
    await expect(picker).toBeHidden();

    const made = (await driveChildren(token)).find((e) => e.name === folder);
    expect(made?.folder).toBeTruthy();
    const saved = await driveChildren(token, made!.id);
    expect(saved.map((e) => e.name)).toEqual(['notes.txt']);
    // The exact size depends on how the mail's line endings were stored; it must only not be empty.
    expect(saved[0]!.size).toBeGreaterThanOrEqual(NOTES.length);

    // Again: the picker opens where the last save went, and nothing is replaced.
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'Save to Drive' }).click();
    await expect(picker.getByRole('navigation', { name: 'Folder path' })).toContainText(folder);
    await expect(picker.locator('.drive-file', { hasText: 'notes.txt' })).toBeVisible();
    await picker.getByRole('button', { name: 'Save here' }).click();
    await expect(toast(page, `Saved to Drive: ${folder}`).last()).toBeVisible();
    await expect.poll(async () => (await driveChildren(token, made!.id)).map((e) => e.name).sort()).toEqual(['notes (1).txt', 'notes.txt']);
  } finally {
    await removeFromDrive(token, [folder]);
  }
});

test('without a Drive the chip downloads, as it always did', async ({ page }) => {
  await page.route('**/drive.json', (route) => route.fulfill({ json: { enabled: false, linkOverMb: 20 } }));
  const driveRequests: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/drive/')) driveRequests.push(r.url());
  });
  await openMessage(page);
  await expect(chip(page)).not.toHaveAttribute('aria-haspopup', 'menu');
  const download = page.waitForEvent('download');
  await chip(page).click();
  expect((await download).suggestedFilename()).toBe('notes.txt');
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(driveRequests).toEqual([]);
});

test('a Drive that is down says so and leaves mail alone', async ({ page }) => {
  await page.route('**/drive.json', (route) => route.fulfill({ json: { enabled: true, linkOverMb: 20 } }));
  await page.route('**/drive/graph/**', (route) => route.fulfill({ status: 503, body: '' }));
  await openMessage(page);
  // Nothing was asked of Drive just by opening the app and a message.
  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Save to Drive' }).click();
  const picker = page.getByRole('dialog');
  await expect(picker.getByText("Drive isn't available right now.")).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Save here' })).toBeDisabled();
  await expect(page.locator('.connection-banner')).toHaveCount(0);
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await expect(picker).toBeHidden();
  // Download still works from the same menu.
  const download = page.waitForEvent('download');
  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('notes.txt');
});

test("in the dark theme the chip's menu is dark, with text that can be read", async ({ page }) => {
  await page.route('**/drive.json', (route) => route.fulfill({ json: { enabled: true, linkOverMb: 20 } }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await openMessage(page);
  await chip(page).click();
  const item = page.getByRole('menuitem', { name: 'Save to Drive' });
  await expect(item).toBeVisible();
  // The surface behind the item: the nearest ancestor that paints a background.
  const { surface, text } = await item.evaluate((el) => {
    const lum = (css: string) => {
      const [r, g, b] = (css.match(/[\d.]+/g) ?? []).map(Number) as [number, number, number];
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    let node: Element | null = el;
    let bg = 'rgba(0, 0, 0, 0)';
    while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
      bg = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    return { surface: lum(bg), text: lum(getComputedStyle(el).color) };
  });
  expect(surface).toBeLessThan(0.3);
  expect(text - surface).toBeGreaterThan(0.4);
});
