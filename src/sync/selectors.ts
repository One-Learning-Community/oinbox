import type { Id, Mailbox } from '../jmap/types';
import { formatParticipants, type Participant } from '../mail/participants';
import { parseSearch } from '../mail/search';
import { DEFAULT_SORT, type EmailRec, type MailState, type QuerySpec } from './engine';

const ROLE_ORDER = ['inbox', 'flagged', 'drafts', 'sent', 'archive', 'junk', 'trash'];

export interface View {
  slug: string;
  title: string;
  spec: QuerySpec;
  /** The mailbox this view lists, if it is a mailbox. */
  mailboxId: Id | null;
  role: string | null;
  /** For search views: the raw query and any operator problems. */
  search?: { query: string; errors: string[] };
}

/** URL slug for a mailbox: its role, or its id for custom mailboxes. */
export function mailboxSlug(mb: Mailbox): string {
  return mb.role && mb.role !== 'flagged' ? mb.role : `label/${mb.id}`;
}

export function searchSlug(query: string): string {
  return `search/${encodeURIComponent(query.trim())}`;
}

export function resolveView(slug: string, mailboxes: Record<Id, Mailbox>, now = new Date()): View | null {
  if (slug.startsWith('search/')) {
    const query = decodeURIComponent(slug.slice(7));
    const all = Object.values(mailboxes);
    const parsed = parseSearch(query, {
      mailboxIdByRole: (role) => all.find((m) => m.role === role)?.id,
      mailboxIdByName: (name) => {
        const lower = name.toLowerCase();
        return all.find((m) => m.name.toLowerCase() === lower || labelPath(m, mailboxes).toLowerCase() === lower)?.id;
      },
      now,
    });
    const inMailbox = parsed.filter && 'inMailbox' in parsed.filter ? (parsed.filter.inMailbox ?? null) : null;
    return {
      slug: searchSlug(query),
      title: query,
      spec: { filter: parsed.filter, sort: DEFAULT_SORT, collapseThreads: true, snippets: parsed.textTerms.length > 0 },
      mailboxId: inMailbox,
      role: null,
      search: { query, errors: parsed.errors },
    };
  }
  if (slug === 'starred') {
    return {
      slug,
      title: 'Starred',
      spec: { filter: { hasKeyword: '$flagged' }, sort: DEFAULT_SORT, collapseThreads: true },
      mailboxId: null,
      role: 'flagged',
    };
  }
  const all = Object.values(mailboxes);
  const mb = slug.startsWith('label/') ? mailboxes[slug.slice(6)] : all.find((m) => m.role === slug);
  if (!mb) return null;
  return {
    slug,
    title: mb.role === 'inbox' ? 'Inbox' : mb.name,
    spec: { filter: { inMailbox: mb.id }, sort: DEFAULT_SORT, collapseThreads: true },
    mailboxId: mb.id,
    role: mb.role,
  };
}

/** Mailboxes in Gmail sidebar order: system roles first, then custom ones by sortOrder/name. */
export function sidebarMailboxes(mailboxes: Record<Id, Mailbox>): { system: Mailbox[]; labels: Mailbox[] } {
  const all = Object.values(mailboxes);
  const system = all
    .filter((m) => m.role && ROLE_ORDER.includes(m.role))
    .sort((a, b) => ROLE_ORDER.indexOf(a.role!) - ROLE_ORDER.indexOf(b.role!));
  const labels = all
    .filter((m) => !m.role || !ROLE_ORDER.includes(m.role))
    .sort((a, b) => a.sortOrder - b.sortOrder || labelPath(a, mailboxes).localeCompare(labelPath(b, mailboxes)));
  return { system, labels };
}

export function labelPath(mb: Mailbox, mailboxes: Record<Id, Mailbox>): string {
  const parts = [mb.name];
  let p = mb.parentId ? mailboxes[mb.parentId] : undefined;
  for (let depth = 0; p && depth < 10; depth++) {
    parts.unshift(p.name);
    p = p.parentId ? mailboxes[p.parentId] : undefined;
  }
  return parts.join('/');
}

export function hiddenMailboxIds(mailboxes: Record<Id, Mailbox>, viewing: Id | null): Set<Id> {
  const hidden = new Set<Id>();
  for (const m of Object.values(mailboxes)) {
    if ((m.role === 'trash' || m.role === 'junk') && m.id !== viewing) hidden.add(m.id);
  }
  return hidden;
}

/** True if every mailbox the email is in is hidden (Trash/Junk while not viewing them). */
export function isHidden(e: EmailRec, hidden: Set<Id>): boolean {
  const ids = Object.keys(e.mailboxIds ?? {});
  return ids.length > 0 && ids.every((id) => hidden.has(id));
}

export interface ThreadRowData {
  emailId: Id;
  threadId: Id;
  participants: Participant[];
  count: number;
  subject: string;
  preview: string;
  date: string | undefined;
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
  labels: { id: Id; name: string }[];
}

/** Everything a thread-list row shows, computed across all messages in the thread. */
export function threadRow(
  state: Pick<MailState, 'emails' | 'threads' | 'mailboxes'>,
  emailId: Id,
  ctx: { viewing: Id | null; me: Set<string> },
): ThreadRowData | null {
  const rep = state.emails[emailId];
  if (!rep || rep.subject === undefined) return null;
  const thread = rep.threadId ? state.threads[rep.threadId] : undefined;
  const hidden = hiddenMailboxIds(state.mailboxes, ctx.viewing);
  const members = (thread?.emailIds ?? [emailId])
    .map((id) => state.emails[id])
    .filter((e): e is EmailRec => !!e && !isHidden(e, hidden))
    .sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''));
  const list = members.length ? members : [rep];

  const labelIds = new Set<Id>();
  for (const m of list) {
    for (const id of Object.keys(m.mailboxIds ?? {})) {
      const mb = state.mailboxes[id];
      if (!mb || id === ctx.viewing) continue;
      if (!mb.role || mb.role === 'inbox') labelIds.add(id);
    }
  }

  return {
    emailId,
    threadId: rep.threadId!,
    participants: formatParticipants(
      list.map((m) => ({ from: m.from, unread: !m.keywords?.$seen, draft: !!m.keywords?.$draft })),
      ctx.me,
    ),
    count: list.length,
    subject: rep.subject || '(no subject)',
    preview: rep.preview ?? '',
    date: list[list.length - 1]?.receivedAt ?? rep.receivedAt,
    unread: list.some((m) => !m.keywords?.$seen),
    starred: list.some((m) => m.keywords?.$flagged),
    hasAttachment: list.some((m) => m.hasAttachment) || !!rep.hasAttachment,
    labels: [...labelIds].map((id) => ({ id, name: state.mailboxes[id]!.role === 'inbox' ? 'Inbox' : state.mailboxes[id]!.name })),
  };
}
