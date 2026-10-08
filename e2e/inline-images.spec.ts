import { expect, test, type Locator } from '@playwright/test';
import { ALICE, BOB, emailsBySubject, mailboxByRole, sendMail, uniqueTag, waitFor } from './support/mail';
import { openInbox, rows } from './support/app';
import {
  addRecipient, bodyEditor, composeNew, deliveredCopy, destroyBySubject, floatingComposer, inlineComposer, inlineImageMail, messageParts,
  PNG, PNG_BASE64, saveStatus, sendAndWait, typeBody,
} from './support/compose';

const subjects: string[] = [];
const newSubject = () => {
  const s = `Inline image test ${uniqueTag()}`;
  subjects.push(s);
  return s;
};
test.afterEach(async () => {
  for (const s of subjects.splice(0)) await destroyBySubject(s);
});

const editorImages = (c: Locator) => bodyEditor(c).locator('img');
const loaded = (img: Locator) => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
const insertImage = (c: Locator, name = 'chart.png') =>
  c.locator('.compose-format input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: PNG });
/** The image part of a message that the HTML shows in place. */
const inlineLeaf = (parts: Awaited<ReturnType<typeof messageParts>>) => parts.leaves.find((l) => l.type === 'image/png' && l.cid);

const GAP_PASTE = 'rozie TipTap leaves a pasted image selected, so typing replaces it: docs/rozie-feedback.md, "paste and drop leave the image selected"';
const GAP_DROP = 'rozie TipTap leaves a dropped image selected, so typing replaces it: docs/rozie-feedback.md, "paste and drop leave the image selected"';
const pasteImage = (target: Locator) =>
  target.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG_BASE64);
/** Both events on `target`, with files made in the page; a drop on the text lands at the middle of its box. */
const dropFiles = (target: Locator, at: 'centre' | 'none', files: { name: string; type: string }[]) =>
  target.evaluate((el, [b64, where, list]) => {
    const bytes = Uint8Array.from(atob(b64 as string), (ch) => ch.charCodeAt(0));
    const data = new DataTransfer();
    for (const f of list as { name: string; type: string }[]) data.items.add(new File([bytes], f.name, { type: f.type }));
    const box = el.getBoundingClientRect();
    const pos = where === 'centre' ? { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 } : {};
    for (const type of ['dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, ...pos }));
    }
  }, [PNG_BASE64, at, files] as const);
const dropImage = (target: Locator, at: 'centre' | 'none') => dropFiles(target, at, [{ name: 'dropped.png', type: 'image/png' }]);

test('an image put between two paragraphs is sent inline and arrives in place', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Before' });
  await bodyEditor(c).press('Enter');
  await bodyEditor(c).pressSequentially('After');
  // Back to the end of the first paragraph: the image goes after it.
  await bodyEditor(c).press('ArrowUp');
  await bodyEditor(c).press('End');
  await insertImage(c);

  await expect(editorImages(c)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(c))).toBe(true);
  await expect(c.locator('.compose-attachments')).toHaveCount(0);

  // Inserting must not reset the editor: the caret is still where it was, not at the start of the document.
  await bodyEditor(c).pressSequentially(' mark');
  await expect(bodyEditor(c)).toContainText('mark');
  const order = await bodyEditor(c).evaluate((el) => {
    const html = el.innerHTML;
    return { before: html.indexOf('Before'), img: html.indexOf('<img'), after: html.indexOf('After'), text: el.textContent ?? '' };
  });
  expect(order.before).toBeGreaterThanOrEqual(0);
  expect(order.img).toBeGreaterThan(order.before);
  expect(order.after).toBeGreaterThan(order.img);
  expect(order.text.trimStart().startsWith('Before')).toBe(true);
  await sendAndWait(page, c);

  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  const parts = await messageParts(received.id, BOB);
  const image = inlineLeaf(parts)!;
  expect(image).toMatchObject({ name: 'chart.png', disposition: 'inline' });
  expect(image.within).toContain('multipart/related');
  expect(parts.leaves.filter((l) => l.disposition === 'attachment')).toEqual([]);
  const at = (needle: string) => parts.html.indexOf(needle);
  expect(at('Before')).toBeGreaterThanOrEqual(0);
  expect(at(`cid:${image.cid}`)).toBeGreaterThan(at('Before'));
  expect(at('After')).toBeGreaterThan(at(`cid:${image.cid}`));
  expect(parts.html).toContain('mark');
});

