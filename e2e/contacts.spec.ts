import { expect, test, type Page } from '@playwright/test';
import { createAccount, deleteAccount } from './support/accounts';
import { floatingComposer, recipientChips, recipientInput, suggestions, toast } from './support/compose';
import { createCards, destroyAllCards, destroyCards, listCards, named, updateCard } from './support/contacts';
import { signInThroughStalwart } from './support/login';
import { waitLive } from './support/app';
import { PASSWORD, sendMail, uniqueTag } from './support/mail';

// A user of this spec's own: saved contacts change what the composer suggests, and the other specs
// count on alice's suggestions.
const NAME = `contacts-${Date.now().toString(36)}`;
const USER = `${NAME}@example.test`;

test.use({ storageState: { cookies: [], origins: [] } });
test.beforeAll(() => createAccount(NAME, PASSWORD));
test.afterAll(() => deleteAccount(NAME));
test.beforeEach(async ({ page }) => {
  await destroyAllCards(USER);
  await signInThroughStalwart(page, USER, PASSWORD);
});

const listRows = (page: Page) => page.locator('table.contacts-table tr[data-contact-id]');
const rowNames = (page: Page) => listRows(page).locator('.contacts-name > span:last-child');
const dialog = (page: Page) => page.locator('.contact-dialog');
const card = (page: Page) => page.locator('.contact-card');
const count = (page: Page) => page.locator('.contacts-count');
const mine = () => listCards(USER);

async function openContacts(page: Page) {
  await page.goto('/contacts');
  await expect(count(page)).toBeVisible();
}

test('a person is added, found, edited and deleted, and the delete can be undone', async ({ page }) => {
  await openContacts(page);
  await expect(page.getByText('No contacts yet.')).toBeVisible();
  await page.locator('.contacts-list').getByRole('button', { name: 'New contact' }).click();
  const d = dialog(page);
  await d.getByLabel('Given name').fill('Zoë');
  await d.getByLabel('Surname').fill('Probe-Smith');
  await d.getByLabel('Email 1', { exact: true }).fill('zoe@work.example');
  await d.getByLabel('Email 1 type').selectOption('work');
  await d.getByLabel('Phone 1', { exact: true }).fill('+1 555 0100');
  await d.getByLabel('Organisation').fill('Acme Ltd');
  await d.getByLabel('Notes').fill('Met at the conference.');
  await d.getByRole('button', { name: 'Save' }).click();

  await expect(page).toHaveURL(/\/contacts\/[^/]+$/);
  await expect(card(page).getByRole('heading', { name: 'Zoë Probe-Smith' })).toBeVisible();
  await expect(card(page)).toContainText('zoe@work.example');
  await expect(card(page)).toContainText('Acme Ltd');
  await expect(card(page)).toContainText('Met at the conference.');
  const [stored] = await mine();
  expect(stored).toMatchObject({
    kind: 'individual',
    name: { full: 'Zoë Probe-Smith', components: [{ kind: 'given', value: 'Zoë' }, { kind: 'surname', value: 'Probe-Smith' }] },
    emails: { e1: { address: 'zoe@work.example', contexts: { work: true } } },
    phones: { p1: { number: '+1 555 0100', features: { mobile: true } } },
  });
  expect(stored!.uid).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  expect(stored!.created).toBeTruthy();

  // Someone added on another device appears without a reload.
  await createCards([named('Adam', 'Zeller', { emails: { e: { address: 'adam@x.example' } } })], USER);
  await expect(rowNames(page)).toHaveText(['Adam Zeller', 'Zoë Probe-Smith']);
  await expect(count(page)).toHaveText('2 contacts');

  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('acm');
  await expect(rowNames(page)).toHaveText(['Zoë Probe-Smith']);
  await expect(count(page)).toHaveText('1 of 2');
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('');

  await card(page).getByRole('button', { name: 'Edit' }).click();
  await expect(d.getByLabel('Given name')).toHaveValue('Zoë');
  await d.getByLabel('Phone 1', { exact: true }).fill('+1 555 0200');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(d).toBeHidden();
  await expect(card(page)).toContainText('+1 555 0200');
  const edited = (await mine()).find((c) => c.id === stored!.id)!;
  expect(edited.phones).toEqual({ p1: { number: '+1 555 0200', features: { mobile: true } } });
  expect(edited.emails).toEqual(stored!.emails);
  expect(edited.updated).toBeTruthy();

  await card(page).getByRole('button', { name: 'Delete' }).click();
  await expect(toast(page, 'Contact deleted.')).toBeVisible();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(rowNames(page)).toHaveText(['Adam Zeller']);
  await toast(page, 'Contact deleted.').getByRole('button', { name: 'Undo' }).click();
  await expect(rowNames(page)).toHaveText(['Adam Zeller', 'Zoë Probe-Smith']);
  expect((await mine()).find((c) => c.uid === stored!.uid)).toMatchObject({ notes: stored!.notes, emails: stored!.emails });
});

