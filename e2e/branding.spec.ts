import { expect, test, type Page } from '@playwright/test';

// The operator's name and logo (OINBOX_BRAND_NAME, OINBOX_BRAND_LOGO) reach the app as /branding.json.
// The dev stack runs with the defaults, so a branded installation is played by answering that request here.
const LOGO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><rect width="120" height="32" fill="#c00"/></svg>')}`;
const brandAs = (page: Page, branding: { name: string; logo?: string }) =>
  page.route('**/branding.json', (route) => route.fulfill({ json: branding }));

test('the stack serves the default branding as JSON, never cached', async ({ request }) => {
  const res = await request.get('/branding.json');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(res.headers()['cache-control']).toBe('no-cache');
  expect(await res.json()).toEqual({ name: 'oinbox', logo: '' });
});

test('unbranded, the top bar and the tab say oinbox', async ({ page }) => {
  await page.goto('/inbox');
  await expect(page.locator('.topbar .brand')).toHaveText('oinbox');
  await expect(page).toHaveTitle('oinbox');
});

test('a name alone renames the top bar and the tab', async ({ page }) => {
  await brandAs(page, { name: 'Acme Mail' });
  await page.goto('/inbox');
  await expect(page.locator('.topbar .brand')).toHaveText('Acme Mail');
  await expect(page).toHaveTitle('Acme Mail');
});

test('a logo replaces the text in the top bar and becomes the tab icon', async ({ page }) => {
  await brandAs(page, { name: 'Acme Mail', logo: LOGO });
  await page.goto('/inbox');
  const logo = page.locator('.topbar .brand').getByRole('img', { name: 'Acme Mail' });
  await expect(logo).toBeVisible();
  // It loaded: the Content-Security-Policy allows it.
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.topbar .brand')).toHaveText('');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', LOGO);
});

test('the branding is remembered, so it is there at once on the next visit', async ({ page }) => {
  await brandAs(page, { name: 'Acme Mail' });
  await page.goto('/inbox');
  await expect(page).toHaveTitle('Acme Mail');
  // Next visit: the file is slow to arrive.
  await page.unroute('**/branding.json');
  await page.route('**/branding.json', () => new Promise(() => {}));
  await page.reload();
  await expect(page.locator('.topbar .brand')).toHaveText('Acme Mail');
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the sign-in card carries the logo and the name', async ({ page }) => {
    await brandAs(page, { name: 'Acme Mail', logo: LOGO });
    await page.goto('/');
    await expect(page.locator('.card').getByRole('heading', { name: 'Acme Mail' }).getByRole('img')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveTitle('Acme Mail');
  });
});
