import { batch as solidBatch } from 'solid-js';
import { createStore, produce, type SetStoreFunction } from 'solid-js/store';
import type { BatchResult, JmapClient } from '../jmap/client';
import type { Comparator, Email, EmailFilter, Id, Identity, Mailbox, StateChange, Thread } from '../jmap/types';
import { applyQueryChanges, missingPages, type Slots } from './window';

export const PAGE_SIZE = 50;

/** Properties for a thread-list row's representative email. */
export const LIST_PROPS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'preview', 'receivedAt', 'hasAttachment'];
/** Properties for every other member of a listed thread (participants, counts, unread). */
export const MEMBER_PROPS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'receivedAt'];
/** Everything the conversation view needs. */
export const FULL_PROPS = [
  ...LIST_PROPS,
  'blobId', 'size', 'cc', 'bcc', 'replyTo', 'sentAt', 'messageId', 'inReplyTo', 'references',
  'textBody', 'htmlBody', 'attachments', 'bodyValues',
];
/** The only mutable Email properties (RFC 8621 §4.1). */
const MUTABLE_PROPS = ['keywords', 'mailboxIds'];

export type EmailRec = Partial<Email> & { id: Id };

export interface QuerySpec {
  filter: EmailFilter | null;
  sort: Comparator[];
  collapseThreads: boolean;
}

export interface LiveQuery extends QuerySpec {
  key: string;
  slots: Slots;
  total: number | null;
  queryState: string | null;
  error: string | null;
}

export interface MailState {
  ready: boolean;
  mailboxes: Record<Id, Mailbox>;
  identities: Identity[];
  emails: Record<Id, EmailRec>;
  threads: Record<Id, Thread>;
  /** Emails whose bodies have been fetched. */
  bodies: Record<Id, true>;
  queries: Record<string, LiveQuery>;
  /** Push connection status for the UI. */
  online: boolean;
}

type TypeName = 'Mailbox' | 'Email' | 'Thread';

export interface Snapshot {
  v: 1;
  accountId: Id;
  states: Partial<Record<TypeName, string>>;
  mailboxes: Record<Id, Mailbox>;
  identities: Identity[];
  emails: Record<Id, EmailRec>;
  threads: Record<Id, Thread>;
  queries: Record<string, LiveQuery>;
}

export const DEFAULT_SORT: Comparator[] = [{ property: 'receivedAt', isAscending: false }];

export function queryKey(spec: QuerySpec): string {
  return JSON.stringify([spec.filter, spec.sort, spec.collapseThreads]);
}

/**
 * The client-side mail model: a normalized cache of JMAP records plus live
 * query windows, kept current with /changes and /queryChanges.
 */
export class MailEngine {
  readonly state: MailState;
  private readonly set: SetStoreFunction<MailState>;
  private states: Partial<Record<TypeName, string>> = {};
  private inflightPages = new Map<string, Promise<void>>();
  private inflightThreads = new Map<Id, Promise<void>>();
  private catchUpRunning: Promise<void> | null = null;
  private catchUpAgain = false;
  /** Visible ranges per query, for refetching after cannotCalculateChanges. */
  private ranges = new Map<string, [number, number]>();
  onPersist: ((s: Snapshot) => void) | null = null;

  constructor(private readonly client: JmapClient) {
    const [state, set] = createStore<MailState>({
      ready: false,
      mailboxes: {},
      identities: [],
      emails: {},
      threads: {},
      bodies: {},
      queries: {},
      online: false,
    });
    this.state = state;
    this.set = set;
  }

  get accountId(): Id {
    return this.client.accountId;
  }

  /** Addresses that count as "me" in participant lists. */
  myAddresses(): Set<string> {
    const s = new Set(this.state.identities.map((i) => i.email.toLowerCase()));
    s.add(this.client.session.username.toLowerCase());
    return s;
  }

  mailboxByRole(role: string): Mailbox | undefined {
    return Object.values(this.state.mailboxes).find((m) => m.role === role);
  }

