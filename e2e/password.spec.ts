import { expect, test } from '@playwright/test';
import { createAccount, deleteAccount } from './support/accounts';
import { signInThroughStalwart } from './support/login';
import { BASE } from './support/mail';

// A user of this spec's own: changing alice's password would sign every other spec out.
const NAME = `pwchange-${Date.now().toString(36)}`;
const USER = `${NAME}@example.test`;
const OLD = 'first horse battery 1';
const NEW = 'second staple correct 2';

test.use({ storageState: { cookies: [], origins: [] } });
test.beforeAll(() => createAccount(NAME, OLD));
test.afterAll(() => deleteAccount(NAME));

const basic = (password: string) =>
  fetch(`${BASE}/jmap/session`, { headers: { authorization: `Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}` } }).then((r) => r.status);

test('a signed-in user changes their password, is signed out, and signs in with the new one', async ({ page }) => {
  await signInThroughStalwart(page, USER, OLD);
  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Password' });
  const submit = async (current: string, next: string) => {
    await section.getByLabel('Current password').fill(current);
    await section.getByLabel('New password', { exact: true }).fill(next);
    await section.getByLabel('Confirm new password').fill(next);
    await section.getByRole('button', { name: 'Change password' }).click();
  };

  await submit('not the password', NEW);
  await expect(section.getByText('Current password is incorrect.')).toBeVisible();
  await submit(OLD, '12345678');
  await expect(section.getByText(/Password is too weak/)).toBeVisible();
  expect(await basic(OLD)).toBe(200);

  await submit(OLD, NEW);
  await expect(page.locator('.card').getByRole('status')).toHaveText('Password changed. Sign in with your new password.');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('oinbox.tokens'))).toBeNull();
  expect(await basic(OLD)).toBe(401);
  expect(await basic(NEW)).toBe(200);

  // The notice is for the sign-in that follows, once.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('.card').getByRole('status')).toHaveCount(0);

  await signInThroughStalwart(page, USER, NEW);
  await expect(page).toHaveURL(/\/inbox$/);
});
