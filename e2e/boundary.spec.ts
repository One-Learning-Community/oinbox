import { expect, test } from '@playwright/test';
import { openInbox, rows } from './support/app';

test('a calendar chunk that fails to load leaves mail usable', async ({ page }) => {
  await page.route(/\/assets\/CalendarView-[^/]+\.js$/, (route) => route.fulfill({ status: 404, body: 'gone' }));
  await openInbox(page);
  await page.getByRole('link', { name: 'Calendar' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This part of oinbox hit a problem.' })).toBeVisible();
  // By its row: since rozie Toast 0.3.0 the text is also in the toaster's live region.
  await expect(page.locator('.toast', { hasText: 'oinbox was updated. Reload to continue.' })).toBeVisible();
  // The shell and the mail still work.
  await page.getByRole('link', { name: /^Inbox/ }).click();
  await expect(rows(page).first()).toBeVisible();
  await rows(page).first().click();
  await expect(page.locator('article.msg').first()).toBeVisible();
});
