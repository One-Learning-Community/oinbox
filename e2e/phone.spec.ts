import { expect, test, type Page } from '@playwright/test';
import { rows } from './support/app';
import { bodyEditor, composeNew, deliveredCopy, floatingComposer, sendAndWait, toast } from './support/compose';
import { destroyE2eLabels, createLabel } from './support/labels';
import { createInvitedEvent, destroyE2eEvents, eventsByTitle, futureStart } from './support/calendar';
import { BOB, accountId, deliverToAlice, destroyEmails, emailsBySubject, jmap, mailboxByRole, uniqueTag, waitFor } from './support/mail';

// Runs in the `phone` project only: WebKit as an iPhone 14, 390×844, touch.

/**
 * Nothing is wider than the screen: not the page, not a pane that scrolls or clips inside it (the page
 * itself never grows, because `.main` hides overflow), and not the content of a message frame.
 */
const noSidewaysScroll = async (page: Page, where: string) =>
  expect(
    await page.evaluate(() => {
      const wide: string[] = [];
      if (document.documentElement.scrollWidth > window.innerWidth) wide.push('page');
      for (const el of document.querySelectorAll<HTMLElement>('.main, .conv, .list-scroll, .settings, .calendar-view, .compose-dock .composer, .msg-body')) {
        if (el.checkVisibility() && el.scrollWidth > el.clientWidth + 1) wide.push(`${el.className.split(' ')[0]} ${el.scrollWidth}>${el.clientWidth}`);
      }
      for (const frame of document.querySelectorAll<HTMLIFrameElement>('.msg-body iframe')) {
        const doc = frame.contentDocument?.documentElement;
        if (doc && doc.scrollWidth > frame.clientWidth + 1) wide.push(`message ${doc.scrollWidth}>${frame.clientWidth}`);
      }
      return wide;
    }),
    `${where} is wider than the screen`,
  ).toEqual([]);

/** Visible controls smaller than 44px in either direction. Controls inside text (links in a sentence) are exempt in WCAG; none are expected here. */
const smallTargets = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], [role=button], [role=switch], [role=menuitem], input:not([type=hidden]), select, textarea')]
      .filter((el) => el.checkVisibility() && !el.closest('.fc-timegrid-slots, .fc-daygrid-body'))
      // A checkbox or radio inside a label is pressed through the label, and the search input through its box:
      // a press anywhere in the box reaches the input (search.spec.ts, "the clear button appears…").
      .map((el) => ({ el, r: ((el instanceof HTMLInputElement && el.closest('label, .search-pills')) || el).getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.bottom > 0 && r.top < innerHeight && (r.width < 43.5 || r.height < 43.5))
      .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 28)}" ${Math.round(r.width)}×${Math.round(r.height)}`),
  );

/** Visible fields whose text is under 16px: iOS Safari zooms the page in when one of them takes the focus. */
const smallText = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('input:not([type=hidden], [type=checkbox], [type=radio], [type=file]), select, textarea, [contenteditable=true]')]
      .filter((el) => el.checkVisibility() && parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? ''}" ${getComputedStyle(el).fontSize}`),
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

