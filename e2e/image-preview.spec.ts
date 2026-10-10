import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openInbox, rowFor } from './support/app';
import { destroyBySubject, PNG, PNG_BASE64 } from './support/compose';
import { deliverToAlice, uniqueTag } from './support/mail';

const subjects: string[] = [];
test.afterEach(async () => {
  for (const s of subjects.splice(0)) await destroyBySubject(s);
});

const imagePart = (name: string, base64 = PNG_BASE64) => [
  '--mix', `Content-Type: image/png; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', base64,
];

/** A message with the given parts attached after a line of text, open in the conversation view. */
async function openMessageWith(page: Page, parts: string[][]) {
  const subject = `Image preview test ${uniqueTag()}`;
  subjects.push(subject);
  const body = ['--mix', 'Content-Type: text/plain; charset=utf-8', '', 'Pictures attached.', ...parts.flat(), '--mix--'].join('\n');
  const mail = await deliverToAlice({ from: 'Bob <bob@example.test>', subject, text: '', mime: { contentType: 'multipart/mixed; boundary="mix"', body } });
  await openInbox(page);
  await rowFor(page, mail.threadId).click();
  await page.locator('.attachments').waitFor();
}

const notes = ['--mix', 'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', '', 'some notes'];
const tile = (page: Page, name: string) => page.getByRole('button', { name: `Preview ${name}` });
const viewer = (page: Page) => page.getByRole('dialog');
const drawn = (img: Locator) => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);

test('pictures show as tiles and open in a viewer that steps between them', async ({ page }) => {
  await openMessageWith(page, [imagePart('first.png'), notes, imagePart('second.png')]);

  for (const name of ['first.png', 'second.png']) await expect.poll(() => drawn(tile(page, name).locator('img'))).toBe(true);
  // What is not a picture is a tile of the same size, showing its kind.
  await expect(page.getByRole('button', { name: 'Download notes.txt' })).toHaveText('TXT');
  const sizes = await page.locator('.attachment-tile').evaluateAll((tiles) => tiles.map((t) => `${t.clientWidth}x${t.clientHeight}`));
  expect(sizes).toHaveLength(3);
  expect(new Set(sizes).size, `tiles are one size: ${sizes.join(', ')}`).toBe(1);

  await tile(page, 'second.png').click();
  await expect(viewer(page)).toContainText('second.png');
  await expect(viewer(page)).toContainText('2 of 2');
  await expect.poll(() => drawn(viewer(page).locator('img'))).toBe(true);
  await expect(viewer(page).getByRole('button', { name: 'Next image' })).toBeDisabled();

  await page.keyboard.press('ArrowLeft');
  await expect(viewer(page)).toContainText('first.png');
  await expect(viewer(page)).toContainText('1 of 2');
  await expect(viewer(page).locator('img')).toHaveAttribute('alt', 'first.png');
  // The arrow keys belong to the viewer: the conversation behind it stays where it was.
  await expect(page).toHaveURL(/\/t\//);
  await viewer(page).getByRole('button', { name: 'Next image' }).click();
  await expect(viewer(page)).toContainText('2 of 2');

  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await expect(tile(page, 'second.png')).toBeFocused();
});

test('the viewer has no serious accessibility faults and downloads the picture', async ({ page }) => {
  await openMessageWith(page, [imagePart('first.png'), imagePart('second.png')]);
  await tile(page, 'first.png').click();
  await expect.poll(() => drawn(viewer(page).locator('img'))).toBe(true);
  await expect(viewer(page).getByRole('button', { name: 'Close' })).toBeFocused();

  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include('.image-viewer').analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  const download = page.waitForEvent('download');
  await viewer(page).getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('first.png');

  await viewer(page).getByRole('button', { name: 'Close' }).click();
  await expect(tile(page, 'first.png')).toBeFocused();
});

test('a picture over the size cap is not fetched until it is opened', async ({ page }) => {
  // A PNG still draws with bytes after its end, so padding makes a large one cheaply.
  const large = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1024)]).toString('base64').replace(/.{76}/g, '$&\n');
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('large.png')) fetched.push(r.url());
  });
  await openMessageWith(page, [imagePart('large.png', large)]);

  await expect(tile(page, 'large.png')).toHaveText('PNG');
  expect(fetched).toEqual([]);

  await tile(page, 'large.png').click();
  await expect.poll(() => drawn(viewer(page).locator('img')), { timeout: 20_000 }).toBe(true);
  expect(fetched).toHaveLength(1);
});

test('@phone the viewer fills the screen and its buttons are finger-sized', async ({ page }) => {
  await openMessageWith(page, [imagePart('first.png'), imagePart('second.png')]);
  await expect.poll(() => drawn(tile(page, 'first.png').locator('img'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the conversation is no wider than the screen').toBe(true);

  await tile(page, 'first.png').tap();
  await expect.poll(() => drawn(viewer(page).locator('img'))).toBe(true);
  // It opens with a short scale and fade; measure it at rest.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const box = (await viewer(page).boundingBox())!;
  const screen = page.viewportSize()!;
  expect(box.x).toBe(0);
  expect(Math.round(box.width)).toBe(screen.width);
  for (const button of await viewer(page).getByRole('button').all()) {
    const b = (await button.boundingBox())!;
    expect(Math.min(b.width, b.height), await button.getAttribute('title') ?? 'Save to Drive').toBeGreaterThanOrEqual(44);
    expect(b.x + b.width).toBeLessThanOrEqual(screen.width);
  }
  await viewer(page).getByRole('button', { name: 'Next image' }).tap();
  await expect(viewer(page)).toContainText('2 of 2');
  await viewer(page).getByRole('button', { name: 'Close' }).tap();
  await expect(viewer(page)).toHaveCount(0);
});
