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
    for (const prefix of ['Push test', 'Archive target', 'Archive neighbour', 'Compose test']) {
      const r = await jmap(
        [
          ['Email/query', { accountId: acct, filter: { subject: prefix } }, 'q'],
          ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g'],
        ],
        user,
      );
      for (const e of r.g.list as { id: string; subject: string }[]) if (e.subject.includes(`${prefix} e2e-`)) ids.push(e.id);
    }
    await destroyEmails(ids, user);
    removed += ids.length;
  }
  return removed;
}