  // ---- Boot ----------------------------------------------------------------

  hydrate(snap: Snapshot): boolean {
    if (snap.v !== 1 || snap.accountId !== this.accountId) return false;
    this.states = { ...snap.states };
    this.set({
      mailboxes: snap.mailboxes,
      identities: snap.identities,
      emails: snap.emails,
      threads: snap.threads,
      queries: snap.queries,
      ready: true,
    });
    return true;
  }

  /** Initial load (cold) or catch-up (after hydrate). */
  async start(): Promise<void> {
    if (this.states.Mailbox) {
      await this.catchUp();
      return;
    }
    const b = this.client.batch();
    const mb = b.call('Mailbox/get', { accountId: this.accountId, ids: null });
    const id = b.call('Identity/get', { accountId: this.accountId, ids: null });
    const res = await this.client.send(b);
    const mailboxes = res.get(mb);
    this.states.Mailbox = mailboxes.state;
    const identities = res.error(id) ? [] : res.get(id).list;
    this.set({ mailboxes: byId(mailboxes.list), identities, ready: true });
  }

  setOnline(online: boolean): void {
    this.set('online', online);
  }

  // ---- Queries -------------------------------------------------------------

  openQuery(spec: QuerySpec): string {
    const key = queryKey(spec);
    if (!this.state.queries[key]) {
      this.set('queries', key, { ...spec, key, slots: [], total: null, queryState: null, error: null });
    }
    return key;
  }

  closeQuery(key: string, keep: (key: string) => boolean): void {
    if (keep(key)) return;
    this.ranges.delete(key);
    this.set('queries', produce((q) => void delete q[key]));
  }

  /** Make sure rows [from, to) of a query are loaded. */
  ensureRange(key: string, from: number, to: number): Promise<void> {
    this.ranges.set(key, [from, to]);
    const q = this.state.queries[key];
    if (!q) return Promise.resolve();
    const pages = q.total === null ? [0] : missingPages(q.slots, from, to, PAGE_SIZE);
    return Promise.all(pages.map((p) => this.fetchPage(key, p))).then(() => undefined);
  }

  private fetchPage(key: string, position: number): Promise<void> {
    const flightKey = `${key}@${position}`;
    const existing = this.inflightPages.get(flightKey);
    if (existing) return existing;
    const p = this.doFetchPage(key, position).finally(() => this.inflightPages.delete(flightKey));
    this.inflightPages.set(flightKey, p);
    return p;
  }

  private async doFetchPage(key: string, position: number): Promise<void> {
    const q = this.state.queries[key];
    if (!q) return;
    const accountId = this.accountId;
    const b = this.client.batch();
    const query = b.call('Email/query', {
      accountId,
      filter: q.filter,
      sort: q.sort,
      collapseThreads: q.collapseThreads,
      position,
      limit: PAGE_SIZE,
      calculateTotal: true,
    });
    const rows = b.call('Email/get', { accountId, '#ids': query.ref('/ids'), properties: LIST_PROPS });
    const threads = b.call('Thread/get', { accountId, '#ids': rows.ref('/list/*/threadId') });
    const members = b.call('Email/get', { accountId, '#ids': threads.ref('/list/*/emailIds'), properties: MEMBER_PROPS });

    let res: BatchResult;
    try {
      res = await this.client.send(b);
    } catch (e) {
      this.set('queries', key, 'error', String(e));
      throw e;
    }
    if (!this.state.queries[key]) return;
    const qr = res.get(query);
    const rowList = res.get(rows);
    const threadList = res.get(threads);
    const memberList = res.get(members);
    this.states.Email ??= rowList.state;
    this.states.Thread ??= threadList.state;

    solidBatch(() => {
      this.mergeEmails(memberList.list);
      this.mergeEmails(rowList.list);
      this.mergeThreads(threadList.list);
      this.set('queries', key, produce((lq) => {
        const total = qr.total ?? Math.max(lq.slots.length, position + qr.ids.length);
        // The list changed since other pages were loaded: drop them; the view will refetch.
        const stale = lq.queryState !== null && lq.queryState !== qr.queryState;
        const slots: Slots = stale ? new Array<Id | null>(total).fill(null) : lq.slots.slice(0, total);
        while (slots.length < total) slots.push(null);
        qr.ids.forEach((id, i) => (slots[position + i] = id));
        lq.slots = slots;
        lq.total = total;
        lq.queryState = qr.queryState;
        lq.error = null;
      }));
    });
    this.persistSoon();
  }

