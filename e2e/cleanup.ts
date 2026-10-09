// One-off/utility: remove mail left behind by e2e runs (subjects created by the suite).
import { accountId, destroyEmails, jmap, ALICE, BOB } from './support/mail';

export async function cleanupE2eMail(): Promise<number> {
  let removed = 0;
  // Compose tests also leave mail in bob's mailbox (deliveries) and replies ("Re: Compose test …").
  for (const user of [ALICE, BOB]) {
    const acct = await accountId(user);
    // One query per prefix: Stalwart (with the Meilisearch store) returns nothing for an
    // OR of subject conditions.
    const ids: string[] = [];
    for (const prefix of ['Push test', 'Archive target', 'Archive neighbour', 'Compose test', 'Label test', 'Inline image test']) {
      const r = await jmap(
        [
          ['Email/query', { accountId: acct, filter: { subject: prefix } }, 'q'],
          ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g'],
        ],
        user,
      );
      for (const e of r.g.list as { id: string; subject: string }[]) if (e.subject.includes(`${prefix} e2e-`)) ids.push(e.id);
    }
    // Calendar tests invite the other user, and Stalwart mails "Invitation: E2E 1759…", then "Updated
    // invitation: …" and "Cancelled: …". Enough of them push the seeded threads off the first page.
    const r = await jmap(
      [
        ['Email/query', { accountId: acct, filter: { subject: 'E2E' }, limit: 500 }, 'q'],
        ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g'],
      ],
      user,
    );
    for (const e of r.g.list as { id: string; subject: string }[]) if (/^(Invitation|Updated invitation|Cancelled): E2E (invite )?\d{10,}/.test(e.subject)) ids.push(e.id);
    await destroyEmails([...new Set(ids)], user);
    removed += ids.length;
  }
  return removed;
}
