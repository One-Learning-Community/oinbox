import { test } from '@playwright/test';
test('ff push debug', async ({ page }) => {
  page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('requestfailed', (r) => console.log('REQFAILED', r.url().slice(0, 120), r.failure()?.errorText));
  page.on('response', (r) => { if (/eventsource|jmap/.test(r.url())) console.log('RESP', r.status(), r.url().slice(0, 120)); });
  await page.goto('/inbox');
  await page.waitForTimeout(6000);
  console.log('DOT', await page.locator('.status-dot').getAttribute('class'));
  console.log('BANNER', await page.locator('.connection-banner').count());
});