test('a pasted image goes into the text, not the attachments', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'building a paste with a file needs Chromium\'s ClipboardEvent');
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Pasted below.' });
  await pasteImage(bodyEditor(c));
  await expect(editorImages(c)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(c))).toBe(true);
  await expect(c.locator('.compose-attachments')).toHaveCount(0);
  await expect(saveStatus(c)).toHaveText('Draft saved');
});

// Expected to fail until rozie's TipTap is fixed; it fails loudly when it starts to pass.
test('text typed right after a pasted image does not replace it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'building a paste with a file needs Chromium\'s ClipboardEvent');
  test.fail(true, GAP_PASTE);
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Pasted below.' });
  await pasteImage(bodyEditor(c));
  await expect(editorImages(c)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(c))).toBe(true);
  await page.keyboard.type(' pmark');
  await expect(bodyEditor(c)).toContainText('pmark');
  await expect(editorImages(c)).toHaveCount(1);
});

test('two images chosen with the toolbar both go into the text, in order', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Two pictures.' });
  await c.locator('.compose-format input[type=file]').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: PNG },
    { name: 'second.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await expect(editorImages(c)).toHaveCount(2);
  await expect(c.locator('.compose-attachments')).toHaveCount(0);
  // The images carry their file names as alt text; document order tells the order they were inserted in.
  await expect.poll(() => editorImages(c).evaluateAll((els) => els.map((el) => el.getAttribute('alt')))).toEqual(['first.png', 'second.png']);
  // The caret is after the last image: typing adds text and replaces nothing.
  await page.keyboard.type(' marker');
  await expect(bodyEditor(c)).toContainText('marker');
  await expect(editorImages(c)).toHaveCount(2);
});

test('a draft with an image reopens with it, saves again twice, and sends it', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Draft with a picture.' });
  await insertImage(c);
  await expect(editorImages(c)).toHaveCount(1);
  await expect(saveStatus(c)).toHaveText('Draft saved');

  await page.goto('/drafts');
  await expect(floatingComposer(page)).toHaveCount(0);
  await rows(page).filter({ has: page.locator('.subject', { hasText: subject }) }).click();
  const reopened = floatingComposer(page);
  await expect(editorImages(reopened)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(reopened))).toBe(true);
  await expect(reopened.locator('.compose-attachments')).toHaveCount(0);

  // Two more saves: each replaces the stored version, and its blob ids with it.
  for (const word of ['first', 'second']) {
    // Into the text, not onto the image: typing over a selected image would replace it.
    await bodyEditor(reopened).locator('p', { hasText: 'Draft with a picture.' }).click();
    await bodyEditor(reopened).press('End');
    await bodyEditor(reopened).pressSequentially(` ${word}`);
    await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.preview?.includes(word)), 15_000, `the draft saved with "${word}"`);
    await expect(saveStatus(reopened)).toHaveText('Draft saved');
  }
  expect(await emailsBySubject(subject)).toHaveLength(1);
  await sendAndWait(page, reopened);

  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  expect(inlineLeaf(await messageParts(received.id, BOB))).toMatchObject({ name: 'chart.png', disposition: 'inline' });
});

test('a reply keeps the original\'s inline image in the quote', async ({ page }) => {
  const subject = newSubject();
  const cid = `${uniqueTag('img')}@e2e.test`;
  const messageId = await sendMail({ from: 'Bob Example <bob@example.test>', to: [ALICE], subject, text: '', mime: inlineImageMail(cid) });
  const original = await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.messageId?.includes(messageId)), 15_000, 'the original');

  await page.goto(`/inbox/t/${original.threadId}`);
  await expect(page.locator('article.msg')).toHaveCount(1);
  // The reader shows it first.
  await expect.poll(() => loaded(page.frameLocator('article.msg iframe').locator('img'))).toBe(true);
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply', exact: true }).click();
  const c = inlineComposer(page);
  await typeBody(c, 'Thanks for the chart.');
  await sendAndWait(page, c);

  const reply = await waitFor(
    async () => (await emailsBySubject(subject, BOB)).find((e) => e.from?.[0]?.email === ALICE),
    20_000,
    'the reply in bob\'s mailbox',
  );
  const parts = await messageParts(reply.id, BOB);
  expect(inlineLeaf(parts)).toMatchObject({ cid, disposition: 'inline' });
  expect(parts.html).toContain(`cid:${cid}`);
  expect(parts.leaves.filter((l) => l.disposition === 'attachment')).toEqual([]);
});

