// Labels (mailboxes without a role), arranged and checked straight through JMAP.
import { accountId, ALICE, jmap } from './mail';

export interface LabelInfo {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
}

export async function allMailboxes(user = ALICE): Promise<LabelInfo[]> {
  const r = await jmap([['Mailbox/get', { accountId: await accountId(user), properties: ['name', 'parentId', 'role'] }, 'm']], user);
  return r.m.list as LabelInfo[];
}

export function pathOf(mb: LabelInfo, all: LabelInfo[]): string {
  const parts = [mb.name];
  let parent = all.find((m) => m.id === mb.parentId);
  while (parent) {
    parts.unshift(parent.name);
    const next = parent.parentId;
    parent = all.find((m) => m.id === next);
  }
  return parts.join('/');
}

export async function labelByPath(path: string, user = ALICE): Promise<LabelInfo | undefined> {
  const all = await allMailboxes(user);
  return all.find((m) => pathOf(m, all) === path);
}

/** Create a label and any missing parents. Returns the leaf's id. */
export async function createLabel(path: string, user = ALICE): Promise<string> {
  const acct = await accountId(user);
  const all = await allMailboxes(user);
  let parentId: string | null = null;
  let soFar = '';
  for (const name of path.split('/')) {
    soFar = soFar ? `${soFar}/${name}` : name;
    const existing = all.find((m) => pathOf(m, all) === soFar);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const r = await jmap([['Mailbox/set', { accountId: acct, create: { c: { name, parentId, isSubscribed: true } } }, 's']], user);
    parentId = r.s.created.c.id as string;
  }
  return parentId!;
}

export async function destroyLabel(id: string, user = ALICE): Promise<void> {
  await jmap([['Mailbox/set', { accountId: await accountId(user), destroy: [id], onDestroyRemoveEmails: true }, 'd']], user);
}

/** Destroy every label under a top-level `e2e-…` label, deepest first, with the test mail in it. */
export async function destroyE2eLabels(user = ALICE): Promise<number> {
  const all = await allMailboxes(user);
  const mine = all.filter((m) => !m.role && pathOf(m, all).startsWith('e2e-'));
  const depth = (m: LabelInfo) => pathOf(m, all).split('/').length;
  mine.sort((a, b) => depth(b) - depth(a));
  for (const m of mine) await destroyLabel(m.id, user);
  return mine.length;
}
