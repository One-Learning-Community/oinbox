import { expect, test, type Page } from '@playwright/test';
import { rows } from './support/app';
import { bodyEditor, composeNew, deliveredCopy, floatingComposer, sendAndWait, toast } from './support/compose';
import { destroyE2eLabels, createLabel } from './support/labels';
import { BOB, deliverToAlice, destroyEmails, emailsBySubject, mailboxByRole, uniqueTag } from './support/mail';

// Runs in the `phone` project only: WebKit as an iPhone 14, 390×844, touch.

const noSidewaysScroll = async (page: Page, where: string) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${where} scrolls sideways`).toBeLessThanOrEqual(0);

/** Visible controls smaller than 44px in either direction. Controls inside text (links in a sentence) are exempt in WCAG; none are expected here. */
const smallTargets = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], [role=button], [role=switch], [role=menuitem], input:not([type=hidden]), select, textarea')]
      .filter((el) => el.checkVisibility() && !el.closest('.fc-timegrid-slots, .fc-daygrid-body'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.bottom > 0 && r.top < innerHeight && (r.width < 43.5 || r.height < 43.5))
      .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 28)}" ${Math.round(r.width)}×${Math.round(r.height)}`),
  );

/** Open a seeded thread by subject. The list is virtualised, so an old thread may not be in the DOM to tap. */
const openSeeded = async (page: Page, subject: string) => {
  const mail = (await emailsBySubject(subject))[0]!;
  await page.goto(`/inbox/t/${mail.threadId}`);
  await page.locator('article.msg').first().waitFor();
};

const openInbox = async (page: Page) => {
  await page.goto('/inbox');
  await expect(rows(page).first()).toBeVisible();
};

test('@phone the inbox fits the screen and the drawer switches mailbox', async ({ page }) => {
  await openInbox(page);
  await noSidewaysScroll(page, 'inbox');
  await page.getByRole('button', { name: 'Menu' }).tap();
  await expect(page.locator('.sidebar.open')).toBeVisible();
  await page.getByRole('link', { name: /^Sent/ }).tap();
  await expect(page).toHaveURL(/\/sent/);
  await expect(page.locator('.sidebar.open')).toHaveCount(0);
  await noSidewaysScroll(page, 'sent');
});

test('@phone a thread opens and reads without sideways scroll; back returns to the list', async ({ page }) => {
  await openInbox(page);
  await rows(page).first().tap();
  await page.locator('article.msg').first().waitFor();
  await noSidewaysScroll(page, 'conversation');
  await openSeeded(page, 'Homepage redesign feedback');
  await page.locator('article.msg .msg-body iframe').first().waitFor();
  await noSidewaysScroll(page, 'HTML conversation');
  await page.getByRole('button', { name: /Back to list/ }).tap();
  await expect(rows(page).first()).toBeVisible();
});

test('@phone an inline reply keeps Send on screen while typing', async ({ page }) => {
  test.fail(true, 'docs/beta-audit.md P1: Send is below the fold while typing an inline reply');
  await openSeeded(page, 'Lunch Friday?');
  await page.getByRole('button', { name: 'Reply', exact: true }).last().tap();
  const c = page.locator('.conv .composer.inline');
  await expect(bodyEditor(c)).toBeVisible();
  await bodyEditor(c).pressSequentially('On my phone');
  await expect(c.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  await noSidewaysScroll(page, 'inline reply');
  page.once('dialog', (d) => void d.accept());
  await c.getByRole('button', { name: 'Discard draft' }).tap();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).tap();
});

