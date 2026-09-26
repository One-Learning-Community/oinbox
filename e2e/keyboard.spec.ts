import { expect, test } from '@playwright/test';
import { deliverToAlice, destroyEmails, mailboxByRole, threadEmails, uniqueTag } from './support/mail';
import { openInbox, rowFor, rows, visibleThreadOrder } from './support/app';

const created: string[] = [];
test.afterEach(async () => {
  await destroyEmails(created.splice(0));
});

test('j then e archives the thread under the cursor; Undo restores it', async ({ page }) => {
  const tag = uniqueTag();
  // Target first, then a newer one so the target sits at index 1 (one "j" down from the top).
  const target = await deliverToAlice({ from: 'Archive Me <archive@partner.test>', subject: `Archive target ${tag}`, text: 'archive me' });
  // receivedAt has 1 s resolution; make sure the two sort deterministically.
  await new Promise((r) => setTimeout(r, 1100));
  const top = await deliverToAlice({ from: 'Keep Me <keep@partner.test>', subject: `Archive neighbour ${tag}`, text: 'keep me' });
  created.push(target.id, top.id);

  await openInbox(page);
  await expect(rowFor(page, top.threadId)).toBeVisible();
  await expect(rowFor(page, target.threadId)).toBeVisible();
  expect((await visibleThreadOrder(page)).slice(0, 2)).toEqual([top.threadId, target.threadId]);

  await page.keyboard.press('j');
  await expect(rowFor(page, target.threadId)).toHaveClass(/\bcursor\b/);
  await page.keyboard.press('e');

  await expect(rowFor(page, target.threadId)).toHaveCount(0);
  await expect(rowFor(page, top.threadId)).toBeVisible();
  const toast = page.locator('.toast', { hasText: 'archived' });
  await expect(toast).toBeVisible();

  const inbox = await mailboxByRole('inbox');
  await expect.poll(async () => (await threadEmails(target.threadId))[0]?.mailboxIds[inbox] ?? false).toBe(false);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(rowFor(page, target.threadId)).toBeVisible();
  await expect.poll(async () => (await threadEmails(target.threadId))[0]?.mailboxIds[inbox] ?? false).toBe(true);
});

test('o opens the cursor thread, u goes back, ? opens the shortcuts dialog', async ({ page }) => {
  await openInbox(page);
  const first = (await visibleThreadOrder(page))[0]!;
  await page.keyboard.press('o');
  await expect(page).toHaveURL(new RegExp(`/inbox/t/${first}$`));
  await expect(page.locator('article.msg').first()).toBeVisible();
  await page.keyboard.press('u');
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(rows(page).first()).toBeVisible();

  await page.keyboard.press('?');
  await expect(page.locator('.dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog')).toBeHidden();
});
