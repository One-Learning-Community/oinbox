import { expect, test, type Page } from '@playwright/test';
import { createAccount, deleteAccount } from './support/accounts';
import { deliveredCopy, emailDetails, floatingComposer, recipientChips, recipientInput, sendAndWait, subjectInput, suggestions, toast, typeBody } from './support/compose';
import { createCards, destroyAllCards, listCards, named } from './support/contacts';
import { signInThroughStalwart } from './support/login';
import { ALICE, BOB, PASSWORD, destroyEmails, emailsBySubject, mailboxByRole, uniqueTag } from './support/mail';

// A user of this spec's own: groups change what the composer suggests, and the other specs count on alice's.
const NAME = `groups-${Date.now().toString(36)}`;
const USER = `${NAME}@example.test`;

test.use({ storageState: { cookies: [], origins: [] } });
test.beforeAll(() => createAccount(NAME, PASSWORD));
test.afterAll(() => deleteAccount(NAME));
test.beforeEach(async ({ page }) => {
  await destroyAllCards(USER);
  await signInThroughStalwart(page, USER, PASSWORD);
});

const rowNames = (page: Page) => page.locator('table.contacts-table tr[data-contact-id] .contacts-name > span:last-child');
const count = (page: Page) => page.locator('.contacts-count').first();
const card = (page: Page) => page.locator('.contact-card');
const sidebar = (page: Page) => page.locator('nav.sidebar');
const groupLink = (page: Page, name: string) => sidebar(page).getByRole('link', { name: new RegExp(`^${name}`) });
const select = (page: Page, name: string) => page.getByRole('checkbox', { name: `Select ${name}` });
const mine = () => listCards(USER);
const group = async (name: string) => (await mine()).find((c) => c.kind === 'group' && c.name?.full === name);

async function openContacts(page: Page) {
  await page.goto('/contacts');
  await expect(count(page)).toBeVisible();
}
const people = () =>
  createCards(
    [
      named('Ann', 'Archer', { uid: 'urn:uuid:ann', emails: { e1: { address: 'ann@home.example' }, e2: { address: ALICE, pref: 1 } } }),
      named('Bob', 'Baker', { uid: 'urn:uuid:bob', emails: { e1: { address: BOB } } }),
      named('Cy', 'Cole', { uid: 'urn:uuid:cy' }),
    ],
    USER,
  );

