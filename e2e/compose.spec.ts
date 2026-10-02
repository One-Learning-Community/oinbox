import { expect, test } from '@playwright/test';
import { emailsBySubject, mailboxByRole, sendMail, threadEmails, waitFor, ALICE, BOB, uniqueTag } from './support/mail';
import { openInbox, rows, waitLive } from './support/app';
import {
  addRecipient,
  bodyEditor,
  composeNew,
  deliveredCopy,
  destroyBySubject,
  emailDetails,
  floatingComposer,
  inlineComposer,
  recipientChips,
  recipientInput,
  saveStatus,
  sendAndWait,
  subjectInput,
  suggestions,
  toast,
  typeBody,
  UNDO_SEND_MS,
} from './support/compose';

// Every message a test creates carries its own subject, so cleanup is by subject in both mailboxes.
const subjects: string[] = [];
const newSubject = () => {
  const s = `Compose test ${uniqueTag()}`;
  subjects.push(s);
  return s;
};
test.afterEach(async () => {
  for (const s of subjects.splice(0)) await destroyBySubject(s);
});

test('a new message reaches bob and lands in alice\'s Sent', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Hello from the composer.' });
  await sendAndWait(page, c);
  await expect(c).toHaveCount(0);

  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  expect(received.from?.[0]?.email).toBe(ALICE);
  const details = await emailDetails(received.id, BOB);
  expect(details.to?.map((a) => a.email)).toEqual([BOB]);
  expect(details.preview).toContain('Hello from the composer.');

  // Alice keeps exactly one copy: in Sent, no longer a draft.
  const sent = await deliveredCopy(subject, ALICE, await mailboxByRole('sent'));
  const mine = await emailsBySubject(subject);
  expect(mine.map((e) => e.id)).toEqual([sent.id]);
  expect(sent.mailboxIds[await mailboxByRole('drafts')]).toBeFalsy();
});

test('an inline reply joins the conversation as the newest message and reaches the sender', async ({ page }) => {
  const subject = newSubject();
  const messageId = await sendMail({ from: 'Bob Example <bob@example.test>', to: [ALICE], subject, text: 'Can you confirm?' });
  const original = await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.messageId?.includes(messageId)), 15_000, 'the original');

  await page.goto(`/inbox/t/${original.threadId}`);
  await expect(page.locator('article.msg')).toHaveCount(1);
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply', exact: true }).click();

  const c = inlineComposer(page);
  await expect(c).toBeVisible();
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(recipientChips(c)).toContainText(BOB);
  await typeBody(c, 'Confirmed, see you there.');
  await sendAndWait(page, c);

  // The reply is the second, newest message, shown as sent by "me" and no longer a draft.
  const messages = page.locator('article.msg');
  await expect(messages).toHaveCount(2);
  await expect(messages.last().locator('.from')).toHaveText('me');
  await expect(messages.last().locator('.draft-tag')).toHaveCount(0);

  const thread = await threadEmails(original.threadId);
  expect(thread.map((e) => e.id)).toHaveLength(2);
  expect(thread[1]!.subject).toBe(`Re: ${subject}`);

  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  const details = await emailDetails(received.id, BOB);
  expect(details.inReplyTo).toEqual([messageId]);
  expect(details.preview).toContain('Confirmed, see you there.');
});

