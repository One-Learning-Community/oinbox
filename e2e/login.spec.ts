import { expect, test } from '@playwright/test';
import { signInThroughStalwart } from './support/login';
import { rows, threadList } from './support/app';

// Fresh browser: no stored tokens.
test.use({ storageState: { cookies: [], origins: [] } });

test('OAuth sign-in through Stalwart /login lands on the inbox with the seeded threads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.card')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  let tokenExchange: { status: number; body: Record<string, unknown> } | null = null;
  page.on('response', async (res) => {
    if (new URL(res.url()).pathname === '/auth/token') tokenExchange = { status: res.status(), body: await res.json().catch(() => ({})) };
  });

  await signInThroughStalwart(page);

  // PKCE public-client exchange succeeded and issued a refresh token (offline_access).
  expect(tokenExchange).not.toBeNull();
  expect(tokenExchange!.status).toBe(200);
  expect(tokenExchange!.body).toHaveProperty('refresh_token');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('oinbox.tokens') ?? 'null'));
  expect(stored?.accessToken).toBeTruthy();

  await expect(threadList(page)).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
  // Seeded inbox: 14 threads (more if other specs left mail behind).
  const total = Number((await page.locator('.range').innerText()).match(/\d+/)?.[0]);
  expect(total).toBeGreaterThanOrEqual(14);
  for (const subject of ['Q3 planning offsite', 'Lunch Friday?', 'Homepage redesign feedback', 'Invoice #1042']) {
    await expect(rows(page).filter({ has: page.locator('.subject', { hasText: subject }) })).toHaveCount(1);
  }
});
