import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows } from './support/app';

async function expectBobsThreads(page: Page) {
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ has: page.locator('.subject', { hasText: 'Lunch Friday?' }) })).toHaveCount(1);
  // Every hit involves bob.
  const who = await rows(page).locator('.who').allInnerTexts();
  expect(who.length).toBeGreaterThan(0);
  for (const w of who) expect(w.toLowerCase()).toContain('bob');
}

// FIXME(app bug, see e2e/README.md "Known failures"): typing an operator query into the
// search box double-encodes it. SearchBox navigates to /search/from%3Abob; MailView then
// re-encodes the (still-encoded) router param (`search/${encodeURIComponent(params.q)}`),
// and resolveView decodes only once, so the query becomes the literal text "from%3Abob"
// (list aria-label "from%3Abob") and matches nothing. Any query with ':', ' ', '@', etc.
test('search box: from:bob returns bob\'s threads', async ({ page }) => {
  await openInbox(page);
  await page.locator('#search-input').fill('from:bob');
  await page.locator('#search-input').press('Enter');
  await expect(page).toHaveURL(/\/search\/from(%3A|:)bob$/);
  await expectBobsThreads(page);
});

test('from:bob via a /search/from:bob deep link returns bob\'s threads', async ({ page }) => {
  await page.goto('/search/from:bob');
  await expectBobsThreads(page);
});

test('free-text search from the search box returns threads with <mark> highlights', async ({ page }) => {
  await openInbox(page);
  await page.locator('#search-input').fill('zeppelin');
  await page.locator('#search-input').press('Enter');
  await expect(page).toHaveURL(/\/search\/zeppelin$/);

  const hit = rows(page).filter({ has: page.locator('.subject', { hasText: 'Q3 planning offsite' }) });
  await expect(hit).toHaveCount(1);
  const marks = rows(page).locator('mark');
  await expect(marks.first()).toBeVisible();
  for (const t of await marks.allInnerTexts()) expect(t.toLowerCase()).toContain('zeppelin');
});
