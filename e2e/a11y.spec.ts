import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows } from './support/app';

// WCAG 2.1 A and AA. Only serious and critical violations fail a test; the rest are read in audits.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function check(page: Page, name: string) {
  // A dialog that is still fading in has blended colours that fail contrast for a moment.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  // The message frame runs no scripts, so axe cannot get into it (it hangs trying). Its content is the sender's HTML.
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).exclude('.msg-body iframe').analyze();
  const bad = violations
    .filter((v) => (v.impact === 'serious' || v.impact === 'critical') && !isA1(v))
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s), e.g. ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  if (process.env.A11Y_DUMP) {
    const { appendFileSync } = await import('node:fs');
    for (const v of violations) for (const n of v.nodes) appendFileSync(process.env.A11Y_DUMP, JSON.stringify({ name, id: v.id, impact: v.impact, target: n.target.join(' '), summary: n.failureSummary?.replace(/\s+/g, ' ').slice(0, 260) }) + '\n');
  }
  expect(bad, name).toEqual([]);
}

const openThread = async (page: Page) => {
  await openInbox(page);
  // Erin's HTML reply: a message with images, a quote toggle and a banner.
  await rows(page).filter({ hasText: 'Homepage' }).first().click();
  await page.locator('article.msg .msg-body iframe').first().waitFor();
};

const openCalendar = async (page: Page) => {
  await page.goto('/calendar');
  await page.locator('.calendar-view .fc-event').first().waitFor();
};

const screens: Record<string, (page: Page) => Promise<void>> = {
  'thread list': (page) => openInbox(page),
  conversation: openThread,
  'new message': async (page) => {
    await openInbox(page);
    await page.getByRole('button', { name: 'Compose' }).click();
    await page.locator('.compose-dock .composer').getByLabel('Subject').waitFor();
  },
  'inline reply': async (page) => {
    await openThread(page);
    await page.keyboard.press('r');
    await page.locator('.conv .composer.inline [contenteditable="true"]').waitFor();
  },
  'search results': async (page) => {
    await page.goto('/search/from%3Abob');
    await rows(page).first().waitFor();
  },
  settings: async (page) => {
    await page.goto('/settings');
    await page.getByRole('heading', { name: 'Settings' }).waitFor();
    await page.getByRole('heading', { name: 'Identities and signatures' }).waitFor();
  },
  'calendar week': openCalendar,
  'event card': async (page) => {
    await openCalendar(page);
    await page.locator('.calendar-view .fc-event').filter({ hasText: 'Design review' }).click();
    await page.getByRole('dialog', { name: 'Design review' }).waitFor();
  },
  'event form': async (page) => {
    await openCalendar(page);
    await page.locator('.calendar-view .fc-event').filter({ hasText: 'Design review' }).click();
    await page.getByRole('dialog', { name: 'Design review' }).getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('form', { name: 'Event' }).waitFor();
  },
  'confirm dialog': async (page) => {
    await openInbox(page);
    await page.keyboard.press('j');
    await page.keyboard.press('e');
    await page.getByRole('dialog').waitFor();
  },
  'label dialog': async (page) => {
    await openInbox(page);
    await page.getByRole('button', { name: 'New label' }).click();
    await page.getByRole('dialog').waitFor();
  },
  'shortcuts dialog': async (page) => {
    await openInbox(page);
    await page.keyboard.press('?');
    await page.getByRole('dialog').waitFor();
  },
};

/**
 * The one open finding (docs/beta-audit.md, A1): rozie Popover puts aria-modal on a panel with no dialog
 * role. It is left out of the screen checks, so those still catch anything else, and has a test of
 * its own below that turns green when rozie is fixed.
 */
const isA1 = (v: { id: string; nodes: { target: unknown[] }[] }) => v.id === 'aria-allowed-attr' && v.nodes.every((n) => n.target.join(' ') === '#rozie-popover-panel');

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const [name, open] of Object.entries(screens)) {
      test(`${name} has no serious axe violations`, async ({ page }) => {
        await open(page);
        await check(page, `${name} (${scheme})`);
      });
    }
  });
}

test('the event card popover has no ARIA attribute it may not have', async ({ page }) => {
  await screens['event card']!(page);
  const { violations } = await new AxeBuilder({ page }).withRules(['aria-allowed-attr']).analyze();
  expect(violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')))).toEqual([]);
});

test('a toast is announced by the toaster\'s standing region, and its own row is not a second one', async ({ page }) => {
  // A label that doesn't exist is the cheapest way to a toast: nothing to clean up.
  await page.goto('/label/does-not-exist');
  const text = 'That label no longer exists.';
  const toast = page.locator('.toast', { hasText: text });
  await expect(toast).toBeVisible();
  // Neither oinbox's element nor anything around it is a live region: a second one can be read twice.
  expect(await toast.evaluate((el) => {
    let regions = 0;
    for (let n: Element | null = el; n; n = n.parentElement) if (n.matches('[role=status], [role=alert], [aria-live]')) regions++;
    return regions;
  })).toBe(0);
  // This one is information, not an error: its text is in the polite region, and not in the assertive one.
  await expect(page.locator('[role=status]', { hasText: text })).toHaveCount(1);
  await expect(page.locator('[role=alert]', { hasText: text })).toHaveCount(0);
});

test('sign-in has no serious axe violations', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  await check(page, 'sign-in');
  await context.close();
});
