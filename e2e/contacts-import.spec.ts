import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { createAccount, deleteAccount } from './support/accounts';
import { toast } from './support/compose';
import { createCards, destroyAllCards, listCards, named } from './support/contacts';
import { signInThroughStalwart } from './support/login';
import { PASSWORD } from './support/mail';

// Users of this spec's own: an import spends the account's hourly upload allowance, which would
// leave alice unable to attach a file in the other specs.
const NAME = `import-${Date.now().toString(36)}`;
const USER = `${NAME}@example.test`;
const LIMITED = `${NAME}-limit`;

test.use({ storageState: { cookies: [], origins: [] } });
test.beforeAll(() => createAccount(NAME, PASSWORD));
test.afterAll(() => {
  deleteAccount(NAME);
  deleteAccount(LIMITED);
});
test.beforeEach(async ({ page }) => {
  await destroyAllCards(USER);
  await signInThroughStalwart(page, USER, PASSWORD);
});

const dialog = (page: Page) => page.getByRole('dialog');
const card = (page: Page) => page.locator('.contact-card');
const count = (page: Page) => page.locator('.contacts-count');
const rowNames = (page: Page) => page.locator('table.contacts-table tr[data-contact-id] .contacts-name > span:last-child');
const vc = (version: string, ...lines: string[]) => ['BEGIN:VCARD', `VERSION:${version}`, ...lines, 'END:VCARD', ''].join('\r\n');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function openImport(page: Page) {
  await page.goto('/contacts');
  await expect(count(page)).toBeVisible();
  await page.getByRole('button', { name: 'More contact actions' }).click();
  await page.getByRole('menuitem', { name: 'Import…' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Import contacts' })).toBeVisible();
}
const choose = (page: Page, text: string, name = 'contacts.vcf') =>
  dialog(page).getByLabel('vCard files').setInputFiles({ name, mimeType: 'text/vcard', buffer: Buffer.from(text, 'utf8') });

test('cards written by three programs are previewed, the one already here is skipped, and the rest read as they should', async ({ page }) => {
  await createCards([named('Already', 'Here', { uid: 'urn:uuid:here', emails: { e1: { address: 'here@x.example' } } })], USER);
  const outlook = vc('2.1',
    'N;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:M=FCller;J=F6rg',
    'FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:J=F6rg M=FCller',
    'TEL;WORK;VOICE:+49 30 123456',
    'EMAIL;PREF;INTERNET:joerg@firma.example',
    'ORG:Firma GmbH');
  const google = vc('3.0',
    'FN:Zoë Probe',
    'N:Probe;Zoë;;;',
    'item1.EMAIL;TYPE=INTERNET;TYPE=WORK:zoe@work.example',
    'item1.X-ABLabel:Work',
    'EMAIL;TYPE=INTERNET;TYPE=HOME:zoe@home.example',
    'TEL;TYPE=CELL:+1 555 0100',
    'ORG:Acme Ltd;Research',
    'TITLE:Head of Research',
    'BDAY:1990-03-14',
    'NOTE:Met at the conference\\, twice.',
    `PHOTO;ENCODING=b;TYPE=PNG:${PNG}`);
  const present = vc('4.0', 'UID:urn:uuid:here', 'FN:Already Here', 'EMAIL:here@x.example');
  await openImport(page);
  await choose(page, outlook + google + present);
  const d = dialog(page);
  await expect(d.getByText('3 contacts found')).toBeVisible();
  await expect(d.getByText('1 already in your contacts')).toBeVisible();
  await expect(d.getByRole('switch', { name: 'Skip duplicates' })).toBeChecked();
  await expect(d.getByText(/counts it against the same hourly allowance as your attachments/)).toBeVisible();
  await d.getByRole('button', { name: 'Import 2' }).click();
  await expect(d.getByText('Imported 2 contacts.')).toBeVisible();
  await expect(d.getByText('Skipped 1 already in your contacts.')).toBeVisible();
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(d).toBeHidden();

  await expect(count(page)).toHaveText('3 contacts');
  await expect(rowNames(page)).toHaveText(['Already Here', 'Jörg Müller', 'Zoë Probe']);
  await page.getByRole('link', { name: 'Zoë Probe' }).click();
  const c = card(page);
  await expect(c.getByRole('heading', { name: 'Zoë Probe' })).toBeVisible();
  await expect(c).toContainText('Head of Research, Acme Ltd · Research');
  await expect(c.locator('.contact-row', { hasText: 'zoe@work.example' })).toContainText('Work');
  await expect(c.locator('.contact-row', { hasText: 'zoe@home.example' })).toContainText('Personal');
  await expect(c.locator('.contact-row', { hasText: '+1 555 0100' })).toContainText('Mobile');
  await expect(c).toContainText(/14 March 1990|March 14, 1990/);
  await expect(c).toContainText('Met at the conference, twice.');
  await expect(c.locator('.contact-head img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.getByRole('link', { name: 'Jörg Müller' }).click();
  await expect(card(page)).toContainText('Firma GmbH');
  await expect(card(page).locator('.contact-row', { hasText: '+49 30 123456' })).toContainText('Work');
  const stored = await listCards(USER);
  expect(stored.every((s) => typeof s.uid === 'string' && s.uid.length > 0)).toBe(true);
});

test('three hundred cards are imported in full', async ({ page }) => {
  const text = Array.from({ length: 300 }, (_, i) => vc('3.0', `FN:Bulk ${String(i).padStart(3, '0')}`, `N:${String(i).padStart(3, '0')};Bulk;;;`, `EMAIL:bulk${i}@x.example`)).join('');
  await openImport(page);
  await choose(page, text);
  await dialog(page).getByRole('button', { name: 'Import 300' }).click();
  await expect(dialog(page).getByText('Imported 300 contacts.')).toBeVisible({ timeout: 60_000 });
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(count(page)).toHaveText('300 contacts');
  expect(await listCards(USER)).toHaveLength(300);
});

test('a group is imported with its members, as vCard 4 and as Apple write one', async ({ page }) => {
  const text =
    vc('4.0', 'UID:urn:uuid:m1', 'FN:Member One', 'EMAIL:one@x.example') +
    vc('4.0', 'UID:urn:uuid:m2', 'FN:Member Two', 'EMAIL:two@x.example') +
    vc('4.0', 'UID:urn:uuid:g1', 'KIND:group', 'FN:Standard', 'MEMBER:urn:uuid:m1', 'MEMBER:urn:uuid:m2') +
    vc('3.0', 'UID:urn:uuid:g2', 'N:Apple;;;;', 'FN:Apple', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:m2');
  await openImport(page);
  await choose(page, text);
  await expect(dialog(page).getByText('4 contacts found, 2 of them groups')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Import 4' }).click();
  await expect(dialog(page).getByText('Imported 4 contacts.')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(count(page)).toHaveText('2 contacts');
  await page.getByRole('navigation').getByRole('link', { name: /^Standard/ }).click();
  await expect(rowNames(page)).toHaveText(['Member One', 'Member Two']);
  await page.getByRole('navigation').getByRole('link', { name: /^Apple/ }).click();
  await expect(rowNames(page)).toHaveText(['Member Two']);
});

test('a file that is no vCard says nothing was found, and a stop keeps what was saved', async ({ page }) => {
  await openImport(page);
  await choose(page, 'Name,Email\r\nAnn,ann@x.example\r\n', 'contacts.csv');
  await expect(dialog(page).getByText('No contacts were found in these files.')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /^Import/ })).toHaveCount(0);

  const text = Array.from({ length: 250 }, (_, i) => vc('3.0', `FN:Stop ${i}`, `EMAIL:stop${i}@x.example`)).join('');
  await choose(page, text);
  await dialog(page).getByRole('button', { name: 'Import 250' }).click();
  await dialog(page).getByRole('button', { name: 'Stop' }).click();
  await expect(dialog(page).getByText(/^Imported \d+ contacts\.$/)).toBeVisible({ timeout: 30_000 });
  const left = Number((await dialog(page).getByText(/^Stopped: /).textContent())!.match(/\d+/)![0]);
  const saved = (await listCards(USER)).length;
  expect(saved).toBeGreaterThan(0);
  expect(saved + left).toBe(250);
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(count(page)).toHaveText(`${saved} contacts`);
});

test('an export is the same address book when it is imported again', async ({ page }) => {
  await createCards([
    named('Zoë', 'Probe', {
      uid: 'urn:uuid:zoe', kind: 'individual',
      emails: { e1: { address: 'zoe@work.example', contexts: { work: true }, pref: 1 }, e2: { address: 'zoe@home.example', contexts: { private: true } } },
      phones: { p1: { number: '+1 555 0100', features: { mobile: true } } },
      organizations: { o1: { name: 'Acme, Ltd', units: [{ name: 'Research' }] } },
      titles: { t1: { name: 'Head of Research', kind: 'title' } },
      addresses: { a1: { full: '1 High St\nLeeds', contexts: { private: true } } },
      anniversaries: { b1: { kind: 'birth', date: { '@type': 'PartialDate', month: 3, day: 14 } } },
      notes: { n1: { note: 'Likes tea; hates coffee\nSecond line' } },
    }),
    named('Adam', 'Zeller', { uid: 'urn:uuid:adam', emails: { e1: { address: 'adam@x.example' } } }),
    { kind: 'group', uid: 'urn:uuid:team', name: { full: 'Team' }, members: { 'urn:uuid:zoe': true, 'urn:uuid:adam': true } },
  ], USER);
  await page.goto('/contacts');
  await expect(count(page)).toHaveText('2 contacts');
  await page.getByRole('button', { name: 'More contact actions' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export all' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.vcf$/);
  await expect(toast(page, 'Exported 2 contacts and 1 group.')).toBeVisible();
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain('FN:Zoë Probe\r\n');
  expect(text).toContain('EMAIL;TYPE=work;PREF=1:zoe@work.example\r\n');
  expect(text).toContain('TEL;TYPE=cell:+1 555 0100\r\n');
  expect(text).toContain('MEMBER:urn:uuid:zoe\r\n');

  await destroyAllCards(USER);
  await expect(page.getByText('No contacts yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Import…' }).click();
  await choose(page, text);
  await expect(dialog(page).getByText('3 contacts found, 1 of them a group')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Import 3' }).click();
  await expect(dialog(page).getByText('Imported 3 contacts.')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(rowNames(page)).toHaveText(['Adam Zeller', 'Zoë Probe']);
  await page.getByRole('navigation').getByRole('link', { name: /^Team/ }).click();
  await expect(rowNames(page)).toHaveText(['Adam Zeller', 'Zoë Probe']);
  await page.getByRole('link', { name: 'Zoë Probe' }).click();
  const c = card(page);
  await expect(c).toContainText('Head of Research, Acme, Ltd · Research');
  await expect(c.locator('.contact-row', { hasText: 'zoe@work.example' })).toContainText('Work');
  await expect(c.locator('.contact-row', { hasText: 'zoe@work.example' })).toContainText('Preferred');
  await expect(c.locator('.contact-row', { hasText: '+1 555 0100' })).toContainText('Mobile');
  await expect(c.locator('.contact-lines', { hasText: '1 High St' })).toContainText('Leeds');
  await expect(c).toContainText(/14 March|March 14/);
  await expect(c).toContainText('Likes tea; hates coffee');
  const again = (await listCards(USER)).find((x) => x.uid === 'urn:uuid:zoe')!;
  expect(again.addresses.k1 ?? Object.values(again.addresses)[0]).toMatchObject({ full: '1 High St\nLeeds' });
});

test('the import stops at the server\'s upload limit, says so, and keeps what was saved @slow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'spends an account\'s whole hourly upload allowance: once is enough');
  test.setTimeout(240_000);
  // An account of its own, with its allowance untouched: the limit is then met at exactly 1,000.
  createAccount(LIMITED, PASSWORD);
  await page.context().clearCookies();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await signInThroughStalwart(page, `${LIMITED}@example.test`, PASSWORD);
  const text = Array.from({ length: 1050 }, (_, i) => vc('3.0', `FN:Many ${i}`, `EMAIL:many${i}@x.example`)).join('');
  await openImport(page);
  await choose(page, text);
  const d = dialog(page);
  await expect(d.getByText(/^This is more than the usual allowance\./)).toBeVisible();
  await d.getByRole('button', { name: 'Import 1,050' }).click();
  await expect(d.getByText('Imported 1,000 contacts.')).toBeVisible({ timeout: 200_000 });
  await expect(d.getByText("The server's upload limit was reached: 50 contacts were not imported.")).toBeVisible();
  await expect(d.getByText('You have exceeded the blob upload quota of 1000 files or 50000000 bytes.')).toBeVisible();
  await expect(d.getByText(/^You can import them in about \d+ minutes?: choose the same files again/)).toBeVisible();
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(count(page)).toHaveText('1,000 contacts');
  expect(await listCards(`${LIMITED}@example.test`)).toHaveLength(1000);
  // Choosing the same file again offers only what is missing.
  await page.getByRole('button', { name: 'More contact actions' }).click();
  await page.getByRole('menuitem', { name: 'Import…' }).click();
  await choose(page, text);
  await expect(dialog(page).getByText('1,000 already in your contacts')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Import 50' })).toBeVisible();
});