test('a group is made, filled from a selection, shown on the card, renamed and deleted, and its people stay', async ({ page }) => {
  await people();
  await openContacts(page);
  await sidebar(page).getByRole('button', { name: 'New group' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Team');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(groupLink(page, 'Team')).toBeVisible();

  await select(page, 'Ann Archer').check();
  await select(page, 'Cy Cole').check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Add to group' }).click();
  await page.getByRole('menuitem', { name: 'Team' }).click();
  await expect(toast(page, 'Added 2 to Team.')).toBeVisible();
  expect((await group('Team'))!.members).toEqual({ 'urn:uuid:ann': true, 'urn:uuid:cy': true });
  await page.getByRole('button', { name: 'Clear selection' }).click();

  await groupLink(page, 'Team').click();
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await expect(rowNames(page)).toHaveText(['Ann Archer', 'Cy Cole']);
  await expect(groupLink(page, 'Team')).toContainText('2');

  // The card shows the group; taking the person out of it empties the list of them.
  await page.getByRole('link', { name: 'Cy Cole' }).click();
  await expect(card(page).locator('.contact-group', { hasText: 'Team' })).toBeVisible();
  await card(page).getByRole('button', { name: 'Remove from Team' }).click();
  await expect(rowNames(page)).toHaveText(['Ann Archer']);
  expect((await group('Team'))!.members).toEqual({ 'urn:uuid:ann': true });

  await sidebar(page).getByRole('button', { name: 'Options for Team' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Crew');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible();
  await expect(groupLink(page, 'Crew')).toBeVisible();

  await sidebar(page).getByRole('button', { name: 'Options for Crew' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(confirm.getByText('Delete “Crew”?')).toBeVisible();
  await expect(confirm.getByText('The 1 person in it stays in your contacts.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete group' }).click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(groupLink(page, 'Crew')).toHaveCount(0);
  await expect(rowNames(page)).toHaveText(['Ann Archer', 'Bob Baker', 'Cy Cole']);
  expect((await mine()).filter((c) => c.kind === 'group')).toEqual([]);
});

test('a card another client made without a uid is made again with one when it joins a group, and the page follows it', async ({ page }) => {
  const [oldId] = await createCards([named('Dee', 'Dunn', { emails: { e1: { address: 'dee@x.example' } }, notes: { n1: { note: 'Kept.' } } }), { kind: 'group', uid: 'urn:uuid:g', name: { full: 'Team' } }], USER);
  await page.goto(`/contacts/${oldId}`);
  await expect(card(page).getByRole('heading', { name: 'Dee Dunn' })).toBeVisible();
  await card(page).getByRole('button', { name: 'Add to group' }).click();
  await page.getByRole('menuitem', { name: 'Team' }).click();
  await expect(card(page).locator('.contact-group', { hasText: 'Team' })).toBeVisible();
  await expect(card(page).getByRole('heading', { name: 'Dee Dunn' })).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`/contacts/${oldId}$`));
  await expect(toast(page, 'That contact was deleted.')).toHaveCount(0);
  const cards = await mine();
  const dee = cards.filter((c) => c.kind !== 'group');
  expect(dee).toHaveLength(1);
  expect(dee[0]!.id).not.toBe(oldId);
  expect(dee[0]).toMatchObject({ emails: { e1: { address: 'dee@x.example' } }, notes: { n1: { note: 'Kept.' } } });
  expect(dee[0]!.uid).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  expect((await group('Team'))!.members).toEqual({ [dee[0]!.uid as string]: true });
});

test('several people are deleted at once after a confirmation, and a group is exported with its card', async ({ page }) => {
  await people();
  await createCards([{ kind: 'group', uid: 'urn:uuid:g', name: { full: 'Team' }, members: { 'urn:uuid:ann': true } }], USER);
  await openContacts(page);
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await expect(page.getByText('3 selected')).toBeVisible();
  await select(page, 'Ann Archer').uncheck();
  await page.locator('.contacts-selection').getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(confirm.getByText('Delete 2 contacts?')).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(toast(page, 'Deleted 2 contacts.')).toBeVisible();
  await expect(rowNames(page)).toHaveText(['Ann Archer']);
  expect((await mine()).filter((c) => c.kind !== 'group').map((c) => c.uid)).toEqual(['urn:uuid:ann']);

  await groupLink(page, 'Team').click();
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await page.getByRole('button', { name: 'More contact actions' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export this group' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.vcf$/);
  await expect(toast(page, 'Exported 1 contact and 1 group.')).toBeVisible();
});

test('a group typed into To is offered as a list and becomes one chip per member, and the message reaches them', async ({ page }) => {
  await people();
  await createCards([{ kind: 'group', uid: 'urn:uuid:g', name: { full: 'Projektgruppe' }, members: { 'urn:uuid:ann': true, 'urn:uuid:bob': true, 'urn:uuid:cy': true } }], USER);
  const subject = uniqueTag('group');
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Compose' }).click();
  const c = floatingComposer(page);
  await expect(c).toBeVisible();
  await recipientInput(c).fill('projekt');
  const option = suggestions(c).filter({ hasText: 'Projektgruppe' });
  await expect(option).toContainText('List · 3 people');
  await option.click();
  // One chip each, by preferred address: who gets the message can be seen.
  await expect(recipientChips(c)).toHaveCount(2);
  await expect(recipientChips(c).nth(0)).toContainText(ALICE);
  await expect(recipientChips(c).nth(1)).toContainText(BOB);
  await expect(toast(page, '1 of 3 in Projektgruppe has no email address.')).toBeVisible();
  await expect(recipientInput(c)).toHaveValue('');

  // Picking it again adds nobody twice.
  await recipientInput(c).fill('projekt');
  await suggestions(c).filter({ hasText: 'Projektgruppe' }).click();
  await expect(recipientChips(c)).toHaveCount(2);
  await expect(toast(page, 'Everyone in Projektgruppe is already on this message.')).toBeVisible();

  await subjectInput(c).fill(subject);
  await typeBody(c, 'To the group.');
  await sendAndWait(page, c);
  try {
    const got = await deliveredCopy(subject, ALICE, await mailboxByRole('inbox', ALICE));
    expect((await emailDetails(got.id, ALICE)).to.map((a) => a.email).sort()).toEqual([ALICE, BOB].sort());
    await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  } finally {
    for (const user of [ALICE, BOB]) await destroyEmails((await emailsBySubject(subject, user)).map((e) => e.id), user);
  }
});

const noSidewaysScroll = async (page: Page, where: string) =>
  expect(
    await page.evaluate(() => {
      const wide: string[] = [];
      if (document.documentElement.scrollWidth > window.innerWidth) wide.push('page');
      for (const el of document.querySelectorAll<HTMLElement>('.main, .contacts-view, .contacts-list, .contacts-scroll, .contact-pane, .contacts-selection, .import-form')) {
        if (el.checkVisibility() && el.scrollWidth > el.clientWidth + 1) wide.push(`${el.className.split(' ')[0]} ${el.scrollWidth}>${el.clientWidth}`);
      }
      return wide;
    }),
    `${where} is wider than the screen`,
  ).toEqual([]);

test('@phone people are selected and added to a group with a finger, and nothing is wider than the screen', async ({ page }) => {
  await people();
  await createCards([{ kind: 'group', uid: 'urn:uuid:g', name: { full: 'A group with quite a long name indeed' } }], USER);
  await openContacts(page);
  const box = (await select(page, 'Ann Archer').boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  await select(page, 'Ann Archer').tap();
  await select(page, 'Bob Baker').tap();
  await expect(page.getByText('2 selected')).toBeVisible();
  await noSidewaysScroll(page, 'selection toolbar');
  for (const name of ['Add to group', 'Export', 'Delete', 'Clear selection']) {
    const b = (await page.locator('.contacts-selection').getByRole('button', { name, exact: true }).boundingBox())!;
    expect(b.height, name).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width, name).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.getByRole('button', { name: 'Add to group' }).tap();
  await page.getByRole('menuitem', { name: /^A group with quite a long name/ }).tap();
  await expect(toast(page, /^Added 2 to A group/)).toBeVisible();
  expect((await group('A group with quite a long name indeed'))!.members).toEqual({ 'urn:uuid:ann': true, 'urn:uuid:bob': true });

  await page.getByRole('button', { name: 'Clear selection' }).tap();
  await page.getByRole('button', { name: 'Menu' }).tap();
  await groupLink(page, 'A group').tap();
  await expect(page.getByRole('heading', { name: /^A group with quite/ })).toBeVisible();
  await expect(rowNames(page)).toHaveText(['Ann Archer', 'Bob Baker']);
  await noSidewaysScroll(page, 'group view');

  await page.getByRole('button', { name: 'More contact actions' }).tap();
  await page.getByRole('menuitem', { name: 'Import…' }).tap();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Import contacts' })).toBeVisible();
  await page.getByRole('dialog').getByLabel('vCard files').setInputFiles({ name: 'c.vcf', mimeType: 'text/vcard', buffer: Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:New One\r\nEMAIL:new@x.example\r\nEND:VCARD\r\n') });
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Import 1' })).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  await noSidewaysScroll(page, 'import dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Import 1' }).tap();
  await expect(page.getByRole('dialog').getByText('Imported 1 contact.')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).tap();
});
