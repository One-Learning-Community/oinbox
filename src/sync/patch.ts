import type { Id } from '../jmap/types';

/** A JMAP Email/set update patch (RFC 8620 §5.3 PatchObject). */
export type EmailPatch = Record<string, unknown>;

export interface MutableEmail {
  id: Id;
  keywords?: Record<string, true>;
  mailboxIds?: Record<Id, true>;
}

const unescapePointer = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');
export const escapePointer = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Apply a patch to the mutable Email properties. Returns new objects; input is untouched. */
export function applyEmailPatch(
  e: MutableEmail,
  patch: EmailPatch,
): { keywords: Record<string, true>; mailboxIds: Record<Id, true> } {
  const out = { keywords: { ...(e.keywords ?? {}) }, mailboxIds: { ...(e.mailboxIds ?? {}) } };
  for (const [path, value] of Object.entries(patch)) {
    const [prop, ...rest] = path.split('/');
    if (prop !== 'keywords' && prop !== 'mailboxIds') continue;
    if (!rest.length) {
      out[prop] = { ...(value as Record<string, true>) };
      continue;
    }
    const key = unescapePointer(rest.join('/'));
    if (value === null) delete out[prop][key];
    else out[prop][key] = true;
  }
  return out;
}

export function keywordPatch(emails: MutableEmail[], keyword: string, on: boolean): Record<Id, EmailPatch> {
  const out: Record<Id, EmailPatch> = {};
  for (const e of emails) {
    if (!!e.keywords?.[keyword] === on) continue;
    out[e.id] = { [`keywords/${escapePointer(keyword)}`]: on ? true : null };
  }
  return out;
}

/**
 * Gmail archive: take the thread out of the Inbox. JMAP has no "All Mail" and an email
 * must stay in at least one mailbox, so emails left with none go to the Archive mailbox.
 */
export function archivePatch(emails: MutableEmail[], inboxId: Id, archiveId: Id): Record<Id, EmailPatch> {
  const out: Record<Id, EmailPatch> = {};
  for (const e of emails) {
    if (!e.mailboxIds?.[inboxId]) continue;
    const others = Object.keys(e.mailboxIds).filter((id) => id !== inboxId);
    out[e.id] = others.length ? { [`mailboxIds/${inboxId}`]: null } : { [`mailboxIds/${inboxId}`]: null, [`mailboxIds/${archiveId}`]: true };
  }
  return out;
}

/** Take a label off emails. The rule is archive's: an email left in no mailbox goes to Archive. */
export const unlabelPatch = archivePatch;

/** True when `mailboxId` is the only mailbox the email is in. */
export function onlyIn(e: MutableEmail, mailboxId: Id): boolean {
  return !!e.mailboxIds?.[mailboxId] && Object.keys(e.mailboxIds).length === 1;
}

/** Move from one mailbox (or none: just add) to another. */
export function movePatch(emails: MutableEmail[], from: Id | null, to: Id): Record<Id, EmailPatch> {
  const out: Record<Id, EmailPatch> = {};
  for (const e of emails) {
    const p: EmailPatch = {};
    if (from && from !== to && e.mailboxIds?.[from]) p[`mailboxIds/${from}`] = null;
    if (!e.mailboxIds?.[to]) p[`mailboxIds/${to}`] = true;
    if (Object.keys(p).length) out[e.id] = p;
  }
  return out;
}

export function trashPatch(emails: MutableEmail[], trashId: Id): Record<Id, EmailPatch> {
  const out: Record<Id, EmailPatch> = {};
  for (const e of emails) out[e.id] = { mailboxIds: { [trashId]: true } };
  return out;
}