test('Undo late in the send window reopens the draft and nothing is delivered; Discard deletes it', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Not ready to go yet.' });

  await c.getByRole('button', { name: 'Send', exact: true }).click();
  const sending = toast(page, 'Sending…');
  await expect(sending).toBeVisible();
  await expect(c).toHaveCount(0);
  // Undo must stay on offer for the whole window, so take it in the last second.
  await page.waitForTimeout(UNDO_SEND_MS - 1000);
  await sending.getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Sending undone.')).toBeVisible();

  // The composer is back with what was written.
  const reopened = floatingComposer(page);
  await expect(reopened).toBeVisible();
  await expect(subjectInput(reopened)).toHaveValue(subject);
  await expect(recipientChips(reopened)).toContainText(BOB);
  await expect(bodyEditor(reopened)).toContainText('Not ready to go yet.');

  // Past the window: still a draft on alice's side, nothing on bob's.
  await page.waitForTimeout(3000);
  await expect(toast(page, 'Message sent.')).toHaveCount(0);
  expect(await emailsBySubject(subject, BOB)).toEqual([]);
  const mine = await emailsBySubject(subject);
  expect(mine).toHaveLength(1);
  expect(mine[0]!.keywords.$draft).toBe(true);

  await reopened.getByRole('button', { name: 'Discard draft' }).click();
  const dialog = page.getByRole('dialog', { name: /discard/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard' }).click();
  await expect(reopened).toHaveCount(0);
  await expect.poll(async () => (await emailsBySubject(subject)).length).toBe(0);
});

test('a draft autosaves and reopens from Drafts after a reload', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Half-written thought.' });
  await expect(saveStatus(c)).toHaveText('Draft saved');

  await page.goto('/drafts');
  await expect(floatingComposer(page)).toHaveCount(0);
  const row = rows(page).filter({ has: page.locator('.subject', { hasText: subject }) });
  await expect(row).toBeVisible();
  await row.click();

  const reopened = floatingComposer(page);
  await expect(reopened).toBeVisible();
  await expect(page).toHaveURL(/\/drafts$/);
  await expect(subjectInput(reopened)).toHaveValue(subject);
  await expect(recipientChips(reopened)).toContainText(BOB);
  await expect(bodyEditor(reopened)).toContainText('Half-written thought.');
});

test('an attached file is uploaded, sent, and arrives intact', async ({ page }) => {
  const subject = newSubject();
  const content = `attachment body ${uniqueTag()}\n`;
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'File attached.' });
  await c.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
  await expect(c.locator('.compose-attachments .attachment', { hasText: 'notes.txt' })).toBeVisible();
  await expect(c.locator('.compose-attachments')).not.toContainText('Uploading');
  await sendAndWait(page, c);

  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  const { attachments } = await emailDetails(received.id, BOB);
  expect(attachments.map((a) => ({ name: a.name, type: a.type, size: a.size }))).toEqual([
    { name: 'notes.txt', type: 'text/plain', size: Buffer.byteLength(content) },
  ]);
});

test('c opens the composer, shortcut keys typed into it stay text, Ctrl+Enter sends', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  await waitLive(page);
  await page.keyboard.press('c');
  const c = floatingComposer(page);
  await expect(c).toBeVisible();

  await addRecipient(c, BOB);
  await subjectInput(c).fill(subject);
  // j/x/e/#/! would move the cursor, select, archive, delete and report spam from the list.
  await typeBody(c, 'jxe#!');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rows(page).locator('.row-check input:checked')).toHaveCount(0);
  await expect(page).toHaveURL(/\/inbox$/);

  await page.keyboard.press('Control+Enter');
  const sending = toast(page, 'Sending…');
  await expect(sending).toBeVisible();
  await expect(c).toHaveCount(0);
  // Undo rather than wait out the window; delivery is covered above.
  await sending.getByRole('button', { name: 'Undo' }).click();
  await expect(floatingComposer(page)).toBeVisible();
});

/** A floating composer with only the subject filled in. */
async function openComposer(page: import('@playwright/test').Page, subject: string) {
  await openInbox(page);
  await page.getByRole('button', { name: 'Compose' }).click();
  const c = floatingComposer(page);
  await expect(c).toBeVisible();
  await subjectInput(c).fill(subject);
  return c;
}

