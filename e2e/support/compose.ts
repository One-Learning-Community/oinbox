import { expect, type Locator, type Page } from '@playwright/test';
import { accountId, destroyEmails, emailsBySubject, jmap, waitFor, ALICE, BOB, type EmailInfo } from './mail';

/** The app's undo-send window (src/app/composer.ts UNDO_SEND_MS). */
export const UNDO_SEND_MS = 10_000;

/** Floating "New Message" windows; inline replies are `.composer.inline` inside the conversation. */
export const floatingComposer = (page: Page) => page.locator('.compose-dock .composer');
export const inlineComposer = (page: Page) => page.locator('.conv .composer.inline');

export const recipientInput = (c: Locator, field: 'To' | 'Cc' | 'Bcc' = 'To') => c.getByRole('textbox', { name: field, exact: true });
export const recipientChips = (c: Locator, field: 'To' | 'Cc' | 'Bcc' = 'To') =>
  c.getByRole('group', { name: field, exact: true }).locator('.rozie-tags-chip');
export const subjectInput = (c: Locator) => c.getByLabel('Subject');
export const bodyEditor = (c: Locator) => c.locator('[contenteditable="true"]');
export const saveStatus = (c: Locator) => c.locator('.compose-status');

export const toast = (page: Page, text: string | RegExp) => page.locator('.toast', { hasText: text });

export async function addRecipient(c: Locator, address: string, field: 'To' | 'Cc' | 'Bcc' = 'To') {
  const input = recipientInput(c, field);
  await input.fill(address);
  await input.press('Enter');
  await expect(recipientChips(c, field).filter({ hasText: address })).toBeVisible();
}

export async function typeBody(c: Locator, text: string) {
  const editor = bodyEditor(c);
  await editor.click();
  await editor.pressSequentially(text);
  await expect(editor).toContainText(text);
}

/** Open a new-message window and fill it in. */
export async function composeNew(page: Page, m: { to: string; subject: string; body: string }): Promise<Locator> {
  await page.getByRole('button', { name: 'Compose' }).click();
  const c = floatingComposer(page);
  await expect(c).toBeVisible();
  await addRecipient(c, m.to);
  await subjectInput(c).fill(m.subject);
  await typeBody(c, m.body);
  return c;
}

/** Click Send and wait out the undo window until the app reports the message sent. */
export async function sendAndWait(page: Page, c: Locator) {
  await c.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(toast(page, 'Sending…')).toBeVisible();
  await expect(toast(page, 'Message sent.')).toBeVisible({ timeout: UNDO_SEND_MS + 10_000 });
}

/** Wait for a delivered (non-draft) copy with this subject in the user's mailbox with `role`. */
export async function deliveredCopy(subject: string, user: string, mailboxId: string): Promise<EmailInfo> {
  return waitFor(
    async () => (await emailsBySubject(subject, user)).find((e) => e.mailboxIds[mailboxId] && !e.keywords?.$draft),
    20_000,
    `"${subject}" in ${user}'s mailbox`,
  );
}

export interface EmailDetails {
  id: string;
  to: { name: string | null; email: string }[] | null;
  inReplyTo: string[] | null;
  preview: string;
  attachments: { name: string | null; type: string; size: number; blobId: string }[];
}

export async function emailDetails(id: string, user = ALICE): Promise<EmailDetails> {
  const r = await jmap(
    [['Email/get', { accountId: await accountId(user), ids: [id], properties: ['to', 'inReplyTo', 'preview', 'attachments'] }, 'g']],
    user,
  );
  return r.g.list[0] as EmailDetails;
}

/** Remove everything a compose test left in either mailbox (drafts, Sent copies, Bob's deliveries). */
export async function destroyBySubject(subject: string) {
  for (const user of [ALICE, BOB]) {
    await destroyEmails((await emailsBySubject(subject, user)).map((e) => e.id), user);
  }
}
