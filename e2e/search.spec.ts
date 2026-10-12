import { expect, test, type Locator, type Page } from '@playwright/test';
import { openInbox, rows } from './support/app';
import { ALICE, BOB, destroyEmails, emailsBySubject, sendMail, uniqueTag, waitFor } from './support/mail';

const pills = (page: Page) => page.locator('.search-pill');
const options = (page: Page) => page.getByRole('option');

type Rect = { x: number; y: number; width: number; height: number };

/** Whether `inner` lies wholly inside `outer`, to half a pixel. */
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Whether the element, or something inside it, is what a click at its centre reaches. */
const hitsItself = (target: Locator) =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && el.contains(hit);
  });

/** The search, clear and options buttons of the box: each inside the box, reached at its own centre, none overlapping. Returns their y. */
async function expectIconsInBox(page: Page) {
  const box = (await page.locator('.search-box').boundingBox())!;
  const form = page.locator('.search-box-form');
  const buttons = [
    form.getByRole('button', { name: 'Search', exact: true }),
    form.getByRole('button', { name: 'Clear search' }),
    page.getByRole('button', { name: 'Search options' }),
  ];
  const rects: Rect[] = [];
  for (const b of buttons) {
    const r = (await b.boundingBox())!;
    expect(inside(r, box), 'a button lies inside the box').toBe(true);
    expect(await hitsItself(b), 'a click at the middle of a button reaches it').toBe(true);
    rects.push(r);
  }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j]), 'the buttons do not overlap').toBe(false);
  return rects.map((r) => r.y);
}

/**
 * Every pill is either wholly inside the box or clipped away: a click where its middle would be does not reach it.
 * Returns how many of each there are.
 */
async function sortPills(page: Page) {
  const box = (await page.locator('.search-box').boundingBox())!;
  let shown = 0;
  let clipped = 0;
  for (const pill of await pills(page).all()) {
    const r = (await pill.boundingBox())!;
    if (inside(r, box)) shown++;
    else {
      expect(await hitsItself(pill), 'a pill outside the box is clipped, not drawn over the page').toBe(false);
      clipped++;
    }
  }
  return { shown, clipped };
}

async function expectBobsThreads(page: Page) {
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ has: page.locator('.subject', { hasText: 'Lunch Friday?' }) })).toHaveCount(1);
  // Every hit involves bob.
  const who = await rows(page).locator('.who').allInnerTexts();
  expect(who.length).toBeGreaterThan(0);
  for (const w of who) expect(w.toLowerCase()).toContain('bob');
}

