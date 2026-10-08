import { expect, test, type Page } from '@playwright/test';
import { waitLive } from './support/app';
import { bobMailAbout, calendarIdByName, createEvent, createGuestEvent, createInvitedEvent, destroyBobMailAbout, destroyE2eEvents, eventsByTitle, futureStart, patchEvent, todayIn } from './support/calendar';

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

/** An event's box; a refetch re-renders the events, so wait until it is measurable. */
async function boxOf(page: Page, title: string) {
  let box = null;
  await expect.poll(async () => (box = await event(page, title).boundingBox())).not.toBeNull();
  return box as { x: number; y: number; width: number; height: number } | null;
}

/** Drag an event down to the slot at `to`. */
async function dragEventTo(page: Page, title: string, to: string) {
  const box = (await boxOf(page, title))!;
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

test('an event in two calendars ends up in exactly the one chosen', async ({ page }) => {
  const title = tag();
  const id = await createEvent(title, `${todayIn(TZ)}T09:00:00`, TZ);
  await patchEvent(id, { [`calendarIds/${await calendarIdByName('Team')}`]: true });
  expect(Object.keys((await eventsByTitle(title))[0]!.calendarIds)).toHaveLength(2);
  await openWeek(page);
  await event(page, title).first().click();
  await page.getByRole('button', { name: 'Edit' }).click();
  const picker = page.getByRole('form', { name: 'Event' }).getByRole('combobox', { name: 'Calendar' });
  const current = await picker.inputValue();
  const other = (await picker.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).find((v) => v !== current)!;
  await picker.selectOption(other);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => Object.keys((await eventsByTitle(title))[0]!.calendarIds)).toEqual([other]);
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
  const when = futureStart(TZ);
  const { cleanup } = await createInvitedEvent(title, when.start, TZ);
  try {
    await openWeek(page);
    await event(page, 'Weekly sync').click();
    await expect(page.getByText("Recurring events can't be edited yet.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    if (!when.inThisWeek) await page.locator('.fc-next-button').click();
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

test('clicking outside the create form closes it and creates nothing', async ({ page }) => {
  await openWeek(page);
  await dragSlot(page, '20:00', '20:30');
  await expect(page.getByRole('form', { name: 'Event' })).toBeVisible();
  await page.getByRole('link', { name: 'Inbox' }).or(page.locator('nav.sidebar')).first().click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole('form', { name: 'Event' })).toHaveCount(0);
  await expect(page.locator('.calendar-view .fc-highlight')).toHaveCount(0);
});

test('an event can be resized by its bottom edge', async ({ page }) => {
  const title = tag();
  await createEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
  await openWeek(page);
  await event(page, title).hover();
  const handle = (await event(page, title).locator('.fc-event-resizer-end').boundingBox())!;
  const target = (await lane(page, '19:00').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, target.y + 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await eventsByTitle(title))[0]?.duration).toBe('PT2H30M');
});

test.describe('events with guests', () => {
  test.afterEach(async () => destroyBobMailAbout('E2E'));

  test('Cancel in the rename dialog returns to the form with the typed title', async ({ page }) => {
    const title = tag();
    await createGuestEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await event(page, title).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    const form = page.getByRole('form', { name: 'Event' });
    await form.getByRole('textbox', { name: 'Title' }).fill(`${title} renamed`);
    await form.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog', { name: 'Rename this event?' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(form.getByRole('textbox', { name: 'Title' })).toHaveValue(`${title} renamed`);
    expect(await eventsByTitle(title)).toHaveLength(1);
  });

  test('a refused rename shows its error in the form', async ({ page }) => {
    const title = tag();
    await createGuestEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await page.route('**/jmap/', (route) =>
      route.request().postData()?.includes('"CalendarEvent/set"') ? route.fulfill({ status: 500, body: 'boom' }) : route.continue(),
    );
    await event(page, title).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    const form = page.getByRole('form', { name: 'Event' });
    await form.getByRole('textbox', { name: 'Title' }).fill(`${title} renamed`);
    await form.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog', { name: 'Rename this event?' }).getByRole('button', { name: "Don't notify" }).click();
    await expect(form.getByRole('alert')).toContainText(/500|boom|failed/i);
  });

  test('Notify guests emails bob; Don\'t notify does not', async ({ page }) => {
    const quiet = tag();
    const loud = `E2E ${Date.now() + 1}`;
    await createGuestEvent(quiet, `${todayIn(TZ)}T17:00:00`, TZ);
    await createGuestEvent(loud, `${todayIn(TZ)}T19:00:00`, TZ);
    await openWeek(page);
    await dragEventTo(page, quiet, '21:00');
    await page.getByRole('dialog', { name: 'Change this event?' }).getByRole('button', { name: "Don't notify" }).click();
    await expect.poll(async () => (await eventsByTitle(quiet))[0]?.start).toBe(`${todayIn(TZ)}T21:00:00`);
    await dragEventTo(page, loud, '20:00');
    await page.getByRole('dialog', { name: 'Change this event?' }).getByRole('button', { name: 'Notify guests' }).click();
    await expect.poll(async () => (await bobMailAbout(loud)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await bobMailAbout(quiet)).toHaveLength(0);
  });

  test('the guest dialog starts on Cancel, so a stray Enter emails nobody', async ({ page }) => {
    const title = tag();
    await createGuestEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await dragEventTo(page, title, '21:00');
    const dialog = page.getByRole('dialog', { name: 'Change this event?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(await bobMailAbout(title)).toHaveLength(0);
    expect((await eventsByTitle(title))[0]!.start).toMatch(/T17:00:00$/);
  });

  test('Cancel after a refetch leaves exactly one copy of the event', async ({ page }) => {
    const title = tag();
    await createGuestEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await dragEventTo(page, title, '21:00');
    const dialog = page.getByRole('dialog', { name: 'Change this event?' });
    await expect(dialog).toBeVisible();
    const other = tag() + ' other';
    await createEvent(other, `${todayIn(TZ)}T08:00:00`, TZ);
    await expect(event(page, other)).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(event(page, title)).toHaveCount(1);
  });
});

test.describe('an open card follows its event', () => {
  test('the edit form closes with a notice when its event is deleted elsewhere', async ({ page }) => {
    const title = tag();
    await createEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await event(page, title).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('form', { name: 'Event' })).toBeVisible();
    await destroyE2eEvents();
    await expect(page.getByRole('form', { name: 'Event' })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.toast', { hasText: 'no longer exists' })).toBeVisible();
  });

  test('the edit form closes with a notice when its event becomes read-only', async ({ page }) => {
    const title = tag();
    const id = await createEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await event(page, title).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('form', { name: 'Event' })).toBeVisible();
    await patchEvent(id, { recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' } });
    await expect(page.getByRole('form', { name: 'Event' })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.toast', { hasText: "can't be edited" })).toBeVisible();
  });

  test('the details card stays beside its event after a refetch', async ({ page }) => {
    const title = tag();
    await createEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await event(page, title).click();
    const card = page.getByRole('dialog', { name: title });
    await expect(card).toBeVisible();
    const other = `${tag()} other`;
    await createEvent(other, `${todayIn(TZ)}T08:00:00`, TZ);
    await expect(event(page, other)).toBeVisible({ timeout: 15_000 });
    await expect(card).toBeVisible();
    const e = (await boxOf(page, title))!;
    const d = (await card.boundingBox())!;
    const touches = Math.abs(d.x - (e.x + e.width)) < 12 || Math.abs(d.x + d.width - e.x) < 12;
    expect(touches && d.y < e.y + e.height && d.y + d.height > e.y).toBe(true);
  });
});

test('with no writable calendar a drag explains itself and leaves no highlight', async ({ page }) => {
  await page.route('**/jmap/', async (route) => {
    if (!route.request().postData()?.includes('"Calendar/get"')) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const [name, result] of body.methodResponses as [string, { list?: { myRights?: Record<string, boolean> }[] }][]) {
      if (name === 'Calendar/get') for (const c of result.list ?? []) c.myRights = { ...c.myRights, mayWriteAll: false };
    }
    return route.fulfill({ response, json: body });
  });
  await openWeek(page);
  await dragSlot(page, '20:00', '20:30');
  await expect(page.locator('.toast', { hasText: 'No calendar here accepts new events' })).toBeVisible();
  await expect(page.locator('.calendar-view .fc-highlight')).toHaveCount(0);
});

test.describe('focus', () => {
  test('the create form focuses its title', async ({ page }) => {
    await openWeek(page);
    await dragSlot(page, '20:00', '20:30');
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused();
  });

  test('Cancel in the edit form returns focus to Edit', async ({ page }) => {
    const title = tag();
    await createEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await event(page, title).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Edit' })).toBeFocused();
  });

  test('opening the card from the keyboard and pressing Escape leaves focus on the event', async ({ page }) => {
    const title = tag();
    await createEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await event(page, title).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: title })).toHaveCount(0);
    await expect(event(page, title)).toBeFocused();
  });

  test('focus inside the card goes back to its event when the card closes', async ({ page }) => {
    const title = tag();
    await createEvent(title, `${todayIn(TZ)}T17:00:00`, TZ);
    await openWeek(page);
    await event(page, title).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Edit' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: title })).toHaveCount(0);
    await expect(event(page, title)).toBeFocused();
  });
});
