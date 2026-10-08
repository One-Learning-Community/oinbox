import { expect, test, type Page } from '@playwright/test';
import { bodyEditor, floatingComposer, inlineComposer, sendAndWait, subjectInput, typeBody } from './support/compose';
import { accountId, jmap, sendMail, sharedAccountId, uniqueTag, waitFor, ALICE, BOB } from './support/mail';
import { openInbox, rows, waitLive } from './support/app';
import { signInThroughStalwart } from './support/login';

// alice and bob are members of the group support@example.test (deploy/seed.sh), which each of them
// sees as a second account. Its Inbox is seeded with three messages.
const SUPPORT = 'support@example.test';
let support: string;
const createdInSupport: string[] = [];

test.beforeAll(async () => {
  support = await sharedAccountId();
});
test.afterEach(async () => {
  if (createdInSupport.length) await jmap([['Email/set', { accountId: support, destroy: createdInSupport.splice(0) }, 'd']]);
});

interface SharedMail { id: string; subject: string; threadId: string; mailboxIds: Record<string, boolean>; from: { email: string }[] }
const switcher = (page: Page) => page.locator('.account-button');
/** Mail in the shared account with exactly this subject. Searched by `find`, a word of it: the search index does not match a whole "Re: …" subject. */
const supportMail = async (subject: string, find = subject): Promise<SharedMail[]> => {
  const r = await jmap([
    ['Email/query', { accountId: support, filter: { subject: find } }, 'q'],
    ['Email/get', { accountId: support, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'threadId', 'mailboxIds', 'from'] }, 'g'],
  ]);
  return (r.g.list as SharedMail[]).filter((e) => e.subject === subject);
};
/** From bob, so that a reply to it can be delivered (the dev stack has no route to other domains). */
async function deliverToSupport(subject: string) {
  await sendMail({ from: `Bob Example <${BOB}>`, to: [SUPPORT], subject, text: 'Delivered during an e2e run.' });
  const mail = await waitFor(async () => (await supportMail(subject))[0], 15_000, 'mail in the shared inbox');
  createdInSupport.push(mail.id);
  return mail;
}
async function switchTo(page: Page, label: string) {
  await switcher(page).click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${label},`) }).click();
}

test('the switcher lists the shared mailbox, and switching shows its inbox', async ({ page }) => {
  await openInbox(page);
  await expect(switcher(page)).toContainText('You');
  await switchTo(page, 'Support');
  await expect(page).toHaveURL(new RegExp(`/shared/${support}/inbox$`));
  await expect(switcher(page)).toContainText('Support');
  await expect(rows(page).filter({ hasText: "Can't reset my password" })).toBeVisible();
  // Alice's own mail is not here, and neither is her calendar.
  await expect(rows(page).filter({ hasText: 'Q3 planning offsite' })).toHaveCount(0);
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Calendar' })).toHaveCount(0);
  // And back, by the browser's own button.
  await page.goBack();
  await expect(switcher(page)).toContainText('You');
  await expect(rows(page).filter({ hasText: 'Q3 planning offsite' })).toBeVisible();
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Calendar' })).toBeVisible();
});

test('mail arriving in the shared mailbox raises the dot and the tab count without a reload', async ({ page }) => {
  await openInbox(page);
  await waitLive(page);
  await expect(page).toHaveTitle(/Inbox – oinbox$/);
  const before = Number((await page.title()).match(/^\((\d+)\)/)?.[1] ?? 0);
  await deliverToSupport(`Push test ${uniqueTag()}`);
  await expect(page).toHaveTitle(new RegExp(`^\\(${before + 1}\\) `), { timeout: 15_000 });
  await expect(page.locator('.account-dot')).toBeVisible();
  await switcher(page).click();
  await expect(page.getByRole('menuitemradio', { name: /^Support, support@example\.test, \d+ unread$/ })).toBeVisible();
});

test('a reply from the shared mailbox is sent as support@ and filed in its Sent', async ({ page }) => {
  const subject = `Compose test ${uniqueTag()}`;
  const mail = await deliverToSupport(subject);
  await page.goto(`/shared/${support}/inbox/t/${mail.threadId}`);
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply', exact: true }).click();
  const c = inlineComposer(page);
  await typeBody(c, 'Here is a new link.');
  await sendAndWait(page, c);
  const sent = await waitFor(async () => (await supportMail(`Re: ${subject}`, subject)).find((e) => e.from[0]?.email === SUPPORT), 30_000, 'the reply in the shared account');
  createdInSupport.push(sent.id);
  const boxes = (await jmap([['Mailbox/get', { accountId: support, properties: ['role'] }, 'm']])).m.list as { id: string; role: string | null }[];
  expect(sent.mailboxIds[boxes.find((b) => b.role === 'sent')!.id]).toBe(true);
  // Not in alice's own Sent.
  const mine = await jmap([['Email/query', { accountId: await accountId(ALICE), filter: { subject } }, 'q']]);
  expect(mine.q.ids).toEqual([]);
});

test("a reload on a shared address stays in the shared mailbox; an unknown one goes to the user's own", async ({ page }) => {
  await page.goto(`/shared/${support}/inbox`);
  await expect(switcher(page)).toContainText('Support');
  await page.reload();
  await expect(switcher(page)).toContainText('Support');
  await expect(rows(page).filter({ hasText: "Can't reset my password" })).toBeVisible();
  await page.goto('/shared/nosuchaccount/inbox');
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page).not.toHaveURL(/shared/);
  await expect(switcher(page)).toContainText('You');
  await expect(rows(page).first()).toBeVisible();
});

test('a composer left open in one mailbox is still there, with its text, after switching away and back', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Compose' }).click();
  const c = floatingComposer(page);
  await subjectInput(c).fill(`Compose test ${uniqueTag()} half-written`);
  await typeBody(c, 'Do not lose me.');
  await switchTo(page, 'Support');
  await expect(switcher(page)).toContainText('Support');
  await expect(floatingComposer(page)).toHaveCount(0);
  await switcher(page).click();
  await expect(page.getByRole('menuitemradio', { name: /^You, .*draft open$/ })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /^You,/ }).click();
  await expect(subjectInput(floatingComposer(page))).toHaveValue(/half-written$/);
  await expect(bodyEditor(floatingComposer(page))).toContainText('Do not lose me.');
});

test('labelling works in the shared mailbox: the picker knows which mailbox it is in', async ({ page }) => {
  const tag = uniqueTag();
  const mail = await deliverToSupport(`Label test ${tag} shared`);
  await page.goto(`/shared/${support}/inbox/t/${mail.threadId}`);
  await expect(page.locator('article.msg').first()).toBeVisible();
  await page.keyboard.press('l');
  await page.getByPlaceholder('Label as…').fill(tag);
  await expect(page.getByRole('option', { name: `Create '${tag}'` })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.conv-head .chip', { hasText: tag })).toBeVisible();
  const boxes = (await jmap([['Mailbox/get', { accountId: support, properties: ['name'] }, 'm']])).m.list as { id: string; name: string }[];
  const label = boxes.find((b) => b.name === tag);
  expect(label).toBeDefined();
  // The label lives in the shared account; take it away again.
  await jmap([['Mailbox/set', { accountId: support, destroy: [label!.id], onDestroyRemoveEmails: false }, 'x']]).catch(() => undefined);
  await jmap([['Email/set', { accountId: support, update: { [mail.id]: { [`mailboxIds/${label!.id}`]: null } } }, 'u'], ['Mailbox/set', { accountId: support, destroy: [label!.id] }, 'x']]);
});

test('search and the sidebar follow the address inside a shared mailbox', async ({ page }) => {
  await page.goto(`/shared/${support}/inbox`);
  await expect(page.locator('.sidebar .nav-item.active')).toContainText('Inbox');
  const box = page.getByRole('searchbox', { name: 'Search mail' }).or(page.getByLabel('Search mail'));
  await box.fill('password');
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/shared/${support}/search/password$`));
  await expect(rows(page).filter({ hasText: "Can't reset my password" })).toBeVisible();
  await page.reload();
  await expect(box).toHaveValue('password');
  await page.locator('.sidebar').getByRole('link', { name: /^Inbox/ }).click();
  await expect(page).toHaveURL(new RegExp(`/shared/${support}/inbox$`));
  await expect(box).toHaveValue('');
});