test('typing from:bob and a space makes a pill, and Enter then searches', async ({ page }) => {
  await openInbox(page);
  await page.locator('#search-input').focus();
  await page.keyboard.type('from:bob ');
  await expect(pills(page)).toHaveText(['from: bob']);
  await page.keyboard.press('Enter');
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

test('typing from: offers people, and the pick becomes a pill that searches', async ({ page }) => {
  await openInbox(page);
  await page.locator('#search-input').pressSequentially('from:bob');
  await expect(options(page).first()).toContainText('bob@example.test');
  await page.keyboard.press('Enter');
  await expect(pills(page)).toHaveText(['from: Bob Example']);
  await expect(page).toHaveURL(/\/inbox$/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\/from(%3A|:)bob(%40|@)example\.test$/);
  await expectBobsThreads(page);
});

test('plain words open no list, and a pill is removed with its button', async ({ page }) => {
  await page.goto('/search/' + encodeURIComponent('from:bob is:unread'));
  await expect(pills(page)).toHaveText(['from: bob', 'is: unread']);
  await page.locator('#search-input').pressSequentially('lunch');
  await expect(options(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove is: unread' }).click();
  await expect(pills(page)).toHaveText(['from: bob']);
  await expect(page).toHaveURL(/\/search\/from(%3A|:)bob(%20| )lunch$/);
  await expect(rows(page).filter({ has: page.locator('.subject', { hasText: 'Lunch Friday?' }) })).toHaveCount(1);
});

test('Backspace hands the last pill back as text', async ({ page }) => {
  await page.goto('/search/' + encodeURIComponent('from:bob'));
  await page.locator('#search-input').focus();
  await page.keyboard.press('Backspace');
  await expect(pills(page)).toHaveCount(0);
  await expect(page.locator('#search-input')).toHaveValue('from:bob');
});

test('Escape closes the suggestion list and keeps the box, and a second Escape leaves it', async ({ page }) => {
  await openInbox(page);
  await page.locator('#search-input').pressSequentially('is:un');
  await expect(options(page).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(options(page)).toHaveCount(0);
  await expect(page.locator('#search-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-input')).not.toBeFocused();
});

test('a search with OR is shown as text and still finds its mail', async ({ page }) => {
  await page.goto('/search/' + encodeURIComponent('from:bob OR from:nobody-at-all'));
  await expect(pills(page)).toHaveCount(0);
  await expect(page.locator('#search-input')).toHaveValue('from:bob OR from:nobody-at-all');
  await expectBobsThreads(page);
});

test('to: finds mail the person was only copied on', async ({ page }) => {
  // A message to bob with alice in Cc, with a unique subject, removed afterwards.
  const tag = uniqueTag();
  const subject = `Copied ${tag}`;
  await sendMail({ from: BOB, to: [BOB], cc: [ALICE], subject, text: 'cc test' });
  try {
    await waitFor(async () => (await emailsBySubject(subject)).length > 0, 10_000, 'the copied message');
    await page.goto('/search/' + encodeURIComponent(`to:alice subject:${tag}`));
    await expect(rows(page).filter({ has: page.locator('.subject', { hasText: subject }) })).toHaveCount(1);
  } finally {
    await destroyEmails((await emailsBySubject(subject)).map((e) => e.id));
    await destroyEmails((await emailsBySubject(subject, BOB)).map((e) => e.id), BOB);
  }
});

test('the panel builds a search and opens filled in from it', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Search options' }).click();
  const panel = page.getByRole('dialog', { name: 'Search options' });
  await expect(panel.getByLabel('From')).toBeFocused();
  await panel.getByLabel('From').fill('bob');
  await panel.getByLabel('Has the words').fill('lunch');
  await panel.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/search\/from(%3A|:)bob(%20| )lunch$/);
  await expect(panel).toBeHidden();
  await expect(pills(page)).toHaveText(['from: bob']);
  await expect(rows(page).filter({ has: page.locator('.subject', { hasText: 'Lunch Friday?' }) })).toHaveCount(1);

  await page.getByRole('button', { name: 'Search options' }).click();
  await expect(panel.getByLabel('From')).toHaveValue('bob');
  await expect(panel.getByLabel('Has the words')).toHaveValue('lunch');
});

test('a custom date range keeps the panel open while a day is picked, and includes its last day', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Search options' }).click();
  const panel = page.getByRole('dialog', { name: 'Search options' });
  await panel.getByLabel('Date').selectOption('custom');
  const pickDay = async (button: RegExp, day: string) => {
    await panel.getByRole('button', { name: button }).click();
    await page.locator('.day-popover').getByText(day, { exact: true }).first().click();
    await expect(panel).toBeVisible();
  };
  await pickDay(/^First day/, '10');
  await expect(panel.getByRole('button', { name: /^First day: (?!Any)/ })).toBeVisible();
  await pickDay(/^Last day/, '15');
  await panel.getByRole('button', { name: 'Search' }).click();
  // The last day is included: it is written as the day after.
  await expect(page).toHaveURL(/\/search\/.*after(%3A|:).*before(%3A|:)/);
  const query = decodeURIComponent(new URL(page.url()).pathname.replace('/search/', ''));
  expect(query).toMatch(/after:\d{4}[-/]\d{2}[-/]10\b/);
  expect(query).toMatch(/before:\d{4}[-/]\d{2}[-/]16\b/);

  await page.getByRole('button', { name: 'Search options' }).click();
  await expect(panel.getByRole('button', { name: /^Last day: .*\b15\b/ })).toBeVisible();
});

test('the search panel fits a phone and its fields are finger-sized @phone', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Search options' }).click();
  const form = page.locator('.search-panel-form');
  await expect(form).toBeVisible();
  const box = (await form.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect((await form.getByLabel('From').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the search options button can be tapped with pills in the box, which stay inside the one-row box @phone', async ({ page }) => {
  await page.goto('/search/' + encodeURIComponent('from:bob is:unread'));
  await expect(pills(page)).toHaveCount(2);
  // Unfocused, the box is one 44px row: each pill is inside it or clipped away, and the three buttons are whole.
  expect((await page.locator('.search-box').boundingBox())!.height).toBe(44);
  await sortPills(page);
  await expectIconsInBox(page);
  await page.getByRole('button', { name: 'Search options' }).tap();
  const panel = page.getByRole('dialog', { name: 'Search options' });
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('a box with many pills is one row until it is focused, and its list is not clipped', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'one engine is enough for a layout check');
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/search/' + encodeURIComponent('from:bob@example.test is:unread has:attachment label:nowhere newer_than:7d lunch budget'));
  await expect(pills(page)).toHaveCount(5);
  const searchBox = page.locator('.search-box');
  await expect(async () => expect((await searchBox.boundingBox())!.height).toBe(48)).toPass();
  // Five pills do not fit one row: some show, and the rest are clipped away rather than drawn below the box.
  const { shown, clipped } = await sortPills(page);
  expect(shown).toBeGreaterThan(0);
  expect(clipped).toBeGreaterThan(0);
  const ysClosed = await expectIconsInBox(page);

  await page.locator('#search-input').focus();
  await expect(async () => expect((await searchBox.boundingBox())!.height).toBeGreaterThan(48)).toPass();
  const open = (await searchBox.boundingBox())!;
  for (const pill of await pills(page).all()) expect(inside((await pill.boundingBox())!, open)).toBe(true);
  // The buttons stay where they were, so a click on one is not moved from under the pointer.
  expect(await expectIconsInBox(page)).toEqual(ysClosed);

  await page.keyboard.type(' in:');
  const option = options(page).first();
  await expect(option).toBeVisible();
  const r = (await option.boundingBox())!;
  expect(inside(r, { x: 0, y: 0, width: 1100, height: 700 })).toBe(true);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="option"]') !== null, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  expect(hit).toBe(true);
});