  // ---- Threads -------------------------------------------------------------

  /** Fetch a thread with full message bodies. Deduplicated; resolves immediately if cached. */
  loadThread(threadId: Id): Promise<void> {
    const t = this.state.threads[threadId];
    if (t && t.emailIds.every((id) => this.state.bodies[id])) return Promise.resolve();
    const existing = this.inflightThreads.get(threadId);
    if (existing) return existing;
    const p = this.doLoadThread(threadId).finally(() => this.inflightThreads.delete(threadId));
    this.inflightThreads.set(threadId, p);
    return p;
  }

  private async doLoadThread(threadId: Id): Promise<void> {
    const accountId = this.accountId;
    const b = this.client.batch();
    const th = b.call('Thread/get', { accountId, ids: [threadId] });
    const em = b.call('Email/get', {
      accountId,
      '#ids': th.ref('/list/*/emailIds'),
      properties: FULL_PROPS,
      fetchHTMLBodyValues: true,
      fetchTextBodyValues: true,
      maxBodyValueBytes: 512 * 1024,
    });
    const res = await this.client.send(b);
    const emails = res.get(em).list;
    solidBatch(() => {
      this.mergeThreads(res.get(th).list);
      this.mergeEmails(emails);
      this.set('bodies', produce((bodies) => emails.forEach((e) => (bodies[e.id] = true))));
    });
  }

  // ---- Push ----------------------------------------------------------------

  onStateChange(change: StateChange): void {
    const types = change.changed[this.accountId];
    if (!types) return;
    const stale = (['Mailbox', 'Email', 'Thread'] as const).some((t) => types[t] && types[t] !== this.states[t]);
    if (stale) void this.catchUp();
  }

  /** Bring everything up to date with /changes and /queryChanges. Coalesces concurrent calls. */
  catchUp(): Promise<void> {
    if (this.catchUpRunning) {
      this.catchUpAgain = true;
      return this.catchUpRunning;
    }
    this.catchUpRunning = (async () => {
      try {
        do {
          this.catchUpAgain = false;
          while (await this.catchUpOnce());
        } while (this.catchUpAgain);
      } finally {
        this.catchUpRunning = null;
      }
    })();
    return this.catchUpRunning;
  }