test('mail for a shared mailbox the user has not opened still raises a notification', async ({ page }) => {
  await page.addInitScript(() => {
    const shown: unknown[] = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = () => Promise.resolve('granted');
      onclick: (() => void) | null = null;
      constructor(public title: string, options: { body: string; tag: string }) {
        Object.assign(this, options);
        shown.push(this);
      }
    }
    Object.assign(window, { Notification: FakeNotification, __shown: shown });
    localStorage.setItem('oinbox.notify', '1');
    document.hasFocus = () => false;
  });
  // A cold start in alice's own mailbox: nothing remembered, and Support never opened.
  await page.goto('/inbox');
  await page.evaluate(async () => {
    for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
    localStorage.removeItem('oinbox.session');
  });
  await openInbox(page);
  await waitLive(page);
  const subject = `Push test ${uniqueTag()}`;
  const mail = await deliverToSupport(subject);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __shown: { title: string; body: string }[] }).__shown.map((n) => ({ title: n.title, body: n.body }))), { timeout: 15_000 })
    .toEqual([{ title: 'Support: Bob Example', body: subject }]);
  // A click goes to the conversation, in Support.
  await page.evaluate(() => (window as unknown as { __shown: { onclick: () => void }[] }).__shown[0]!.onclick());
  await expect(page).toHaveURL(new RegExp(`/shared/${support}/inbox/t/${mail.threadId}$`));
  await expect(switcher(page)).toContainText('Support');
});

test('after a switch the focus is on the switcher of the mailbox now open', async ({ page }) => {
  await openInbox(page);
  await switcher(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(switcher(page)).toContainText('Support');
  await expect(switcher(page)).toBeFocused();
});

test.describe('a user with no shared mailbox', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('sees no switcher', async ({ page }) => {
    await signInThroughStalwart(page, 'carol@example.test');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.compose-fab')).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
  });
});
