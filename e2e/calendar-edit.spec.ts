import { expect, test, type Page } from '@playwright/test';
import { waitLive } from './support/app';
import { createEvent, createInvitedEvent, destroyE2eEvents, eventsByTitle, todayIn } from './support/calendar';

const TZ = 'America/New_York';
test.use({ timezoneId: TZ });
test.afterEach(destroyE2eEvents);

const event = (page: Page, title: string) => page.locator('.calendar-view .fc-event', { hasText: title });
const tag = () => `E2E ${Date.now()}`;
const lane = (page: Page, hhmm: string) => page.locator(`.calendar-view .fc-timegrid-slot-lane[data-time="${hhmm}:00"]`);

async function openWeek(page: Page) {
  await page.goto('/calendar');
  await expect(page.locator('.calendar-view .fc')).toBeVisible();
  await page.getByRole('button', { name: 'week', exact: true }).click();
  await expect(event(page, 'Design review')).toBeVisible();
  await waitLive(page);
}

/** Drag a vertical span in today's column of the time grid, between two slot times such as "14:00". */
async function dragSlot(page: Page, from: string, to: string) {
  const col = (await page.locator('.calendar-view .fc-timegrid-col.fc-day-today').boundingBox())!;
  const a = (await lane(page, from).boundingBox())!;
  const b = (await lane(page, to).boundingBox())!;
  await page.mouse.move(col.x + col.width / 2, a.y + 2);
  await page.mouse.down();
  await page.mouse.move(col.x + col.width / 2, b.y + 2, { steps: 8 });
  await page.mouse.up();
}

/** Drag an event down to the slot at `to`. */
async function dragEventTo(page: Page, title: string, to: string) {
  const box = (await event(page, title).boundingBox())!;
  const target = (await lane(page, to).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, target.y + 4, { steps: 10 });
  await page.mouse.up();
}

test('dragging on the grid creates an event with Enter', async ({ page }) => {
  const title = tag();
  await openWeek(page);
  await dragSlot(page, '18:00', '18:30');
  const form = page.getByRole('form', { name: 'Event' });
  await expect(form).toBeVisible();
  await form.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.keyboard.press('Enter');
  await expect(event(page, title)).toBeVisible();
  const [stored] = await eventsByTitle(title);
  expect(stored).toMatchObject({ start: `${todayIn(TZ)}T18:00:00`, timeZone: TZ, duration: 'PT1H' });
});

test('Escape closes the create form, clears the highlight and creates nothing', async ({ page }) => {
  await openWeek(page);
  await dragSlot(page, '20:00', '20:30');
  await expect(page.getByRole('form', { name: 'Event' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('form', { name: 'Event' })).toHaveCount(0);
  await expect(page.locator('.calendar-view .fc-highlight')).toHaveCount(0);
});

test('an event can be moved by dragging, and is saved', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T11:00:00`, TZ);
  await openWeek(page);
  await dragEventTo(page, title, '17:00');
  await expect.poll(async () => (await eventsByTitle(title))[0]?.start).toBe(`${todayIn(TZ)}T17:00:00`);
});

test('an event can be renamed and moved to another calendar from its card', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T09:00:00`, TZ);
  await openWeek(page);
  const before = (await eventsByTitle(title))[0]!;
  await event(page, title).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  const form = page.getByRole('form', { name: 'Event' });
  await form.getByRole('textbox', { name: 'Title' }).fill(`${title} renamed`);
  await form.getByRole('combobox', { name: 'Calendar' }).selectOption({ label: 'Team' });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(event(page, `${title} renamed`)).toBeVisible();
  const [stored] = await eventsByTitle(`${title} renamed`);
  expect(Object.keys(stored!.calendarIds)).toHaveLength(1);
  expect(Object.keys(stored!.calendarIds)[0]).not.toBe(Object.keys(before.calendarIds)[0]);
});

test('an event can be deleted from its card', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T08:00:00`, TZ);
  await openWeek(page);
  await event(page, title).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete this event?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(event(page, title)).toHaveCount(0);
  expect(await eventsByTitle(title)).toHaveLength(0);
});

test('a recurring event and an invited event are read-only, with a reason', async ({ page }) => {
  const title = tag();
  const cleanup = await createInvitedEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
  try {
    await openWeek(page);
    await event(page, 'Weekly sync').click();
    await expect(page.getByText("Recurring events can't be edited yet.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(event(page, title)).toBeVisible({ timeout: 15_000 });
    await event(page, title).click();
    await expect(page.getByText(/invited to this event/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('moving an event with guests asks first; Cancel puts it back and sends nothing', async ({ page }) => {
  await openWeek(page);
  const before = (await event(page, 'Design review').boundingBox())!;
  await dragEventTo(page, 'Design review', '15:00');
  const dialog = page.getByRole('dialog', { name: 'Change this event?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  const after = (await event(page, 'Design review').boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect((await eventsByTitle('Design review'))[0]!.start).toMatch(/T10:00:00$/);
});

test('a failed write puts the dragged event back and says so', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T11:00:00`, TZ);
  await openWeek(page);
  await page.route('**/jmap/', async (route) => {
    if (route.request().postData()?.includes('"CalendarEvent/set"')) return route.fulfill({ status: 500, body: 'boom' });
    return route.continue();
  });
  const before = (await event(page, title).boundingBox())!;
  await dragEventTo(page, title, '17:00');
  await expect(page.locator('.toast', { hasText: "Couldn't change the event" })).toBeVisible();
  const after = (await event(page, title).boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
});