  /** One round of changes. Returns true if the server has more changes to fetch. */
  private async catchUpOnce(): Promise<boolean> {
    const accountId = this.accountId;
    const b = this.client.batch();
    const s = this.states;

    const mb = s.Mailbox ? this.changeCalls(b, 'Mailbox', s.Mailbox, null) : null;
    const em = s.Email ? this.changeCalls(b, 'Email', s.Email, LIST_PROPS) : null;
    const th = s.Thread ? this.changeCalls(b, 'Thread', s.Thread, null) : null;

    const liveQueries = Object.values(this.state.queries).filter((q) => q.queryState);
    const qcs = liveQueries.map((q) => ({
      q,
      call: b.call('Email/queryChanges', {
        accountId,
        filter: q.filter,
        sort: q.sort,
        collapseThreads: q.collapseThreads,
        sinceQueryState: q.queryState!,
        calculateTotal: true,
      }),
    }));
    if (b.size === 0) return false;

    const res = await this.client.send(b);

    // A type-level cannotCalculateChanges means our cache is unusable: start over.
    for (const c of [mb, em, th]) {
      if (c && res.error(c.changes)) {
        await this.resetAll();
        return false;
      }
    }

    const toResetQueries: string[] = [];
    let more = false;
    solidBatch(() => {
      if (mb) {
        const ch = res.get(mb.changes);
        this.mergeMailboxes([...res.get(mb.created).list, ...res.get(mb.updated).list] as unknown as Mailbox[]);
        this.set('mailboxes', produce((m) => ch.destroyed.forEach((id) => delete m[id])));
        this.states.Mailbox = ch.newState;
        more ||= ch.hasMoreChanges;
      }
      if (em) {
        const ch = res.get(em.changes);
        this.mergeEmails(res.get(em.created).list);
        // Updates only matter for emails we hold; others were fetched as partial records.
        this.mergeEmails(res.get(em.updated).list.filter((e) => this.state.emails[e.id]));
        this.set('emails', produce((m) => ch.destroyed.forEach((id) => delete m[id])));
        this.set('bodies', produce((m) => ch.destroyed.forEach((id) => delete m[id])));
        this.states.Email = ch.newState;
        more ||= ch.hasMoreChanges;
      }
      if (th) {
        const ch = res.get(th.changes);
        this.mergeThreads([...res.get(th.created).list, ...res.get(th.updated).list] as unknown as Thread[]);
        this.set('threads', produce((m) => ch.destroyed.forEach((id) => delete m[id])));
        this.states.Thread = ch.newState;
        more ||= ch.hasMoreChanges;
      }
      for (const { q, call } of qcs) {
        if (res.error(call)) {
          toResetQueries.push(q.key);
          continue;
        }
        const r = res.get(call);
        this.set('queries', q.key, produce((lq) => {
          lq.slots = applyQueryChanges(lq.slots, r);
          lq.total = lq.slots.length;
          lq.queryState = r.newQueryState;
        }));
      }
    });

    for (const key of toResetQueries) await this.resetQuery(key);
    await this.fillMissingRows();
    this.persistSoon();
    return more;
  }

  private changeCalls(
    b: ReturnType<JmapClient['batch']>,
    type: TypeName,
    since: string,
    createdProps: string[] | null,
  ) {
    const accountId = this.accountId;
    const changes = b.call(`${type}/changes` as 'Email/changes', { accountId, sinceState: since, maxChanges: 500 });
    const created = b.call(`${type}/get` as 'Email/get', {
      accountId,
      '#ids': changes.ref('/created'),
      ...(createdProps ? { properties: createdProps } : {}),
    });
    const updated = b.call(`${type}/get` as 'Email/get', {
      accountId,
      '#ids': changes.ref('/updated'),
      ...(type === 'Email' ? { properties: ['id', ...MUTABLE_PROPS] } : {}),
    });
    return { changes, created, updated };
  }

  /**
   * After queryChanges, rows may point at emails we only hold as thread members
   * (no subject/preview), or at threads whose members we never fetched.
   */
  private async fillMissingRows(): Promise<void> {
    const needRow = new Set<Id>();
    for (const q of Object.values(this.state.queries)) {
      const range = this.ranges.get(q.key) ?? [0, PAGE_SIZE];
      for (const id of q.slots.slice(Math.max(0, range[0] - PAGE_SIZE), range[1] + PAGE_SIZE)) {
        if (id && this.state.emails[id]?.subject === undefined) needRow.add(id);
      }
    }
    if (!needRow.size) return;
    const accountId = this.accountId;
    const b = this.client.batch();
    const rows = b.call('Email/get', { accountId, ids: [...needRow], properties: LIST_PROPS });
    const threads = b.call('Thread/get', { accountId, '#ids': rows.ref('/list/*/threadId') });
    const members = b.call('Email/get', { accountId, '#ids': threads.ref('/list/*/emailIds'), properties: MEMBER_PROPS });
    const res = await this.client.send(b);
    solidBatch(() => {
      this.mergeEmails(res.get(members).list);
      this.mergeEmails(res.get(rows).list);
      this.mergeThreads(res.get(threads).list);
    });
  }