test('a forward carries the inline image and the attachment', async ({ page }) => {
  const subject = newSubject();
  const cid = `${uniqueTag('img')}@e2e.test`;
  const messageId = await sendMail({ from: 'Bob Example <bob@example.test>', to: [ALICE], subject, text: '', mime: inlineImageMail(cid, 'notes for the chart') });
  const original = await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.messageId?.includes(messageId)), 15_000, 'the original');

  await page.goto(`/inbox/t/${original.threadId}`);
  await expect(page.locator('article.msg')).toHaveCount(1);
  await page.locator('.reply-bar').getByRole('button', { name: 'Forward', exact: true }).click();
  const c = inlineComposer(page);
  await expect(c.locator('.compose-attachments .attachment', { hasText: 'notes.txt' })).toBeVisible();
  await expect(c.locator('.compose-attachments .attachment')).toHaveCount(1);
  await addRecipient(c, BOB);
  await typeBody(c, 'FYI');
  await sendAndWait(page, c);

  const forwarded = await waitFor(
    async () => (await emailsBySubject(subject, BOB)).find((e) => e.from?.[0]?.email === ALICE),
    20_000,
    'the forward in bob\'s mailbox',
  );
  const parts = await messageParts(forwarded.id, BOB);
  expect(inlineLeaf(parts)).toMatchObject({ cid, disposition: 'inline' });
  expect(parts.leaves.filter((l) => l.disposition === 'attachment').map((l) => l.name)).toEqual(['notes.txt']);
});

test('an image dropped on the text goes inline; dropped elsewhere on the composer it is attached', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'building a drop with a file needs Chromium\'s DataTransfer');
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Dropped on this.' });

  await dropImage(bodyEditor(c), 'centre');
  await expect(editorImages(c)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(c))).toBe(true);
  await expect(c.locator('.compose-attachments .attachment')).toHaveCount(0);

  await dropImage(c.locator('.composer-actions'), 'none');
  await expect(c.locator('.compose-attachments .attachment')).toHaveCount(1);
  await expect(editorImages(c)).toHaveCount(1);
});

test('files dropped on the text together are all attached, and none goes inline', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'building a drop with a file needs Chromium\'s DataTransfer');
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Dropped on this.' });

  await dropFiles(bodyEditor(c), 'centre', [{ name: 'dropped.png', type: 'image/png' }, { name: 'notes.txt', type: 'text/plain' }]);
  await expect(c.locator('.compose-attachments .attachment')).toHaveCount(2);
  await expect(editorImages(c)).toHaveCount(0);
});

test('a lone file that is not an image, dropped on the text, is attached', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'building a drop with a file needs Chromium\'s DataTransfer');
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Dropped on this.' });

  await dropFiles(bodyEditor(c), 'centre', [{ name: 'notes.txt', type: 'text/plain' }]);
  await expect(c.locator('.compose-attachments .attachment')).toHaveCount(1);
  await expect(editorImages(c)).toHaveCount(0);
});

// Expected to fail until rozie's TipTap is fixed; it fails loudly when it starts to pass.
test('text typed right after a dropped image does not replace it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'building a drop with a file needs Chromium\'s DataTransfer');
  test.fail(true, GAP_DROP);
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Dropped on this.' });
  await dropImage(bodyEditor(c), 'centre');
  await expect(editorImages(c)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(c))).toBe(true);
  await page.keyboard.type(' dmark');
  await expect(bodyEditor(c)).toContainText('dmark');
  await expect(editorImages(c)).toHaveCount(1);
});
