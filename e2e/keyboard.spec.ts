import { expect, test } from '@playwright/test';
import { deliverToAlice, destroyEmails, mailboxByRole, threadEmails, uniqueTag } from './support/mail';
import { openInbox, rowFor, rows, visibleThreadOrder } from './support/app';

const created: string[] = [];
test.afterEach(async () => {
  await destroyEmails(created.splice(0));
});

test('j then e prompts to confirm archiving the thread under the cursor; Cancel keeps it, Archive removes it', async ({ page }) => {
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

  // Cancel: the thread stays put.
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog', { name: /archive/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(rowFor(page, target.threadId)).toBeVisible();

  // Confirm: it archives.
  await page.keyboard.press('e');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Archive' }).click();

  await expect(rowFor(page, target.threadId)).toHaveCount(0);
  await expect(rowFor(page, top.threadId)).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'archived' })).toBeVisible();

  const inbox = await mailboxByRole('inbox');
  await expect.poll(async () => (await threadEmails(target.threadId))[0]?.mailboxIds[inbox] ?? false).toBe(false);
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
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
