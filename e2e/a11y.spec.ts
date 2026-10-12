import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows } from './support/app';
import { createCards, destroyCards, named } from './support/contacts';

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

// The contact screens need someone in alice's address book: one card, there for the length of a test.
const made: string[] = [];
test.afterEach(async () => destroyCards(made.splice(0)));
const openContact = async (page: Page) => {
  const [id] = await createCards([
    named('E2e', 'Axe', {
      emails: { e1: { address: 'e2e-axe@work.example', contexts: { work: true }, pref: 1 }, e2: { address: 'e2e-axe@home.example' } },
      phones: { p1: { number: '+1 555 0100', features: { mobile: true } } },
      organizations: { o1: { name: 'Acme Ltd', units: [{ name: 'Research' }] } },
      titles: { t1: { name: 'Head of Research', kind: 'title' } },
      addresses: { a1: { full: '12 High St\nLeeds' } },
      anniversaries: { b1: { kind: 'birth', date: { '@type': 'PartialDate', month: 3, day: 14 } } },
      notes: { n1: { note: 'Likes tea.' } },
      nicknames: { k1: { name: 'Axey' } },
    }),
  ]);
  made.push(id!);
  await page.goto(`/contacts/${id}`);
  await page.locator('.contact-card').getByRole('heading', { name: 'E2e Axe' }).waitFor();
};

/** The same person in a group, with the group on screen and the person selected. */
const openGroup = async (page: Page) => {
  const ids = await createCards([
    named('E2e', 'Axe', { uid: 'urn:uuid:e2e-axe', emails: { e1: { address: 'e2e-axe@work.example' } }, phones: { p1: { number: '+1 555 0100' } } }),
    { kind: 'group', uid: 'urn:uuid:e2e-axe-group', name: { full: 'E2e Axe group' }, members: { 'urn:uuid:e2e-axe': true, 'mailto:elsewhere@x.example': true, 'urn:uuid:gone': true } },
  ]);
  made.push(...ids);
  await page.goto(`/contacts/group/${ids[1]}`);
  await page.getByRole('heading', { name: 'E2e Axe group' }).waitFor();
  await page.getByRole('checkbox', { name: 'Select E2e Axe' }).check();
  await page.getByText('1 selected').waitFor();
};
const openImport = async (page: Page, text: string) => {
  await page.getByRole('button', { name: 'More contact actions' }).click();
  await page.getByRole('menuitem', { name: 'Import…' }).click();
  await page.getByRole('dialog').getByLabel('vCard files').setInputFiles({ name: 'c.vcf', mimeType: 'text/vcard', buffer: Buffer.from(text) });
};
const vcard = (...lines: string[]) => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD', ''].join('\r\n');

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
  'contacts, empty': async (page) => {
    await page.goto('/contacts');
    await page.locator('.contacts-count').waitFor();
  },
  'contact list and card': openContact,
  'contact dialog': async (page) => {
    await openContact(page);
    await page.locator('.contact-card').getByRole('button', { name: 'Edit' }).click();
    await page.locator('.contact-dialog').getByLabel('Given name').waitFor();
  },
  'contact dialog with errors': async (page) => {
    await page.goto('/contacts');
    await page.locator('.contacts-count').waitFor();
    await page.getByRole('button', { name: 'New contact' }).first().click();
    const d = page.locator('.contact-dialog');
    await d.getByLabel('Email 1', { exact: true }).fill('not an address');
    await d.getByRole('button', { name: 'Save' }).click();
    await d.getByText('This is not an email address.').waitFor();
  },
  'contact group with a selection': openGroup,
  'group picker': async (page) => {
    await openGroup(page);
    await page.getByRole('button', { name: 'Add to group' }).click();
    await page.getByRole('menuitem', { name: 'New group…' }).waitFor();
  },
  'group dialog': async (page) => {
    await openGroup(page);
    await page.locator('nav.sidebar').getByRole('button', { name: 'New group' }).click();
    const name = page.getByRole('textbox', { name: 'Group name' });
    await name.fill('E2e Axe group');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByText('There is already a group called “E2e Axe group”.').waitFor();
  },
  'import preview': async (page) => {
    await openContact(page);
    // 1,001 new cards for the warning, one already here, and one cut short. Nothing is sent.
    const many = Array.from({ length: 1001 }, (_, i) => vcard(`FN:New ${i}`, `EMAIL:new${i}@x.example`)).join('');
    await openImport(page, many + vcard('FN:E2e Axe', 'EMAIL:e2e-axe@work.example') + 'BEGIN:VCARD\r\nFN:Cut short\r\n');
    await page.getByRole('dialog').getByText('1 already in your contacts').waitFor();
    await page.getByRole('dialog').getByText(/^This is more than the usual allowance/).waitFor();
  },
  'import result': async (page) => {
    await page.goto('/contacts');
    await page.locator('.contacts-count').waitFor();
    // A card too large to send fails without an upload: the result screen, at no cost to alice's allowance.
    await openImport(page, vcard('FN:Too Large', `NOTE:${'x'.repeat(7_000_001)}`));
    await page.getByRole('dialog').getByRole('button', { name: 'Import 1' }).click();
    await page.getByRole('dialog').getByText('Too Large: This card is too large to import.').waitFor();
  },
  'person popover': async (page) => {
    await openThread(page);
    await page.locator('article.msg .person.addr').last().click();
    await page.locator('.person-card').waitFor();
  },
  'search box with pills': async (page) => {
    await page.goto('/search/' + encodeURIComponent('from:bob label:nowhere is:unread'));
    await expect(page.locator('.search-pill')).toHaveCount(3);
  },
  'search panel': async (page) => {
    await page.goto('/search/' + encodeURIComponent('from:bob label:nowhere is:unread'));
    await expect(page.locator('.search-pill')).toHaveCount(3);
    await page.getByRole('button', { name: 'Search options' }).click();
    await expect(page.getByRole('dialog', { name: 'Search options' })).toBeVisible();
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
