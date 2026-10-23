import { expect, test } from '@playwright/test';
import { bodyEditor, destroyBySubject, floatingComposer, recipientChips, saveStatus, subjectInput } from './support/compose';
import { BOB, ALICE, PASSWORD, uniqueTag } from './support/mail';

// Installing oinbox as an app: the manifest, the unread count on the icon, and email links.

test('the stack serves the manifest, uncached, with icons that load', async ({ page, request }) => {
  await page.goto('/inbox');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/manifest+json');
  expect(res.headers()['cache-control']).toBe('no-cache');
  const manifest = (await res.json()) as { name: string; icons: { src: string }[]; protocol_handlers: unknown };
  expect(manifest.name).toBe('oinbox');
  expect(manifest.protocol_handlers).toEqual([{ protocol: 'mailto', url: '/compose?mailto=%s' }]);
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png' }]) {
    const img = await request.get(icon.src);
    expect(img.status(), icon.src).toBe(200);
    expect(img.headers()['content-type'], icon.src).toBe('image/png');
  }
});

test('an email link opens a new message, filled in, over the Inbox', async ({ page }) => {
  const subject = uniqueTag('e2e mailto');
  const link = `mailto:${BOB}?cc=carol@example.test&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent('First line\nSecond line')}`;
  try {
    await page.goto(`/compose?mailto=${encodeURIComponent(link)}`);
    await expect(page).toHaveURL(/\/inbox$/);
    const c = floatingComposer(page);
    await expect(c).toHaveCount(1);
    await expect(recipientChips(c, 'To').filter({ hasText: BOB })).toBeVisible();
    await expect(recipientChips(c, 'Cc').filter({ hasText: 'carol@example.test' })).toBeVisible();
    await expect(subjectInput(c)).toHaveValue(subject);
    await expect(bodyEditor(c).locator('p')).toHaveText(['First line', 'Second line']);
    // It is a draft like any other: saved, so nothing from the link is lost.
    await expect(saveStatus(c)).toHaveText('Draft saved', { timeout: 10_000 });
  } finally {
    await destroyBySubject(subject);
  }
});

test('/compose alone opens an empty new message', async ({ page }) => {
  await page.goto('/compose');
  await expect(page).toHaveURL(/\/inbox$/);
  const c = floatingComposer(page);
  await expect(c).toHaveCount(1);
  await expect(subjectInput(c)).toHaveValue('');
  await expect(recipientChips(c, 'To')).toHaveCount(0);
});

test('the app icon carries the unread count from the tab title', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { badges: (number | null)[] };
    w.badges = [];
    Object.assign(navigator, {
      setAppBadge: (n: number) => (w.badges.push(n), Promise.resolve()),
      clearAppBadge: () => (w.badges.push(null), Promise.resolve()),
    });
  });
  await page.goto('/inbox');
  await expect(page).toHaveTitle(/Inbox – /);
  const unread = Number(/^\((\d+)\)/.exec(await page.title())?.[1] ?? 0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { badges: (number | null)[] }).badges.at(-1))).toBe(unread || null);
});

test('Settings asks the browser to send email links here', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { handlers: string[][] };
    w.handlers = [];
    Object.assign(navigator, { registerProtocolHandler: (scheme: string, url: string) => w.handlers.push([scheme, url]) });
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Open email links in oinbox' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your browser should now ask you' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  expect(await page.evaluate(() => (window as unknown as { handlers: string[][] }).handlers)).toEqual([['mailto', `${origin}/compose?mailto=%s`]]);
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an email link survives signing in', async ({ page }) => {
    const subject = uniqueTag('e2e mailto signin');
    try {
      await page.goto(`/compose?mailto=${encodeURIComponent(`mailto:${BOB}?subject=${encodeURIComponent(subject)}`)}`);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((u) => u.pathname === '/login');
      await page.locator('#username').fill(ALICE);
      await page.locator('#password').fill(PASSWORD);
      await page.locator('#submit-btn').click();
      await page.waitForURL((u) => u.pathname === '/inbox', { timeout: 20_000 });
      const c = floatingComposer(page);
      await expect(subjectInput(c)).toHaveValue(subject);
      await expect(recipientChips(c, 'To').filter({ hasText: BOB })).toBeVisible();
    } finally {
      await destroyBySubject(subject);
    }
  });
});
