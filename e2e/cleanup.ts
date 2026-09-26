// One-off/utility: remove mail left behind by e2e runs (subjects created by the suite).
import { accountId, destroyEmails, jmap } from './support/mail';

export async function cleanupE2eMail(): Promise<number> {
  const acct = await accountId();
  // One query per prefix: Stalwart (with the Meilisearch store) returns nothing for an
  // OR of subject conditions.
  const ids: string[] = [];
  for (const prefix of ['Push test', 'Archive target', 'Archive neighbour']) {
    const r = await jmap([
      ['Email/query', { accountId: acct, filter: { subject: prefix } }, 'q'],
      ['Email/get', { accountId: acct, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g'],
    ]);
    for (const e of r.g.list as { id: string; subject: string }[]) if (e.subject.startsWith(`${prefix} e2e-`)) ids.push(e.id);
  }
  await destroyEmails(ids);
  return ids.length;
}
