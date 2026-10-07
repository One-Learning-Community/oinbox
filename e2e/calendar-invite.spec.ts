import { expect, test } from '@playwright/test';
import { settleAfterArrange } from './support/app';
import { bobCancelEvent, bobSeesStatuses, bobUpdateEvent, createInvitedEvent, destroyBobMailAbout, destroyE2eEvents } from './support/calendar';
import { ALICE, BOB, accountId, jmap, waitFor, type EmailInfo } from './support/mail';

const TZ = 'America/New_York';
test.use({ timezoneId: TZ });

/** Alice's newest messages, filtered here: Stalwart's full-text index lags behind delivery. */
async function recentWithSubject(text: string): Promise<EmailInfo[]> {
  const acct = await accountId();
  const r = await jmap([
    ['Email/query', { accountId: acct, sort: [{ property: 'receivedAt', isAscending: false }], limit: 30 }, 'q'],
    ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['threadId', 'subject'] }, 'g'],
  ]);
  return (r.g.list as EmailInfo[]).filter((e) => (e.subject ?? '').includes(text));
}

/** London wall time "YYYY-MM-DDTHH:00:00", `hours` from now (Stalwart doesn't deliver invitations for events in the past). */
function londonIn(hours: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
      .formatToParts(new Date(Date.now() + hours * 3_600_000)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00:00`;
}

let cleanup: (() => Promise<void>) | null = null;
let tag = '';
test.afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  await destroyBobMailAbout(tag);
  await destroyE2eEvents();
});

test('an invitation shows a card; answering reaches the organiser; updates and cancellations show on the card and the grid', async ({ page }) => {
  tag = `E2E invite ${Date.now()}`;
  const made = await createInvitedEvent(tag, londonIn(3), 'Europe/London');
  cleanup = made.cleanup;

  const invitation = await waitFor(async () => (await recentWithSubject(tag)).find((e) => e.subject.includes(tag) && !/Updated|Cancelled/.test(e.subject)), 20_000, 'the invitation email');
  await page.goto(`/inbox/t/${invitation.threadId}`);
  await settleAfterArrange(page, false);

  const card = page.locator(`article.msg[data-email-id="${invitation.id}"] .invite-card`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole('heading', { name: tag })).toBeVisible();
  await expect(card).toContainText('Organizer: ');
  await expect(card).toContainText('(Europe/London)');

  await expect(card).not.toContainText('Updated');

  // Answer: the button lights up, a toast confirms, and bob's copy shows it.
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(page.locator('.toast', { hasText: 'Reply sent to' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'true');
  await waitFor(async () => (await bobSeesStatuses(made.bobEventId))[ALICE] === 'accepted', 15_000, "bob's copy shows accepted");
  expect(BOB).toContain('bob');
  await expect(card).not.toContainText('Updated');

  // Bob moves the meeting: the old email now says so.
  await bobUpdateEvent(made.bobEventId, { start: londonIn(5) });
  await expect(card).toContainText('Updated since this message', { timeout: 20_000 });
  await expect(card).toContainText(londonIn(5).slice(11, 13) + ':00');

  // Bob cancels: Cancelled, no buttons, struck through on the grid.
  await bobCancelEvent(made.bobEventId);
  await expect(card).toContainText('Cancelled', { timeout: 20_000 });
  await expect(card.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'week', exact: true }).click();
  await expect(page.locator('.calendar-view .fc-event.cancelled', { hasText: tag })).toBeVisible({ timeout: 15_000 });
});