test('@phone a new message fills the screen, sends and arrives', async ({ page }) => {
  const subject = `e2e phone ${Date.now()}`;
  await openInbox(page);
  await page.getByRole('button', { name: 'Menu' }).tap();
  const c = await composeNew(page, { to: BOB, subject, body: 'Sent from the phone project.' });
  const box = (await floatingComposer(page).boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(388);
  await noSidewaysScroll(page, 'composer');
  await sendAndWait(page, c);
  const got = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  await destroyEmails([got.id], BOB);
  await destroyEmails((await emailsBySubject(subject)).map((e) => e.id));
});

test('@phone archive from an open thread returns to the list', async ({ page }) => {
  const subject = `e2e phone archive ${Date.now()}`;
  const mail = await deliverToAlice({ from: 'Phone Test <phone@partner.test>', subject, text: 'archive me' });
  try {
    await page.goto(`/inbox/t/${mail.threadId}`);
    await page.locator('article.msg').first().waitFor();
    await page.getByRole('button', { name: /^Archive/ }).tap();
    await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).tap();
    await expect(toast(page, /archived/i)).toBeVisible();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(rows(page).filter({ hasText: subject })).toHaveCount(0);
  } finally {
    await destroyEmails([mail.id]);
  }
});

test('@phone a thread can be labelled from its toolbar', async ({ page }) => {
  const tag = uniqueTag();
  await createLabel(tag);
  try {
    await openSeeded(page, 'Lunch Friday?');
    await page.getByRole('button', { name: /^Label/ }).tap();
    const picker = page.getByRole('combobox', { name: 'Label conversation' });
    await expect(picker).toBeVisible();
    await picker.fill(tag);
    await page.getByRole('option', { name: tag }).tap();
    await expect(page.locator('.conv').getByText(tag)).toBeVisible();
    await noSidewaysScroll(page, 'label picker');
  } finally {
    await destroyE2eLabels();
  }
});

test('@phone search works from the top bar', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('searchbox', { name: 'Search mail' }).fill('from:bob');
  await page.getByRole('searchbox', { name: 'Search mail' }).press('Enter');
  await expect(page).toHaveURL(/\/search\//);
  await expect(rows(page).first()).toBeVisible();
  await noSidewaysScroll(page, 'search results');
});

test('@phone settings fit the screen and the vacation switch works', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await noSidewaysScroll(page, 'settings');
  const sw = page.getByRole('switch').first();
  const before = await sw.getAttribute('aria-checked');
  await sw.tap();
  await expect(sw).not.toHaveAttribute('aria-checked', before!);
  await sw.tap();
  await expect(sw).toHaveAttribute('aria-checked', before!);
  await page.getByRole('button', { name: /^Edit / }).first().tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const d = (await dialog.boundingBox())!;
  expect(d.x).toBeGreaterThanOrEqual(0);
  expect(d.x + d.width).toBeLessThanOrEqual(390);
  await dialog.getByRole('button', { name: 'Cancel' }).tap();
});

test('@phone the calendar opens in day view and an event opens on tap', async ({ page }) => {
  test.fail(true, 'docs/beta-audit.md P2: the event card runs off the right edge in week view');
  await page.goto('/calendar');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  await noSidewaysScroll(page, 'calendar');
  await page.getByRole('button', { name: 'week', exact: true }).tap();
  await page.locator('.calendar-view .fc-event').filter({ hasText: 'Design review' }).tap();
  const card = page.getByRole('dialog', { name: 'Design review' });
  await expect(card).toBeVisible();
  const b = (await card.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(390);
  await noSidewaysScroll(page, 'event card');
});

for (const path of ['/inbox', '/settings', '/calendar']) {
  test(`@phone touch targets on ${path} are at least 44px`, async ({ page }) => {
    test.fail(true, 'docs/beta-audit.md P3: many controls are smaller than 44px');
    await page.goto(path);
    await page.waitForTimeout(1000);
    expect(await smallTargets(page)).toEqual([]);
  });
}

test('@phone touch targets in an open thread and in the composer are at least 44px', async ({ page }) => {
  test.fail(true, 'docs/beta-audit.md P3: many controls are smaller than 44px');
  await openSeeded(page, 'Homepage redesign feedback');
  await page.locator('article.msg .msg-body iframe').first().waitFor();
  const thread = await smallTargets(page);
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Menu' }).tap();
  await page.getByRole('button', { name: 'Compose' }).tap();
  await floatingComposer(page).waitFor();
  await page.waitForTimeout(800);
  const composer = await smallTargets(page);
  expect({ thread, composer }).toEqual({ thread: [], composer: [] });
});
