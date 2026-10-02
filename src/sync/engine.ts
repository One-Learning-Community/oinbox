import { batch as solidBatch } from 'solid-js';
import { createStore, produce, type SetStoreFunction } from 'solid-js/store';
import type { BatchResult, JmapClient } from '../jmap/client';
import type { CallHandle } from '../jmap/request';
import type { Comparator, Email, EmailFilter, Id, Identity, Mailbox, MailboxRole, SetError, StateChange, Thread } from '../jmap/types';
import type { LabelPlan } from '../mail/labels';
import { applyEmailPatch, onlyIn, unlabelPatch, type EmailPatch, type MutableEmail } from './patch';
import { applyQueryChanges, missingPages, type Slots } from './window';

export const PAGE_SIZE = 50;
/** Emails per request while emptying a label (Stalwart's maxObjectsInSet). */
const SWEEP_PAGE = 500;

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
  /** Fetch SearchSnippet/get highlights for rows (search results). */
  snippets?: boolean;
}

export interface Snippet {
  subject: string | null;
  preview: string | null;
}

export interface LiveQuery extends QuerySpec {
  key: string;
  slots: Slots;
  total: number | null;
  queryState: string | null;
  error: string | null;
  snippetMap: Record<Id, Snippet>;
}

export interface MailState {
  ready: boolean;
  /** True once the store has been reconciled with the server in this session (a snapshot alone may be stale). */
  synced: boolean;
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

/** Thrown by `destroyLabel` before anything is changed, when the server has sub-labels of the label. */
export class LabelHasSubLabelsError extends Error {
  constructor() {
    super('This label has sub-labels');
  }
}

export function queryKey(spec: QuerySpec): string {
  return JSON.stringify([spec.filter, spec.sort, spec.collapseThreads, !!spec.snippets]);
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
  /** Called with every batch of emails merged into the store (the recipient index listens). */
  onEmails: ((emails: Partial<Email>[]) => void) | null = null;

  /**
   * Whether Email/queryChanges can be trusted for collapseThreads queries. Stalwart 0.16
   * answers it without collapsing threads (a new reply adds a row without removing the
   * thread's old one), so by default collapsed lists re-read their visible window instead.
   */
  private readonly collapsedQueryChanges: boolean;
  private readonly settleDelayMs: number;

  constructor(
    private readonly client: JmapClient,
    opts: { collapsedQueryChanges?: boolean; settleDelayMs?: number } = {},
  ) {
    this.collapsedQueryChanges = opts.collapsedQueryChanges ?? false;
    this.settleDelayMs = opts.settleDelayMs ?? 500;
    const [state, set] = createStore<MailState>({
      ready: false,
      synced: false,
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
    this.onEmails?.(Object.values(snap.emails));
    return true;
  }

  /** Initial load (cold) or catch-up (after hydrate). */
  async start(): Promise<void> {
    if (this.states.Mailbox) {
      await this.catchUp();
      this.set('synced', true);
      return;
    }
    const b = this.client.batch();
    const mb = b.call('Mailbox/get', { accountId: this.accountId, ids: null });
    const id = b.call('Identity/get', { accountId: this.accountId, ids: null });
    const res = await this.client.send(b);
    const mailboxes = res.get(mb);
    this.states.Mailbox = mailboxes.state;
    const identities = res.error(id) ? [] : res.get(id).list;
    this.set({ mailboxes: byId(mailboxes.list), identities, ready: true, synced: true });
  }

  setOnline(online: boolean): void {
    this.set('online', online);
  }

  // ---- Queries -------------------------------------------------------------

  openQuery(spec: QuerySpec): string {
    const key = queryKey(spec);
    if (!this.state.queries[key]) {
      this.set('queries', key, { ...spec, key, slots: [], total: null, queryState: null, error: null, snippetMap: {} });
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

  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Stalwart sends StateChange up to ~100 ms before a new message sorts into place, so the
   * immediate re-read can see it in the wrong position. Re-read once more after things settle.
   */
  private settleSoon(keys: string[]): void {
    if (this.settleDelayMs <= 0 || !keys.length) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      for (const k of keys) if (this.state.queries[k]) void this.refreshWindow(k).catch(() => undefined);
    }, this.settleDelayMs);
  }

  /** Re-read the rows around the viewport in one request (used when queryChanges can't be trusted). */
  private refreshWindow(key: string): Promise<void> {
    const [from, to] = this.ranges.get(key) ?? [0, PAGE_SIZE];
    const start = Math.floor(Math.max(0, from) / PAGE_SIZE) * PAGE_SIZE;
    const end = Math.max(start + PAGE_SIZE, Math.ceil(to / PAGE_SIZE) * PAGE_SIZE);
    return this.doFetchPage(key, start, end - start);
  }

  private async doFetchPage(key: string, position: number, limit = PAGE_SIZE): Promise<void> {
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
      limit,
      calculateTotal: true,
    });
    const rows = b.call('Email/get', { accountId, '#ids': query.ref('/ids'), properties: LIST_PROPS });
    const threads = b.call('Thread/get', { accountId, '#ids': rows.ref('/list/*/threadId') });
    const members = b.call('Email/get', { accountId, '#ids': threads.ref('/list/*/emailIds'), properties: MEMBER_PROPS });
    const snippets = q.snippets
      ? b.call('SearchSnippet/get', { accountId, filter: q.filter, '#emailIds': query.ref('/ids') })
      : null;

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
        // Snippets are a nicety: a server without SearchSnippet support still lists results.
        if (snippets && !res.error(snippets)) {
          for (const sn of res.get(snippets).list) lq.snippetMap[sn.emailId] = { subject: sn.subject, preview: sn.preview };
        }
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

  // ---- Mutations -----------------------------------------------------------

  /** Ids of every email in the given threads. */
  threadEmails(threadIds: Id[]): EmailRec[] {
    return threadIds.flatMap((tid) =>
      (this.state.threads[tid]?.emailIds ?? []).map((id) => this.state.emails[id]).filter((e): e is EmailRec => !!e),
    );
  }

  /**
   * Optimistically apply Email/set patches, then confirm with the server.
   * Rows that no longer match simple mailbox/starred views disappear at once.
   * Anything the server rejects is rolled back; the returned error describes it.
   */
  async updateEmails(patches: Record<Id, EmailPatch>): Promise<void> {
    const ids = Object.keys(patches);
    if (!ids.length) return;
    const before = new Map<Id, { keywords: Record<string, true>; mailboxIds: Record<Id, true> }>();
    const touchedThreads = new Set<Id>();

    solidBatch(() => {
      this.set('emails', produce((m) => {
        for (const id of ids) {
          const e = m[id];
          if (!e) continue;
          before.set(id, { keywords: { ...(e.keywords ?? {}) }, mailboxIds: { ...(e.mailboxIds ?? {}) } });
          Object.assign(e, applyEmailPatch(e, patches[id]!));
          if (e.threadId) touchedThreads.add(e.threadId);
        }
      }));
    });
    const removedRows = this.dropNonMatchingRows(touchedThreads);

    const rollback = (failed: Id[]) => {
      solidBatch(() => {
        this.set('emails', produce((m) => {
          for (const id of failed) {
            const prev = before.get(id);
            if (prev && m[id]) Object.assign(m[id], prev);
          }
        }));
        const failedThreads = new Set(failed.map((id) => this.state.emails[id]?.threadId));
        for (const r of removedRows) {
          if (!failedThreads.has(this.state.emails[r.id]?.threadId)) continue;
          this.set('queries', r.key, 'slots', produce((slots) => {
            if (!slots.includes(r.id)) slots.splice(Math.min(r.index, slots.length), 0, r.id);
          }));
          this.set('queries', r.key, 'total', (t) => (t ?? 0) + 1);
        }
      });
    };

    const b = this.client.batch();
    const call = b.call('Email/set', { accountId: this.accountId, update: patches });
    let failed: Record<Id, SetError> = {};
    try {
      const res = await this.client.send(b);
      failed = res.get(call).notUpdated ?? {};
    } catch (e) {
      // Transport or method-level failure: nothing was applied server-side.
      rollback(ids);
      throw e;
    } finally {
      this.persistSoon();
    }
    const failedIds = Object.keys(failed);
    if (failedIds.length) {
      rollback(failedIds);
      const first = failed[failedIds[0]!]!;
      throw new Error(first.description ?? first.type);
    }
  }

  /**
   * Save a draft. JMAP emails are immutable, so each save creates a new email and
   * destroys the previous version in the same request. Returns the new id.
   */
  async saveDraft(email: Partial<Email>, replaces: Id | null): Promise<{ id: Id; threadId: Id }> {
    const b = this.client.batch();
    const call = b.call('Email/set', {
      accountId: this.accountId,
      create: { draft: email },
      ...(replaces ? { destroy: [replaces] } : {}),
    });
    const r = (await this.client.send(b)).get(call);
    const created = r.created?.draft;
    if (!created) {
      const err = r.notCreated?.draft;
      throw new Error(err?.description ?? err?.type ?? 'Draft was not saved');
    }
    return { id: created.id!, threadId: created.threadId! };
  }

  async destroyEmails(ids: Id[]): Promise<void> {
    if (!ids.length) return;
    const b = this.client.batch();
    const call = b.call('Email/set', { accountId: this.accountId, destroy: ids });
    const r = (await this.client.send(b)).get(call);
    const failed = Object.values(r.notDestroyed ?? {})[0];
    if (failed) throw new Error(failed.description ?? failed.type);
  }

  /** Submit a saved draft; on success the server files it in Sent and clears $draft. */
  async sendDraft(emailId: Id, identityId: Id): Promise<void> {
    const drafts = this.mailboxByRole('drafts')?.id;
    const sent = this.mailboxByRole('sent')?.id;
    const onSuccess: Record<string, unknown> = { 'keywords/$draft': null };
    if (drafts) onSuccess[`mailboxIds/${drafts}`] = null;
    if (sent) onSuccess[`mailboxIds/${sent}`] = true;
    const b = this.client.batch();
    const call = b.call('EmailSubmission/set', {
      accountId: this.accountId,
      create: { send: { identityId, emailId } },
      onSuccessUpdateEmail: { '#send': onSuccess },
    });
    const r = (await this.client.send(b)).get(call);
    if (!r.created?.send) {
      const err = r.notCreated?.send;
      throw new Error(err?.description ?? err?.type ?? 'Message was not sent');
    }
  }

  /** To, Cc and Bcc of the newest `limit` messages in Sent, for the recipient index. */
  async sentRecipients(limit: number): Promise<Partial<Email>[]> {
    const sent = this.mailboxByRole('sent')?.id;
    if (!sent) return [];
    const accountId = this.accountId;
    const b = this.client.batch();
    const q = b.call('Email/query', { accountId, filter: { inMailbox: sent }, sort: DEFAULT_SORT, limit });
    const g = b.call('Email/get', { accountId, '#ids': q.ref('/ids'), properties: ['to', 'cc', 'bcc', 'receivedAt'] });
    return (await this.client.send(b)).get(g).list;
  }

  /** The mailbox with a role, creating it if the account lacks one (e.g. Archive). */
  async ensureMailbox(role: MailboxRole, name: string): Promise<Id> {
    const existing = this.mailboxByRole(role);
    if (existing) return existing.id;
    const b = this.client.batch();
    const call = b.call('Mailbox/set', { accountId: this.accountId, create: { mb: { name, role, parentId: null } } });
    const r = (await this.client.send(b)).get(call);
    const created = r.created?.mb;
    if (!created) {
      const err = r.notCreated?.mb;
      throw new Error(`Couldn't create the ${name} mailbox: ${err?.description ?? err?.type ?? 'unknown error'}`);
    }
    // The server returns only the properties it set; fill in the ones we sent.
    const mb: Mailbox = { ...blankMailbox(name, null, role), ...created };
    this.mergeMailboxes([mb]);
    return mb.id;
  }

  /** Create a label and its missing ancestors. Returns the label's id. */
  async createLabel(plan: LabelPlan): Promise<Id> {
    const ids = await this.createMailboxChain(plan.parentId, [...plan.ancestors, plan.name]);
    return ids[ids.length - 1]!;
  }

  /** Rename a label and/or move it under another parent. */
  async updateLabel(id: Id, plan: LabelPlan): Promise<void> {
    // Stalwart refuses a creation reference inside an update, so missing ancestors go first.
    const made = plan.ancestors.length ? await this.createMailboxChain(plan.parentId, plan.ancestors) : [];
    const parentId = made.length ? made[made.length - 1]! : plan.parentId;
    const rename = async (name: string) => {
      const b = this.client.batch();
      const call = b.call('Mailbox/set', { accountId: this.accountId, update: { [id]: { name, parentId } } });
      const err = (await this.client.send(b)).get(call).notUpdated?.[id];
      if (!err && this.state.mailboxes[id]) this.set('mailboxes', id, { name, parentId });
      return err;
    };
    let err = await rename(plan.name);
    // Stalwart refuses a change of letter case alone as a clash with the mailbox itself: go by way of another name.
    if (err?.type === 'alreadyExists' && err.existingId === id) err = (await rename(`${plan.name} (${id})`)) ?? (await rename(plan.name));
    this.persistSoon();
    if (err) throw new Error(err.description ?? err.type);
  }

  /** How many emails are in this mailbox and no other. */
  async countOrphans(id: Id): Promise<number> {
    const b = this.client.batch();
    const q = b.call('Email/query', {
      accountId: this.accountId,
      filter: { operator: 'AND', conditions: [{ inMailbox: id }, { operator: 'NOT', conditions: [{ inMailboxOtherThan: [id] }] }] },
      // Stalwart reads limit 0 as "no limit".
      limit: 1,
      calculateTotal: true,
    });
    return (await this.client.send(b)).get(q).total ?? 0;
  }

  /**
   * Delete a label without deleting mail: take the label off every email (those with no other
   * mailbox go to Archive), then destroy the empty mailbox. The server is never asked to remove
   * emails, so a failure midway leaves the label in place with less mail in it.
   */
  async destroyLabel(id: Id): Promise<void> {
    // The store can lag the server. A sub-label it hasn't seen would block the destroy after
    // the label was already taken off all its mail, so ask the server first.
    const b = this.client.batch();
    const all = b.call('Mailbox/get', { accountId: this.accountId, ids: null, properties: ['parentId'] });
    if ((await this.client.send(b)).get(all).list.some((m) => m.parentId === id)) {
      void this.catchUp().catch(() => undefined);
      throw new LabelHasSubLabelsError();
    }
    try {
      await this.sweepLabel(id);
      if (await this.destroyEmptyMailbox(id)) {
        // Mail arrived during the sweep.
        await this.sweepLabel(id);
        if (await this.destroyEmptyMailbox(id)) throw new Error('New mail keeps arriving in this label');
      }
    } finally {
      this.persistSoon();
    }
    this.forgetMailboxes([id]);
    await this.catchUp().catch(() => undefined);
  }

  /** Resolves true if the server refused because the mailbox still holds mail. */
  private async destroyEmptyMailbox(id: Id): Promise<boolean> {
    const b = this.client.batch();
    const call = b.call('Mailbox/set', { accountId: this.accountId, destroy: [id], onDestroyRemoveEmails: false });
    const err = (await this.client.send(b)).get(call).notDestroyed?.[id];
    // notFound: another client deleted it first.
    if (!err || err.type === 'notFound') return false;
    if (err.type === 'mailboxHasEmail') return true;
    throw new Error(err.description ?? err.type);
  }

  private async sweepLabel(id: Id): Promise<void> {
    const accountId = this.accountId;
    const seen = new Set<Id>();
    for (;;) {
      const b = this.client.batch();
      const q = b.call('Email/query', { accountId, filter: { inMailbox: id }, collapseThreads: false, limit: SWEEP_PAGE });
      const g = b.call('Email/get', { accountId, '#ids': q.ref('/ids'), properties: ['mailboxIds'] });
      const page = (await this.client.send(b)).get(g).list as MutableEmail[];
      if (!page.length) return;
      if (page.every((e) => seen.has(e.id))) throw new Error("The server didn't apply the change");
      page.forEach((e) => seen.add(e.id));

      const archive = page.some((e) => onlyIn(e, id)) ? await this.ensureMailbox('archive', 'Archive') : '';
      const patches = unlabelPatch(page, id, archive);
      const sb = this.client.batch();
      const call = sb.call('Email/set', { accountId, update: patches });
      const failed = Object.values((await this.client.send(sb)).get(call).notUpdated ?? {})[0];
      if (failed) throw new Error(failed.description ?? failed.type);
      this.set('emails', produce((m) => {
        for (const [eid, patch] of Object.entries(patches)) {
          const e = m[eid];
          if (e) Object.assign(e, applyEmailPatch(e, patch));
        }
      }));
    }
  }

  /** Drop mailboxes from the store, and with them the live queries that list them. */
  private forgetMailboxes(ids: Id[]): void {
    if (!ids.length) return;
    const gone = new Set(ids);
    solidBatch(() => {
      this.set('mailboxes', produce((m) => ids.forEach((id) => delete m[id])));
      for (const q of Object.values(this.state.queries)) {
        const f = q.filter as Record<string, unknown> | null;
        if (!f || Object.keys(f).length !== 1 || typeof f.inMailbox !== 'string' || !gone.has(f.inMailbox)) continue;
        this.ranges.delete(q.key);
        this.set('queries', produce((all) => void delete all[q.key]));
      }
    });
  }

  /** Create nested mailboxes in one Mailbox/set, each child naming its parent by creation id. */
  private async createMailboxChain(parentId: Id | null, names: string[]): Promise<Id[]> {
    const create: Record<string, Partial<Mailbox>> = {};
    names.forEach((name, i) => {
      create[`c${i}`] = { name, parentId: i === 0 ? parentId : `#c${i - 1}`, isSubscribed: true };
    });
    const b = this.client.batch();
    const call = b.call('Mailbox/set', { accountId: this.accountId, create });
    const r = (await this.client.send(b)).get(call);
    const made: Mailbox[] = [];
    for (let i = 0; i < names.length; i++) {
      const created = r.created?.[`c${i}`];
      if (!created) break;
      made.push({ ...blankMailbox(names[i]!, i === 0 ? parentId : made[i - 1]!.id), ...created });
    }
    this.mergeMailboxes(made);
    this.persistSoon();
    if (made.length < names.length) {
      const err = r.notCreated?.[`c${made.length}`];
      throw new Error(err?.description ?? err?.type ?? 'The label was not created');
    }
    return made.map((m) => m.id);
  }

  /** Remove rows of mailbox/starred views whose thread no longer belongs there. */
  private dropNonMatchingRows(threadIds: Set<Id>): { key: string; id: Id; index: number }[] {
    const removed: { key: string; id: Id; index: number }[] = [];
    for (const q of Object.values(this.state.queries)) {
      const f = q.filter as Record<string, unknown> | null;
      if (!f) continue;
      const keys = Object.keys(f);
      let matches: ((members: EmailRec[]) => boolean) | null = null;
      if (keys.length === 1 && typeof f.inMailbox === 'string') {
        const mb = f.inMailbox;
        matches = (members) => members.some((e) => e.mailboxIds?.[mb]);
      } else if (keys.length === 1 && f.hasKeyword === '$flagged') {
        matches = (members) => members.some((e) => e.keywords?.$flagged);
      }
      if (!matches) continue;
      const drop: { id: Id; index: number }[] = [];
      q.slots.forEach((id, index) => {
        if (!id) return;
        const tid = this.state.emails[id]?.threadId;
        if (!tid || !threadIds.has(tid)) return;
        if (!matches!(this.threadEmails([tid]))) drop.push({ id, index });
      });
      if (!drop.length) continue;
      const dropIds = new Set(drop.map((d) => d.id));
      this.set('queries', q.key, produce((lq) => {
        lq.slots = lq.slots.filter((id) => !id || !dropIds.has(id));
        lq.total = lq.slots.length;
      }));
      for (const d of drop) removed.push({ key: q.key, ...d });
    }
    return removed;
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

    const loaded = Object.values(this.state.queries).filter((q) => q.queryState);
    const liveQueries = loaded.filter((q) => !q.collapseThreads || this.collapsedQueryChanges);
    const windowed = loaded.filter((q) => !liveQueries.includes(q)).map((q) => q.key);
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
        this.forgetMailboxes(ch.destroyed);
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
        if (!this.state.queries[q.key]) continue;
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
    if (em || th) {
      const ch = em ? res.get(em.changes) : null;
      const changed = !ch || ch.created.length + ch.updated.length + ch.destroyed.length > 0;
      if (changed) {
        await Promise.all(windowed.map((k) => this.refreshWindow(k)));
        this.settleSoon(windowed);
      }
    }
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
    const needSnippets: { key: string; filter: EmailFilter | null; ids: Id[] }[] = [];
    for (const q of Object.values(this.state.queries)) {
      const range = this.ranges.get(q.key) ?? [0, PAGE_SIZE];
      const missingSnippets: Id[] = [];
      for (const id of q.slots.slice(Math.max(0, range[0] - PAGE_SIZE), range[1] + PAGE_SIZE)) {
        if (id && this.state.emails[id]?.subject === undefined) needRow.add(id);
        if (id && q.snippets && !q.snippetMap[id]) missingSnippets.push(id);
      }
      if (missingSnippets.length) needSnippets.push({ key: q.key, filter: q.filter, ids: missingSnippets });
    }
    if (!needRow.size && !needSnippets.length) return;
    const accountId = this.accountId;
    const b = this.client.batch();
    const snippetCalls = needSnippets.map((n) => ({
      key: n.key,
      call: b.call('SearchSnippet/get', { accountId, filter: n.filter, emailIds: n.ids }),
    }));
    if (!needRow.size) {
      const res = await this.client.send(b);
      this.applySnippets(res, snippetCalls);
      return;
    }
    const rows = b.call('Email/get', { accountId, ids: [...needRow], properties: LIST_PROPS });
    const threads = b.call('Thread/get', { accountId, '#ids': rows.ref('/list/*/threadId') });
    const members = b.call('Email/get', { accountId, '#ids': threads.ref('/list/*/emailIds'), properties: MEMBER_PROPS });
    const res = await this.client.send(b);
    solidBatch(() => {
      this.mergeEmails(res.get(members).list);
      this.mergeEmails(res.get(rows).list);
      this.mergeThreads(res.get(threads).list);
      this.applySnippets(res, snippetCalls);
    });
  }

  private applySnippets(res: BatchResult, calls: { key: string; call: CallHandle<'SearchSnippet/get'> }[]): void {
    for (const { key, call } of calls) {
      if (res.error(call) || !this.state.queries[key]) continue;
      this.set('queries', key, 'snippetMap', produce((m) => {
        for (const sn of res.get(call).list) m[sn.emailId] = { subject: sn.subject, preview: sn.preview };
      }));
    }
  }

  /** The server can't compute changes for this query: reload only what's on screen. */
  private async resetQuery(key: string): Promise<void> {
    if (!this.state.queries[key]) return;
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
    this.set({ emails: {}, threads: {}, bodies: {}, mailboxes: {}, synced: false });
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
    this.onEmails?.(list);
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

/** A mailbox as the server makes it, for filling in what a Mailbox/set response leaves out. */
function blankMailbox(name: string, parentId: Id | null, role: MailboxRole | null = null): Mailbox {
  return { id: '', name, role, parentId, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true };
}

function byId<T extends { id: Id }>(list: T[]): Record<Id, T> {
  return Object.fromEntries(list.map((x) => [x.id, x]));
}