test('typing part of a name suggests a correspondent; Enter adds them and the message arrives', async ({ page }) => {
  const subject = newSubject();
  const c = await openComposer(page, subject);
  const to = recipientInput(c);
  await to.pressSequentially('bo');
  const bob = suggestions(c).filter({ hasText: BOB });
  await expect(bob).toBeVisible();
  await expect(bob).toContainText('Bob Example');
  // Alice has written to Bob, so he outranks "CI Bot", who has only written to her.
  await expect(suggestions(c).first()).toContainText(BOB);

  await to.press('Enter');
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(recipientChips(c)).toContainText(`Bob Example <${BOB}>`);
  await expect(to).toHaveValue('');
  await expect(suggestions(c)).toHaveCount(0);

  await typeBody(c, 'Picked from the list.');
  await sendAndWait(page, c);
  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  expect((await emailDetails(received.id, BOB)).to).toEqual([{ name: 'Bob Example', email: BOB }]);
});

test('people alice has written to rank first; ArrowDown and Enter pick the second; a chosen person is not offered again', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  const to = recipientInput(c);
  await to.pressSequentially('partner');
  // The seed has five people at partner.test; alice has written to Carol and Dave only.
  await expect(suggestions(c)).toHaveCount(5);
  const listed = () => suggestions(c).locator('.rcpt-option').evaluateAll((els) => els.map((el) => el.getAttribute('data-email')!));
  // Poll: senders are known as soon as the inbox has loaded, the Sent scan lands a moment later.
  await expect.poll(async () => (await listed()).slice(0, 2).sort()).toEqual(['carol@partner.test', 'dave@partner.test']);
  const order = await listed();
  expect(order.slice(2).sort()).toEqual(['frank@partner.test', 'grace@partner.test', 'heidi@partner.test']);

  await to.press('ArrowDown');
  await to.press('Enter');
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(recipientChips(c)).toContainText(order[1]!);

  await c.getByRole('button', { name: 'Cc/Bcc' }).click();
  const cc = recipientInput(c, 'Cc');
  await cc.pressSequentially('partner');
  await expect(suggestions(c)).toHaveCount(4);
  expect(await listed()).not.toContain(order[1]);
});

test('Tab picks the highlighted suggestion; Escape closes the list first and the composer second', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  const to = recipientInput(c);
  await to.pressSequentially('bo');
  // Bob leads only once the Sent scan has landed; before that "CI Bot" (most recent sender) does.
  await expect(suggestions(c).first()).toContainText(BOB);
  await to.press('Tab');
  await expect(recipientChips(c)).toContainText(BOB);
  await expect(to).toBeFocused();
  await expect(to).toHaveValue('');

  await to.pressSequentially('car');
  await expect(suggestions(c).filter({ hasText: 'carol@partner.test' })).toBeVisible();
  await to.press('Escape');
  await expect(suggestions(c)).toHaveCount(0);
  await expect(c).toBeVisible();
  await expect(to).toHaveValue('car');

  await to.press('Escape');
  await expect(c).toHaveCount(0);
});

test('someone alice just wrote to is suggested straight away', async ({ page }) => {
  // Stalwart delivers bob+anything@ to Bob, so this is a brand-new address that still arrives.
  const tag = uniqueTag('plus').replace(/[^a-z0-9]/g, '');
  const address = `bob+${tag}@example.test`;
  const first = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: address, subject: first, body: 'First contact.' });
  await sendAndWait(page, c);
  await deliveredCopy(first, BOB, await mailboxByRole('inbox', BOB));

  // The Sent scan ran once at page load, before this send: only recording the send can know the address.
  const again = await openComposer(page, newSubject());
  await recipientInput(again).pressSequentially(tag);
  await expect(suggestions(again)).toHaveCount(1);
  await expect(suggestions(again)).toContainText(address);
});