test('@phone an inline reply can be typed and its Send reached', async ({ page }) => {
  await openSeeded(page, 'Lunch Friday?');
  await page.getByRole('button', { name: 'Reply', exact: true }).last().tap();
  const c = page.locator('.conv .composer.inline');
  await expect(bodyEditor(c)).toBeVisible();
  await bodyEditor(c).pressSequentially('On my phone');
  // Send is sometimes below the fold here (docs/beta-audit.md, P1); it must at least be reachable by scrolling.
  await c.getByRole('button', { name: 'Send', exact: true }).scrollIntoViewIfNeeded();
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
  await page.getByRole('combobox', { name: 'Search mail' }).pressSequentially('from:bob ');
  await page.getByRole('combobox', { name: 'Search mail' }).press('Enter');
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

test('@phone the calendar opens in day view and fits', async ({ page }) => {
  await page.goto('/calendar');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  await noSidewaysScroll(page, 'calendar');
});

test('@phone an event card opened in week view stays on the screen', async ({ page }) => {
  await page.goto('/calendar');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  await page.getByRole('button', { name: 'week', exact: true }).tap();
  await page.locator('.calendar-view .fc-event').filter({ hasText: 'Design review' }).tap();
  const card = page.getByRole('dialog', { name: 'Design review' });
  await expect(card).toBeVisible();
  const b = (await card.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(390);
});

test('@phone a file can be attached to a new message', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Menu' }).tap();
  await page.getByRole('button', { name: 'Compose' }).tap();
  const c = floatingComposer(page);
  await c.locator('input[type=file]:not([accept])').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(c.getByText('notes.txt')).toBeVisible({ timeout: 20_000 });
  await noSidewaysScroll(page, 'composer with an attachment');
  await c.getByRole('button', { name: 'Discard draft' }).tap();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).tap();
  await expect(c).toHaveCount(0);
});

test('@phone a signature can be edited and saved', async ({ page }) => {
  const SUBMISSION = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'];
  const account = await accountId();
  const identities = async () => (await jmap([['Identity/get', { accountId: account, ids: null }, 'i']], undefined, SUBMISSION)).i.list as { id: string; htmlSignature: string; textSignature: string }[];
  const before = (await identities())[0]!;
  const mark = `phone-${Date.now()}`;
  try {
    await page.goto('/settings');
    await page.getByRole('button', { name: /^Edit / }).first().tap();
    const dialog = page.getByRole('dialog');
    const editor = dialog.locator('[contenteditable="true"]');
    await editor.tap();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${mark}`);
    await dialog.getByRole('button', { name: 'Save' }).tap();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await identities())[0]!.htmlSignature).toContain(mark);
    await noSidewaysScroll(page, 'settings after saving');
  } finally {
    await jmap([['Identity/set', { accountId: account, update: { [before.id]: { htmlSignature: before.htmlSignature, textSignature: before.textSignature } } }, 's']], undefined, SUBMISSION);
  }
});

test('@phone an invitation can be accepted from the message', async ({ page }) => {
  const tag = `E2E phone invite ${Date.now()}`;
  const made = await createInvitedEvent(tag, futureStart('Europe/London').start, 'Europe/London');
  try {
    // By id from the newest messages: the full-text index lags behind delivery.
    const invitation = await waitFor(async () => {
      const acct = await accountId();
      const r = await jmap([
        ['Email/query', { accountId: acct, sort: [{ property: 'receivedAt', isAscending: false }], limit: 30 }, 'q'],
        ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['threadId', 'subject'] }, 'g'],
      ]);
      return (r.g.list as { id: string; threadId: string; subject: string | null }[]).find((e) => (e.subject ?? '').includes(tag));
    }, 20_000, 'the invitation email');
    await page.goto(`/inbox/t/${invitation.threadId}`);
    const card = page.locator(`article.msg[data-email-id="${invitation.id}"] .invite-card`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await noSidewaysScroll(page, 'invite card');
    const accept = card.getByRole('button', { name: 'Accept' });
    await accept.tap();
    await expect(accept).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await made.cleanup();
  }
});

test('@phone an event can be created through the form, without dragging', async ({ page }) => {
  const title = `E2E phone ${Date.now()}`;
  try {
    await page.goto('/calendar');
    await page.getByRole('button', { name: 'New event' }).tap();
    const form = page.getByRole('form', { name: 'Event' });
    await expect(form).toBeVisible();
    await form.getByRole('textbox', { name: 'Title' }).fill(title);
    await form.getByRole('button', { name: 'Create' }).tap();
    await expect.poll(async () => (await eventsByTitle(title)).length).toBe(1);
    await noSidewaysScroll(page, 'calendar after creating');
  } finally {
    await destroyE2eEvents();
  }
});

for (const path of ['/inbox', '/settings', '/calendar']) {
  test(`@phone touch targets on ${path} are at least 44px`, async ({ page }) => {
    await page.goto(path);
    // The scan must look at the app, not at a page still loading.
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(await page.locator('button, a[href]').count()).toBeGreaterThan(5);
    expect(await smallTargets(page)).toEqual([]);
  });
}

test('@phone touch targets in an open thread and in the composer are at least 44px', async ({ page }) => {
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

test('@phone no field has text under 16px, so focusing one does not zoom the page', async ({ page }) => {
  const found: Record<string, string[]> = {};
  await openInbox(page);
  await page.getByRole('button', { name: 'Search options' }).tap();
  await expect(page.getByRole('dialog').getByLabel('From')).toBeVisible();
  found.search = await smallText(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: /^Edit / }).first().tap();
  await expect(page.getByRole('dialog').locator('[contenteditable="true"]')).toBeVisible();
  found.settings = await smallText(page);
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'New event' }).tap();
  await expect(page.getByRole('form', { name: 'Event' })).toBeVisible();
  found.calendar = await smallText(page);
  // The calendar form's select is a native one: WebKit gives it our height only when it is a height.
  expect((await page.getByRole('form', { name: 'Event' }).getByLabel('Calendar').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await openSeeded(page, 'Lunch Friday?');
  await page.getByRole('button', { name: 'Reply', exact: true }).last().tap();
  await expect(bodyEditor(page.locator('.conv .composer.inline'))).toBeVisible();
  found.reply = await smallText(page);
  await page.locator('.conv .composer.inline').getByRole('button', { name: 'Discard draft' }).tap();
  // Nothing was typed, so there may be nothing to confirm.
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Discard' });
  if (await confirm.isVisible().catch(() => false)) await confirm.tap();
  expect(found).toEqual({ search: [], settings: [], calendar: [], reply: [] });
});

test('@phone the drawer holds the theme and sign-out, and is out of reach while closed', async ({ page }) => {
  await openInbox(page);
  // Closed: not on screen, not in the Tab order, and no shadow at the screen's edge.
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.topbar').getByTitle('Toggle theme')).toBeHidden();
  // The search has the room the two buttons had: its placeholder is whole.
  expect(await page.locator('#search-input').evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Menu' }).tap();
  const drawer = page.locator('.sidebar.open');
  await expect(drawer.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  await drawer.getByRole('button', { name: /^(Dark|Light) theme$/ }).tap();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).not.toBe(before);
  // Changing the theme leaves the drawer open, to change it back.
  await drawer.getByRole('button', { name: /^(Dark|Light) theme$/ }).tap();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(before);
  await noSidewaysScroll(page, 'drawer');
});

test('@phone the identity dialog keeps its fields inside it', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: /^Edit / }).first().tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible();
  const d = (await dialog.boundingBox())!;
  for (const part of [dialog.getByRole('button', { name: 'Save' }), dialog.locator('.signature-editor'), dialog.getByRole('textbox').first()]) {
    const b = (await part.boundingBox())!;
    expect(b.x + b.width, 'inside the dialog, with room to spare').toBeLessThanOrEqual(d.x + d.width - 8);
  }
  await dialog.getByRole('button', { name: 'Cancel' }).tap();
});

test('@phone with an on-screen keyboard up, the composer fits what is left and Send stays in sight', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Menu' }).tap();
  await page.getByRole('button', { name: 'Compose' }).tap();
  const c = floatingComposer(page);
  await expect(bodyEditor(c)).toBeVisible();
  // What src/ui/visible.ts sets when iOS draws a 336px keyboard over the page (its own test covers the arithmetic).
  await page.evaluate(() => document.documentElement.style.setProperty('--covered-bottom', '336px'));
  await bodyEditor(c).pressSequentially('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight');
  const send = (await c.getByRole('button', { name: 'Send', exact: true }).boundingBox())!;
  expect(send.y + send.height, 'Send is above the keyboard').toBeLessThanOrEqual(844 - 336);
  const close = (await c.getByRole('button', { name: /close/i }).first().boundingBox())!;
  expect(close.y, 'the title bar stays at the top').toBeGreaterThanOrEqual(0);
  expect(close.y).toBeLessThan(60);
  // The fields above the text can still be reached, by scrolling the message.
  await c.getByRole('textbox', { name: 'Subject' }).scrollIntoViewIfNeeded();
  await expect(c.getByRole('textbox', { name: 'Subject' })).toBeInViewport();
  await page.evaluate(() => document.documentElement.style.removeProperty('--covered-bottom'));
  await c.getByRole('button', { name: 'Discard draft' }).tap();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).tap();
});

test('@phone the calendar toolbar is two rows and the week\'s day names are whole', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/calendar');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  await page.getByRole('button', { name: 'week', exact: true }).tap();
  await expect(page.locator('.fc-timeGridWeek-view')).toBeVisible();
  const title = (await page.locator('.fc-toolbar-title').boundingBox())!;
  expect(title.height, 'the title is one line').toBeLessThan(32);
  const bar = (await page.locator('.fc-header-toolbar').boundingBox())!;
  expect(bar.height, 'two rows of 44px buttons').toBeLessThanOrEqual(100);
  const cut = await page.locator('.fc-col-header-cell').evaluateAll((cells) => cells.filter((c) => c.scrollWidth > c.clientWidth + 1).length);
  expect(cut, 'day names cut short').toBe(0);
  await noSidewaysScroll(page, 'calendar week at 360px');
  expect(await smallTargets(page)).toEqual([]);
});

test('@phone an open message shows its date on one line', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openSeeded(page, 'Lunch Friday?');
  const date = (await page.locator('article.msg:not(.collapsed) .msg-date').last().boundingBox())!;
  expect(date.height).toBeLessThan(24);
  await noSidewaysScroll(page, 'conversation at 360px');
});