  /** The server can't compute changes for this query: reload only what's on screen. */
  private async resetQuery(key: string): Promise<void> {
    const range = this.ranges.get(key) ?? [0, PAGE_SIZE];
    this.set('queries', key, produce((q) => {
      q.slots = q.slots.map(() => null);
      q.queryState = null;
    }));
    await this.ensureRange(key, range[0], range[1]);
  }

  private async resetAll(): Promise<void> {
    this.states = {};
    const queries = Object.values(this.state.queries).map((q) => q.key);
    this.set({ emails: {}, threads: {}, bodies: {}, mailboxes: {} });
    this.set('queries', produce((all) => {
      for (const q of Object.values(all)) {
        q.slots = [];
        q.total = null;
        q.queryState = null;
      }
    }));
    await this.start();
    await Promise.all(queries.map((k) => this.resetQuery(k)));
  }

  // ---- Store merging -------------------------------------------------------

  private mergeEmails(list: Partial<Email>[]): void {
    if (!list.length) return;
    this.set('emails', produce((m) => {
      for (const e of list) {
        const id = e.id!;
        const cur = m[id];
        if (!cur) m[id] = { ...e, id };
        else Object.assign(cur, e);
      }
    }));
  }

  private mergeThreads(list: Thread[]): void {
    if (!list.length) return;
    this.set('threads', produce((m) => list.forEach((t) => (m[t.id] = t))));
  }

  private mergeMailboxes(list: Mailbox[]): void {
    if (!list.length) return;
    this.set('mailboxes', produce((m) => list.forEach((mb) => (m[mb.id] = mb))));
  }

  // ---- Persistence ---------------------------------------------------------

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private persistSoon(): void {
    if (!this.onPersist || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.onPersist?.(this.snapshot());
    }, 1000);
  }

  /** A bounded snapshot: mailboxes plus the first two pages of each open query and their threads. */
  snapshot(): Snapshot {
    const emails: Record<Id, EmailRec> = {};
    const threads: Record<Id, Thread> = {};
    const queries: Record<string, LiveQuery> = {};
    for (const q of Object.values(this.state.queries)) {
      if (!q.queryState) continue;
      const head = q.slots.slice(0, PAGE_SIZE * 2);
      if (head.some((id) => id === null)) continue;
      queries[q.key] = { ...q, slots: [...head, ...new Array<null>(Math.max(0, q.slots.length - head.length)).fill(null)] };
      for (const id of head) {
        const e = this.state.emails[id!];
        if (!e) continue;
        emails[e.id] = stripBodies(e);
        const t = e.threadId ? this.state.threads[e.threadId] : undefined;
        if (!t) continue;
        threads[t.id] = { id: t.id, emailIds: [...t.emailIds] };
        for (const mid of t.emailIds) {
          const m = this.state.emails[mid];
          if (m && !emails[mid]) emails[mid] = stripBodies(m);
        }
      }
    }
    return {
      v: 1,
      accountId: this.accountId,
      states: { ...this.states },
      mailboxes: JSON.parse(JSON.stringify(this.state.mailboxes)),
      identities: JSON.parse(JSON.stringify(this.state.identities)),
      emails,
      threads,
      queries: JSON.parse(JSON.stringify(queries)),
    };
  }
}

function stripBodies(e: EmailRec): EmailRec {
  const out: Record<string, unknown> = {};
  for (const k of LIST_PROPS) if (k in e) out[k] = JSON.parse(JSON.stringify((e as Record<string, unknown>)[k] ?? null));
  return out as EmailRec;
}

function byId<T extends { id: Id }>(list: T[]): Record<Id, T> {
  return Object.fromEntries(list.map((x) => [x.id, x]));
}

