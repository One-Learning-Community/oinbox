import { expect, test, type Page } from '@playwright/test';
import { openInbox, rows, threadList, waitLive } from './support/app';
import { createLabel, destroyE2eLabels, destroyLabel, labelByPath } from './support/labels';
import { deliverToAlice, destroyEmails, mailboxByRole, threadEmails, uniqueTag, updateEmails } from './support/mail';

const created: string[] = [];
test.afterEach(async () => {
  await destroyEmails(created.splice(0));
  await destroyE2eLabels();
});

const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const labelRow = (page: Page, path: string) =>
  page.locator('nav.sidebar .nav-row').filter({ has: page.locator('.name', { hasText: exact(path) }) });
const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text });
const createDialog = (page: Page) => page.getByRole('dialog', { name: 'New label' });
const nameField = (page: Page) => page.getByRole('textbox', { name: 'Label name' });

async function openMenu(page: Page, path: string) {
  await labelRow(page, path).hover();
  await page.getByRole('button', { name: `Options for ${path}`, exact: true }).click();
}

test('"+" creates a label that appears in the sidebar; a double submit creates it once', async ({ page }) => {
  const tag = uniqueTag();
  await openInbox(page);
  await page.getByRole('button', { name: 'New label' }).click();
  await expect(createDialog(page)).toBeVisible();
  await expect(nameField(page)).toBeFocused();
  await nameField(page).fill(tag);
  // Two submits in one tick, as a fast double Enter would produce.
  await nameField(page).evaluate((el) => {
    const form = (el as HTMLInputElement).form!;
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(createDialog(page)).toBeHidden();
  await expect(labelRow(page, tag)).toHaveCount(1);
  await expect(toast(page, `Created '${tag}'.`)).toBeVisible();
  await expect(toast(page, 'already exists')).toHaveCount(0);
  expect(await labelByPath(tag)).toBeDefined();
});

test('a path creates the parent too; a duplicate and an empty segment are refused inline', async ({ page }) => {
  const tag = uniqueTag();
  await openInbox(page);
  await page.getByRole('button', { name: 'New label' }).click();
  await nameField(page).fill(`${tag}/Child`);
  await nameField(page).press('Enter');
  await expect(createDialog(page)).toBeHidden();
  await expect(labelRow(page, tag)).toBeVisible();
  await expect(labelRow(page, `${tag}/Child`)).toBeVisible();
  const child = await labelByPath(`${tag}/Child`);
  expect(child?.parentId).toBe((await labelByPath(tag))?.id);

  await page.getByRole('button', { name: 'New label' }).click();
  await nameField(page).fill(`${tag}/child`);
  await nameField(page).press('Enter');
  const error = createDialog(page).getByRole('alert');
  await expect(error).toHaveText(`A label named '${tag}/Child' already exists.`);
  // Once an error shows, it follows the typing.
  await nameField(page).fill(`${tag}//x`);
  await expect(error).toHaveText("A label name can't be empty.");
  await createDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(createDialog(page)).toBeHidden();
  expect(await labelByPath(`${tag}/x`)).toBeUndefined();
});

test('renaming the label being viewed changes the title and sidebar, not the URL', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(tag);
  await page.goto(`/label/${id}`);
  await expect(threadList(page)).toHaveAttribute('aria-label', tag);

  await openMenu(page, tag);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename label' });
  await expect(nameField(page)).toHaveValue(tag);
  await expect(nameField(page)).toBeFocused();
  await nameField(page).fill(`${tag}-renamed`);
  await nameField(page).press('Enter');

  await expect(dialog).toBeHidden();
  await expect(threadList(page)).toHaveAttribute('aria-label', `${tag}-renamed`);
  await expect(labelRow(page, `${tag}-renamed`)).toBeVisible();
  await expect(labelRow(page, tag)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/label/${id}$`));
  expect((await labelByPath(`${tag}-renamed`))?.id).toBe(id);
});

test('renaming to another parent moves the label', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(`${tag}/Acme`);
  await openInbox(page);
  await expect(labelRow(page, `${tag}/Acme`)).toBeVisible();

  await openMenu(page, `${tag}/Acme`);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await nameField(page).fill(`${tag}-b/Acme`);
  await nameField(page).press('Enter');

  await expect(labelRow(page, `${tag}-b/Acme`)).toBeVisible();
  await expect(labelRow(page, `${tag}-b`)).toBeVisible();
  await expect(labelRow(page, `${tag}/Acme`)).toHaveCount(0);
  await expect(labelRow(page, tag)).toBeVisible();
  expect((await labelByPath(`${tag}-b/Acme`))?.id).toBe(id);
});

test('deleting a label keeps its mail: shared mail loses the label, mail only there moves to Archive', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(tag);
  const inbox = await mailboxByRole('inbox');
  const both = await deliverToAlice({ from: 'Both <both@partner.test>', subject: `Label test ${tag} both`, text: 'in the inbox and the label' });
  const only = await deliverToAlice({ from: 'Only <only@partner.test>', subject: `Label test ${tag} only`, text: 'only in the label' });
  created.push(both.id, only.id);
  await updateEmails({ [both.id]: { [`mailboxIds/${id}`]: true }, [only.id]: { mailboxIds: { [id]: true } } });

  await page.goto(`/label/${id}`);
  await expect(rows(page)).toHaveCount(2);
  await openMenu(page, tag);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete '${tag}'?` });
  await expect(dialog).toContainText('Its 2 conversations stay in your mail. 1 that is only in this label moves to Archive.');
  await dialog.getByRole('button', { name: 'Delete' }).click();

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(toast(page, `Deleted '${tag}'.`)).toBeVisible();
  await expect(toast(page, 'no longer exists')).toHaveCount(0);
  await expect(labelRow(page, tag)).toHaveCount(0);
  expect(await labelByPath(tag)).toBeUndefined();
  const archive = await mailboxByRole('archive');
  expect((await threadEmails(both.threadId))[0]!.mailboxIds).toEqual({ [inbox]: true });
  expect((await threadEmails(only.threadId))[0]!.mailboxIds).toEqual({ [archive]: true });
});

test('a label with a sub-label cannot be deleted; the menu works from the keyboard', async ({ page }) => {
  const tag = uniqueTag();
  await createLabel(`${tag}/Child`);
  await openInbox(page);
  await expect(labelRow(page, `${tag}/Child`)).toBeVisible();

  await openMenu(page, tag);
  const rename = page.getByRole('menuitem', { name: 'Rename' });
  const del = page.getByRole('menuitem', { name: 'Delete (has 1 sub-label)' });
  await expect(rename).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(del).toBeFocused();
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(del).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Options for ${tag}`, exact: true })).toBeFocused();
  expect(await labelByPath(tag)).toBeDefined();
});

test('a label deleted by another client while it is being viewed sends the view to the Inbox', async ({ page }) => {
  const tag = uniqueTag();
  const id = await createLabel(tag);
  await page.goto(`/label/${id}`);
  await expect(threadList(page)).toHaveAttribute('aria-label', tag);
  await waitLive(page);

  await destroyLabel(id);
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(toast(page, 'That label no longer exists.')).toBeVisible();
  await expect(labelRow(page, tag)).toHaveCount(0);

  // A stale link to it lands on the Inbox too.
  await page.goto(`/label/${id}`);
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(rows(page).first()).toBeVisible();
});