test('a card changed or deleted on another device follows on screen', async ({ page }) => {
  const [id] = await createCards([named('Remote', 'Before')], USER);
  await page.goto(`/contacts/${id}`);
  await expect(card(page).getByRole('heading', { name: 'Remote Before' })).toBeVisible();
  // The push stream must be up before something happens elsewhere, as in the other specs.
  await waitLive(page);
  await updateCard(id!, { name: { components: [{ kind: 'given', value: 'Remote' }, { kind: 'surname', value: 'After' }], isOrdered: true, full: 'Remote After' } }, USER);
  await expect(card(page).getByRole('heading', { name: 'Remote After' })).toBeVisible();
  await destroyCards([id!], USER);
  await expect(toast(page, 'That contact was deleted.')).toBeVisible();
  await expect(page).toHaveURL(/\/contacts$/);
});

test('an address book of more than one page is shown whole', async ({ page }) => {
  const pad = (i: number) => String(i).padStart(3, '0');
  await createCards(Array.from({ length: 500 }, (_, i) => named('Bulk', pad(i))), USER);
  await createCards(Array.from({ length: 20 }, (_, i) => named('Bulk', pad(500 + i))), USER);
  await openContacts(page);
  await expect(count(page)).toHaveText('520 contacts');
  await page.locator('.contacts-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(rowNames(page).last()).toHaveText('Bulk 519');
  // Only the rows in view are in the page.
  expect(await listRows(page).count()).toBeLessThan(80);
});

test("a card written by a phone reads the right way round and keeps its data through an edit", async ({ page }) => {
  // As Stalwart stores a vCard PUT over CardDAV: surname first, no isOrdered, the phone's own contexts.
  const emails = { k1: { address: 'dav@home.example', contexts: { internet: true, private: true } }, k2: { address: 'dav@work.example', contexts: { work: true }, pref: 1 } };
  const [id] = await createCards(
    [{ uid: uniqueTag('dav'), name: { full: 'Dav Phone', components: [{ kind: 'surname', value: 'Phone' }, { kind: 'given', value: 'Dav' }] }, emails, nicknames: { k1: { name: 'Davvy' } }, keywords: { vip: true } }],
    USER,
  );
  await page.goto(`/contacts/${id}`);
  await expect(card(page).getByRole('heading', { name: 'Dav Phone' })).toBeVisible();
  await expect(card(page)).toContainText('Davvy');
  await card(page).getByRole('button', { name: 'Edit' }).click();
  const d = dialog(page);
  await expect(d.getByLabel('Given name')).toHaveValue('Dav');
  await expect(d.getByLabel('Surname')).toHaveValue('Phone');
  await d.getByLabel('Notes').fill('Edited in oinbox');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(card(page)).toContainText('Edited in oinbox');
  const after = (await mine()).find((c) => c.id === id)!;
  expect(after.emails).toEqual(emails);
  expect(after.nicknames).toEqual({ k1: { name: 'Davvy' } });
  expect(after.keywords).toEqual({ vip: true });
  expect(after.name.components).toEqual([{ kind: 'surname', value: 'Phone' }, { kind: 'given', value: 'Dav' }]);
});

test("a message's sender is saved from the message, and is then a contact there", async ({ page }) => {
  const subject = `${uniqueTag()} hello from Nora`;
  await sendMail({ from: 'Nora New <nora@new.example>', to: [USER], subject, text: 'Pleased to meet you.' });
  await page.goto('/inbox');
  await page.locator('a.row', { hasText: subject }).click();
  const person = page.locator('article.msg').getByRole('button', { name: '<nora@new.example>' });
  await person.click();
  const pop = page.getByRole('dialog', { name: 'Nora New' });
  await pop.getByRole('button', { name: 'Add to contacts' }).click();
  const d = dialog(page);
  await expect(d.getByLabel('Given name')).toHaveValue('Nora');
  await expect(d.getByLabel('Surname')).toHaveValue('New');
  await expect(d.getByLabel('Email 1', { exact: true })).toHaveValue('nora@new.example');
  await d.getByLabel('Surname').fill('Saved');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Saved to contacts.')).toBeVisible();
  await expect(page).toHaveURL(/\/inbox\/t\//);

  await person.click();
  const saved = page.getByRole('dialog', { name: 'Nora Saved' });
  await expect(saved.getByRole('button', { name: 'Edit contact' })).toBeVisible();
  await saved.getByRole('link', { name: 'Open in Contacts' }).click();
  await expect(card(page).getByRole('heading', { name: 'Nora Saved' })).toBeVisible();
});

test('a recipient chip is saved from the composer, and saved people are suggested by name and by organisation', async ({ page }) => {
  await createCards([named('Olga', 'Orga', { emails: { e: { address: 'olga@acme.example' } }, organizations: { o: { name: 'Acme Ltd' } } })], USER);
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Compose' }).click();
  const c = floatingComposer(page);
  await recipientInput(c).fill('zed@chip.example');
  await recipientInput(c).press('Enter');
  await recipientChips(c).getByRole('button', { name: 'zed@chip.example', exact: true }).click();
  await page.getByRole('dialog', { name: 'zed@chip.example' }).getByRole('button', { name: 'Add to contacts' }).click();
  const d = dialog(page);
  await d.getByLabel('Given name').fill('Zed');
  await d.getByLabel('Surname').fill('Chipson');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Saved to contacts.')).toBeVisible();
  // The half-written message is still there, with its recipient.
  await expect(recipientChips(c)).toHaveCount(1);

  const cc = c.getByRole('button', { name: /Cc/ }).first();
  if (await cc.isVisible()) await cc.click();
  const field = recipientInput(c, 'Cc');
  await field.fill('acm');
  const olga = suggestions(c).filter({ hasText: 'olga@acme.example' });
  await expect(olga).toContainText('Olga Orga');
  await expect(olga).toContainText('Contact');
  await field.fill('');
  // Zed is on the To line already, so he is not offered again; remove him and he is, under his saved name.
  await recipientChips(c).getByRole('button', { name: /^Remove/ }).click();
  await recipientInput(c).fill('chips');
  await expect(suggestions(c).first()).toContainText('Zed Chipson');
  await expect(suggestions(c).first()).toContainText('Contact');
});

test('a chosen photo is made small and kept in the card', async ({ page }) => {
  const [id] = await createCards([named('Photo', 'Person')], USER);
  await page.goto(`/contacts/${id}`);
  await card(page).getByRole('button', { name: 'Edit' }).click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 600, 400);
    g.addColorStop(0, '#c00');
    g.addColorStop(1, '#00c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 600, 400);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const d = dialog(page);
  await d.locator('input[type="file"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(d.locator('img.avatar-photo')).toBeVisible();
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(card(page).locator('img.avatar-photo')).toBeVisible();
  const media = Object.values((await mine())[0]!.media as Record<string, { kind: string; uri: string }>);
  expect(media).toHaveLength(1);
  expect(media[0]!.kind).toBe('photo');
  expect(media[0]!.uri).toMatch(/^data:image\/jpeg;base64,/);
  expect(media[0]!.uri.length).toBeLessThan(60_000);
});

test('what the server would take but should not be saved is refused in the dialog', async ({ page }) => {
  await openContacts(page);
  await page.locator('.contacts-list').getByRole('button', { name: 'New contact' }).click();
  const d = dialog(page);
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(d.getByText('Give a name, an organisation or an email address.')).toBeVisible();
  await d.getByLabel('Email 1', { exact: true }).fill('not an address');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(d.getByText('This is not an email address.')).toBeVisible();
  expect(await mine()).toEqual([]);
  // Leaving with something typed asks first.
  await d.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog').filter({ hasText: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click();
  await expect(d).toBeHidden();
});

test('Contacts is reached from the sidebar and by g then p', async ({ page }) => {
  await page.goto('/inbox');
  await page.getByRole('link', { name: 'Contacts' }).click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(page.getByRole('button', { name: 'New contact' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.locator('body').press('g');
  await page.locator('body').press('p');
  await expect(page).toHaveURL(/\/contacts$/);
});

const noSidewaysScroll = async (page: Page, where: string) =>
  expect(
    await page.evaluate(() => {
      const wide: string[] = [];
      if (document.documentElement.scrollWidth > window.innerWidth) wide.push('page');
      for (const el of document.querySelectorAll<HTMLElement>('.main, .contacts-view, .contacts-list, .contacts-scroll, .contact-pane, .contact-form-body')) {
        if (el.checkVisibility() && el.scrollWidth > el.clientWidth + 1) wide.push(`${el.className.split(' ')[0]} ${el.scrollWidth}>${el.clientWidth}`);
      }
      return wide;
    }),
    `${where} is wider than the screen`,
  ).toEqual([]);

test('@phone the list fills the screen, a tap opens the card, and the dialog fills the screen', async ({ page }) => {
  await createCards(
    [named('Zoë', 'Probe-Smith', { emails: { e: { address: 'zoe.probe-smith@a-rather-long-domain-name.example' } }, phones: { p: { number: '+1 555 0100' } }, organizations: { o: { name: 'Acme Ltd' } }, notes: { n: { note: 'Met at the conference.' } } }), named('Adam', 'Zeller')],
    USER,
  );
  await openContacts(page);
  await expect(rowNames(page)).toHaveText(['Adam Zeller', 'Zoë Probe-Smith']);
  await expect(page.locator('.contact-pane')).toBeHidden();
  await noSidewaysScroll(page, 'contact list');
  expect((await listRows(page).first().boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await rowNames(page).last().tap();
  await expect(card(page).getByRole('heading', { name: 'Zoë Probe-Smith' })).toBeVisible();
  await expect(page.locator('.contacts-list')).toBeHidden();
  await noSidewaysScroll(page, 'contact card');

  await card(page).getByRole('button', { name: 'Edit' }).tap();
  const d = dialog(page);
  await expect(d.getByLabel('Given name')).toBeVisible();
  // The dialog grows into place: measure it once it has.
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const box = (await d.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(388);
  await noSidewaysScroll(page, 'contact dialog');
  await d.getByRole('button', { name: 'Save' }).scrollIntoViewIfNeeded();
  await expect(d.getByRole('button', { name: 'Save' })).toBeInViewport();
  await d.getByRole('button', { name: 'Cancel' }).tap();
  await expect(d).toBeHidden();

  await page.getByRole('link', { name: 'Back to contacts' }).tap();
  await expect(rowNames(page)).toHaveCount(2);

  // A recipient's name is a button now: on a touch screen it must be big enough to hit.
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Menu' }).tap();
  await page.getByRole('button', { name: 'Compose' }).tap();
  const c = floatingComposer(page);
  await recipientInput(c).fill('zoe.probe-smith@a-rather-long-domain-name.example');
  await recipientInput(c).press('Enter');
  const chip = recipientChips(c).locator('button.person');
  const size = (await chip.boundingBox())!;
  expect(size.height).toBeGreaterThanOrEqual(43.5);
  await chip.tap();
  await expect(page.getByRole('dialog', { name: 'Zoë Probe-Smith' }).getByRole('button', { name: 'Edit contact' })).toBeVisible();
  await noSidewaysScroll(page, 'composer with the person card open');
});
