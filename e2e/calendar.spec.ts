import { expect, test, type Page } from '@playwright/test';
import { rows, waitLive } from './support/app';
import { createEvent, destroyEvent, todayIn } from './support/calendar';

// Seeded events are in US Eastern time, in the week starting on this Sunday (deploy/seed/seed_calendar.py).
const TZ = 'America/New_York';
test.use({ timezoneId: TZ });

const event = (page: Page, title: string) => page.locator('.calendar-view .fc-event', { hasText: title });

async function openWeek(page: Page) {
  await page.goto('/calendar');
  await expect(page.locator('.calendar-view .fc')).toBeVisible();
  await page.getByRole('button', { name: 'week', exact: true }).click();
  await expect(event(page, 'Design review')).toBeVisible();
}

test('shows the seeded week, all-day and multi-day events included', async ({ page }) => {
  await openWeek(page);
  for (const title of ['Design review', '1:1 with Bob', 'Sprint planning', 'Call with London office', 'Release freeze', 'Team offsite']) {
    await expect(event(page, title).first()).toBeVisible();
  }
});

test('repairs the sparse override: the moved Weekly sync is titled and 30 minutes long', async ({ page }) => {
  await openWeek(page);
  const sync = event(page, 'Weekly sync');
  await expect(sync).toHaveCount(1);
  await expect(sync).toContainText(/11:00\s*[-–]\s*11:30/);
});

test('an event created elsewhere appears through push, without a reload', async ({ page }) => {
  await openWeek(page);
  await waitLive(page);
  const title = `Pushed ${Date.now()}`;
  const id = await createEvent(title, `${todayIn(TZ)}T16:00:00`, TZ);
  try {
    await expect(event(page, title)).toBeVisible({ timeout: 15_000 });
  } finally {
    await destroyEvent(id);
  }
  await expect(event(page, title)).toHaveCount(0, { timeout: 15_000 });
});

test('clicking an event shows its details', async ({ page }) => {
  await openWeek(page);
  await event(page, 'Design review').click();
  const card = page.getByRole('dialog', { name: 'Design review' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Room 4');
  await expect(card).toContainText('Walk through the new inbox layout.');
  await expect(card).toContainText('Bob Example');
  await expect(card).toContainText('Awaiting reply');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
});

test('event details open from the keyboard', async ({ page }) => {
  await openWeek(page);
  await event(page, 'Design review').focus();
  await expect(event(page, 'Design review')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Design review' })).toBeVisible();
});

test('g then k opens the calendar from the inbox', async ({ page }) => {
  await page.goto('/inbox');
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('k');
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator('.calendar-view')).toBeVisible();
});

test('hiding a calendar hides its events', async ({ page }) => {
  await openWeek(page);
  const team = page.getByRole('checkbox', { name: 'Team' });
  await expect(event(page, 'Sprint planning')).toBeVisible();
  await team.uncheck();
  await expect(event(page, 'Sprint planning')).toHaveCount(0);
  await expect(event(page, '1:1 with Bob')).toHaveCount(0);
  await expect(event(page, 'Design review')).toBeVisible();
  await team.check();
  await expect(event(page, 'Sprint planning')).toBeVisible();
});