test('free text still works: a comma commits, a pasted list adds everyone, Backspace removes the last, leaving the field commits', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  const to = recipientInput(c);
  await to.pressSequentially('zed@nowhere.test,');
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(recipientChips(c)).toContainText('zed@nowhere.test');
  await expect(to).toHaveValue('');

  // An address the field already holds is not added twice, and leaves no list for the emptied input.
  await to.pressSequentially('zed@nowhere.test,');
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(to).toHaveValue('');
  await expect(suggestions(c)).toHaveCount(0);

  await to.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, 'Ann Lee <ann@nowhere.test>; "Roe, Sam" <sam@nowhere.test>');
  await expect(recipientChips(c)).toHaveCount(3);
  // A name with a comma stays one person.
  await expect(recipientChips(c).nth(2)).toContainText('Roe, Sam <sam@nowhere.test>');

  await to.press('Backspace');
  await expect(recipientChips(c)).toHaveCount(2);

  await to.pressSequentially('yan@nowhere.test');
  // Leave the field without touching the list, which now offers the typed address and covers the row below.
  await c.locator('.composer-title span').click();
  await expect(recipientChips(c)).toHaveCount(3);
  await expect(recipientChips(c).nth(2)).toContainText('yan@nowhere.test');
});

test('a full address typed by hand is kept, even when it is the start of a known one', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  const to = recipientInput(c);
  await to.pressSequentially('bob@example.te');
  // What was typed is offered first; the known bob@example.test comes second.
  await expect(suggestions(c).nth(1).locator('.rcpt-option')).toHaveAttribute('data-email', BOB);
  await expect(suggestions(c).first().locator('.rcpt-option')).toHaveAttribute('data-email', 'bob@example.te');
  await to.press('Enter');
  await expect(recipientChips(c)).toHaveCount(1);
  await expect(recipientChips(c).locator('.rcpt-chip-label')).toHaveText('bob@example.te');
});

test('Ctrl+Enter with a suggestion highlighted adds the person without sending; the next one sends', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  await recipientInput(c).pressSequentially('bo');
  await expect(suggestions(c).first()).toContainText(BOB);
  await page.keyboard.press('Control+Enter');
  await expect(recipientChips(c)).toContainText(BOB);
  await page.waitForTimeout(500);
  await expect(toast(page, 'Sending…')).toHaveCount(0);
  await expect(c).toBeVisible();

  await page.keyboard.press('Control+Enter');
  const sending = toast(page, 'Sending…');
  await expect(sending).toBeVisible();
  await sending.getByRole('button', { name: 'Undo' }).click();
  await expect(floatingComposer(page)).toBeVisible();
});

test('a recipient field fills its row with chips and input on one line, and announces a list only while it shows one', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  const to = recipientInput(c);
  await to.focus();
  await expect(to).toHaveAttribute('aria-expanded', 'false');
  await addRecipient(c, BOB);
  await expect(to).toHaveAttribute('aria-expanded', 'false');

  const chip = (await recipientChips(c).first().boundingBox())!;
  const input = (await to.boundingBox())!;
  const row = (await c.getByRole('group', { name: 'To', exact: true }).boundingBox())!;
  // One line: the input starts right of the chip and overlaps it vertically.
  expect(input.x).toBeGreaterThan(chip.x + chip.width - 1);
  expect(input.y).toBeLessThan(chip.y + chip.height);
  expect(input.y + input.height).toBeGreaterThan(chip.y);
  // The input takes what the chip leaves of the row.
  expect(input.x + input.width).toBeGreaterThan(row.x + row.width - 2);

  await to.pressSequentially('car');
  await expect(suggestions(c).filter({ hasText: 'carol@partner.test' })).toBeVisible();
  await expect(to).toHaveAttribute('aria-expanded', 'true');
  // The list is as wide as the field.
  const list = (await c.getByRole('listbox').boundingBox())!;
  expect(Math.abs(list.width - row.width)).toBeLessThan(2);
});

test('removing a recipient from the keyboard keeps focus in the field', async ({ page }) => {
  const c = await openComposer(page, newSubject());
  await addRecipient(c, BOB);
  await c.getByRole('button', { name: /^Remove / }).focus();
  await page.keyboard.press('Enter');
  await expect(recipientChips(c)).toHaveCount(0);
  await expect(recipientInput(c)).toBeFocused();
});

