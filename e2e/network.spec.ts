import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows, waitLive } from './support/app';

const banner = (page: Page) => page.getByRole('status').filter({ hasText: "Can't reach the server. Retrying…" });

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
