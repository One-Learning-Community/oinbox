import { expect, type Page } from '@playwright/test';
import { ALICE, PASSWORD } from './mail';

/** Sign in through the SPA's "Sign in" card and Stalwart's real /login page. */
export async function signInThroughStalwart(page: Page, user = ALICE, password = PASSWORD) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Stalwart's authorization endpoint, same origin.
  await page.waitForURL((u) => u.pathname === '/login');
  const authz = new URL(page.url());
  expect(authz.searchParams.get('client_id')).toBe('oinbox');
  expect(authz.searchParams.get('redirect_uri')).toBe(new URL('/auth/callback', page.url()).toString());
  expect(authz.searchParams.get('code_challenge_method')).toBe('S256');

  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('#submit-btn').click();

  await page.waitForURL((u) => u.pathname === '/inbox', { timeout: 20_000 });
}
