// A tiny in-memory JMAP server for engine and calendar tests: enough of RFC 8620/8621 to
// exercise paging, back-references, /changes, /queryChanges and Email/set.
import { JmapClient } from '../jmap/client';
import type { Invocation } from '../jmap/request';
import type { Calendar, CalendarEvent, Email, Mailbox, Session } from '../jmap/types';

type Rec = Partial<Email> & { id: string; threadId: string; receivedAt: string };

export class FakeJmap {
  mailboxes = new Map<string, Mailbox>();
  emails = new Map<string, Rec>();
  emailState = 0;
  log: { state: number; created: string[]; updated: string[]; destroyed: string[] }[] = [];
  /** Email ids whose updates the server rejects. */
  rejectUpdates = new Set<string>();
  queryChangesUnsupported = false;
  /** Simulates the server no longer being able to compute type-level /changes (stale cursor). */
  changesUnsupported = false;
  calls: string[] = [];
  /** Every call with its resolved arguments, for asserting on what was sent. */
  sent: [string, Record<string, unknown>][] = [];
  /** Runs before each call is handled: lets a test change server state mid-flow, or throw. */
  onCall: ((name: string, args: Record<string, unknown>) => void) | null = null;
  mailboxState = 1;
  mailboxLog: { state: number; created: string[]; updated: string[]; destroyed: string[] }[] = [];
  private nextMailboxId = 1;
  calendars = new Map<string, Calendar>();
  /** Expanded occurrences served by CalendarEvent/query (filtered by utcStart in [after, before)). */
  occurrences: CalendarEvent[] = [];
  /** Base events, served by CalendarEvent/get by id. */
  baseEvents = new Map<string, CalendarEvent>();
  calendarEventState = 0;
  failCalendarQueries = false;
  /** Each request's response waits for the next promise here, if any (for race tests). */
  holds: Promise<void>[] = [];

  addMailbox(id: string, name: string, role: Mailbox['role'] = null, parentId: string | null = null) {
    this.mailboxes.set(id, {
      id, name, role, parentId, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
    });
  }

  bumpMailbox(c: Partial<{ created: string[]; updated: string[]; destroyed: string[] }>) {
    this.mailboxState++;
    this.mailboxLog.push({ state: this.mailboxState, created: c.created ?? [], updated: c.updated ?? [], destroyed: c.destroyed ?? [] });
  }

  private withCounts(m: Mailbox): Mailbox {
    const inside = [...this.emails.values()].filter((e) => e.mailboxIds?.[m.id]);
    return { ...m, totalEmails: inside.length, totalThreads: new Set(inside.map((e) => e.threadId)).size };
  }

  addEmail(e: Rec, record = true) {
    this.emails.set(e.id, { keywords: {}, mailboxIds: {}, subject: `S ${e.id}`, preview: `P ${e.id}`, from: [{ name: 'X', email: 'x@x.test' }], ...e });
    if (record) this.bump({ created: [e.id] });
  }

  bump(c: Partial<{ created: string[]; updated: string[]; destroyed: string[] }>) {
    this.emailState++;
    this.log.push({ state: this.emailState, created: c.created ?? [], updated: c.updated ?? [], destroyed: c.destroyed ?? [] });
  }

  private matches(e: Rec, f: Record<string, unknown> | null | undefined): boolean {
    if (!f) return true;
    if (typeof f.operator === 'string') {
      const results = (f.conditions as Record<string, unknown>[]).map((c) => this.matches(e, c));
      return f.operator === 'AND' ? results.every(Boolean) : f.operator === 'OR' ? results.some(Boolean) : !results.some(Boolean);
    }
    if (f.inMailbox && !e.mailboxIds?.[f.inMailbox as string]) return false;
    if (f.inMailboxOtherThan) {
      const not = new Set(f.inMailboxOtherThan as string[]);
      if (!Object.keys(e.mailboxIds ?? {}).some((id) => !not.has(id))) return false;
    }
    return true;
  }

  private queryIds(args: Record<string, unknown>): string[] {
    let list = [...this.emails.values()].filter((e) => this.matches(e, args.filter as Record<string, unknown> | null));
    list.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    if (args.collapseThreads) {
      const seen = new Set<string>();
      list = list.filter((e) => (seen.has(e.threadId) ? false : (seen.add(e.threadId), true)));
    }
    return list.map((e) => e.id);
  }

  private queryStates = new Map<string, string[]>();

  handle(name: string, args: Record<string, unknown>): [string, unknown] {
    this.calls.push(name);
    this.sent.push([name, args]);
    this.onCall?.(name, args);
    const ids = args.ids as string[] | null | undefined;
    const pick = (e: Rec) => {
      const props = args.properties as string[] | undefined;
      if (!props) return structuredClone(e);
      return Object.fromEntries(['id', ...props].filter((p) => p in e).map((p) => [p, structuredClone((e as Record<string, unknown>)[p])]));
    };
    switch (name) {
      case 'Mailbox/get': {
        const all = [...this.mailboxes.values()];
        const list = (ids ? all.filter((m) => ids.includes(m.id)) : all).map((m) => this.withCounts(m));
        return [name, { accountId: 'a1', state: `m${this.mailboxState}`, list, notFound: [] }];
      }
      case 'Identity/get':
        return [name, { accountId: 'a1', state: 'i1', list: [{ id: 'id1', name: 'Alice', email: 'alice@example.test' }], notFound: [] }];
      case 'Email/query': {
        const all = this.queryIds(args);
        const qs = `q${this.emailState}`;
        this.queryStates.set(JSON.stringify([args.filter, args.collapseThreads]) + qs, all);
        const pos = (args.position as number) ?? 0;
        return [name, { accountId: 'a1', queryState: qs, canCalculateChanges: true, position: pos, ids: all.slice(pos, pos + ((args.limit as number) ?? 50)), total: all.length }];
      }
      case 'Email/queryChanges': {
        if (this.queryChangesUnsupported) return ['error', { type: 'cannotCalculateChanges' }];
        const old = this.queryStates.get(JSON.stringify([args.filter, args.collapseThreads]) + args.sinceQueryState);
        if (!old) return ['error', { type: 'cannotCalculateChanges' }];
        const now = this.queryIds(args);
        const qs = `q${this.emailState}`;
        this.queryStates.set(JSON.stringify([args.filter, args.collapseThreads]) + qs, now);
        const removed = old.filter((id) => !now.includes(id));
        const added = now.map((id, index) => ({ id, index })).filter((a) => !old.includes(a.id));
        return [name, { accountId: 'a1', oldQueryState: args.sinceQueryState, newQueryState: qs, removed, added, total: now.length }];
      }
      case 'Email/get':
        return [name, { accountId: 'a1', state: `e${this.emailState}`, list: (ids ?? []).map((id) => this.emails.get(id)).filter(Boolean).map((e) => pick(e!)), notFound: [] }];
      case 'Thread/get': {
        const list = (ids ?? []).map((tid) => ({
          id: tid,
          emailIds: [...this.emails.values()].filter((e) => e.threadId === tid).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).map((e) => e.id),
        }));
        return [name, { accountId: 'a1', state: `t${this.emailState}`, list, notFound: [] }];
      }
      case 'Email/changes':
      case 'Thread/changes':
      case 'Mailbox/changes': {
        if (this.changesUnsupported) return ['error', { type: 'cannotCalculateChanges' }];
        const since = Number(String(args.sinceState).slice(1));
        const uniq = (xs: string[]) => [...new Set(xs)];
        if (name === 'Mailbox/changes') {
          const entries = this.mailboxLog.filter((l) => l.state > since);
          const destroyed = uniq(entries.flatMap((l) => l.destroyed));
          const created = uniq(entries.flatMap((l) => l.created)).filter((id) => !destroyed.includes(id));
          const updated = uniq(entries.flatMap((l) => l.updated)).filter((id) => !created.includes(id) && !destroyed.includes(id));
          return [name, { accountId: 'a1', oldState: args.sinceState, newState: `m${this.mailboxState}`, hasMoreChanges: false, created, updated, destroyed, updatedProperties: null }];
        }
        const entries = this.log.filter((l) => l.state > since);
        const created = uniq(entries.flatMap((l) => l.created));
        const updated = uniq(entries.flatMap((l) => l.updated)).filter((id) => !created.includes(id));
        const destroyed = uniq(entries.flatMap((l) => l.destroyed));
        if (name === 'Thread/changes') {
          const tids = uniq([...created, ...updated].map((id) => this.emails.get(id)?.threadId).filter((x): x is string => !!x));
          return [name, { accountId: 'a1', oldState: args.sinceState, newState: `t${this.emailState}`, hasMoreChanges: false, created: [], updated: tids, destroyed: [] }];
        }
        return [name, { accountId: 'a1', oldState: args.sinceState, newState: `e${this.emailState}`, hasMoreChanges: false, created, updated, destroyed }];
      }
      case 'Calendar/get':
        return [name, { accountId: 'a1', state: 'cal1', list: [...this.calendars.values()].map((c) => structuredClone(c)), notFound: [] }];
      case 'CalendarEvent/query': {
        if (this.failCalendarQueries) return ['error', { type: 'serverFail', description: 'calendar store unavailable' }];
        const f = (args.filter ?? {}) as { after?: string; before?: string };
        const inRange = (o: CalendarEvent) => (!f.after || o.utcStart! >= f.after) && (!f.before || o.utcStart! < f.before);
        return [name, { accountId: 'a1', queryState: `ce${this.calendarEventState}`, canCalculateChanges: false, position: 0, ids: this.occurrences.filter(inRange).map((o) => o.id) }];
      }
      case 'CalendarEvent/get': {
        const all = new Map<string, CalendarEvent>([...this.baseEvents, ...this.occurrences.map((o) => [o.id, o] as const)]);
        const list = [...new Set(ids ?? [])].map((id) => all.get(id)).filter((e): e is CalendarEvent => !!e).map((e) => structuredClone(e));
        return [name, { accountId: 'a1', state: `ce${this.calendarEventState}`, list, notFound: [] }];
      }
      case 'Mailbox/set': {
        const oldState = `m${this.mailboxState}`;
        const all = () => [...this.mailboxes.values()];
        const clash = (parentId: string | null, mbName: string, except?: string) =>
          all().some((m) => m.id !== except && (m.parentId ?? null) === parentId && m.name.toLowerCase() === mbName.toLowerCase());
        const exists = (mbName: string) => ({ type: 'alreadyExists', description: `A mailbox with name '${mbName}' already exists.` });

        const update = (args.update ?? {}) as Record<string, { name?: string; parentId?: string | null }>;
        // Stalwart refuses a creation reference inside an update, failing the whole call.
        if (Object.values(update).some((p) => typeof p.parentId === 'string' && p.parentId.startsWith('#'))) {
          return ['error', { type: 'invalidResultReference', description: 'Id reference not found.' }];
        }

        const created: Record<string, { id: string }> = {};
        const notCreated: Record<string, { type: string; description?: string }> = {};
        const real = new Map<string, string>();
        // Creates may refer to each other in any order: keep going while one more resolves.
        let pending = Object.entries((args.create ?? {}) as Record<string, Partial<Mailbox>>);
        while (pending.length) {
          const waiting: typeof pending = [];
          for (const [cid, props] of pending) {
            let parentId = props.parentId ?? null;
            if (parentId?.startsWith('#')) {
              const resolved = real.get(parentId.slice(1));
              if (!resolved) {
                waiting.push([cid, props]);
                continue;
              }
              parentId = resolved;
            }
            if (clash(parentId, props.name!)) {
              notCreated[cid] = exists(props.name!);
              continue;
            }
            const id = `mb${this.nextMailboxId++}`;
            this.mailboxes.set(id, {
              id, name: props.name!, role: props.role ?? null, parentId, sortOrder: 0,
              totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: props.isSubscribed ?? false,
            });
            real.set(cid, id);
            created[cid] = { id };
          }
          if (waiting.length === pending.length) {
            for (const [cid] of waiting) notCreated[cid] = { type: 'invalidProperties', description: 'Unknown parent.' };
            break;
          }
          pending = waiting;
        }

        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string; description?: string; existingId?: string }> = {};
        for (const [id, patch] of Object.entries(update)) {
          const m = this.mailboxes.get(id);
          if (!m) {
            notUpdated[id] = { type: 'notFound' };
            continue;
          }
          const mbName = patch.name ?? m.name;
          const parentId = patch.parentId === undefined ? m.parentId : patch.parentId;
          // Stalwart counts the mailbox itself as a clash when only the letter case of its name changes.
          const hit = all().find((o) => (o.id !== id || mbName !== m.name) && (o.parentId ?? null) === parentId && o.name.toLowerCase() === mbName.toLowerCase());
          if (hit && (hit.id !== id || parentId === m.parentId)) {
            notUpdated[id] = { ...exists(mbName), existingId: hit.id };
            continue;
          }
          m.name = mbName;
          m.parentId = parentId;
          updated[id] = null;
        }

        const destroyed: string[] = [];
        const notDestroyed: Record<string, { type: string; description?: string }> = {};
        for (const id of (args.destroy ?? []) as string[]) {
          if (!this.mailboxes.has(id)) {
            notDestroyed[id] = { type: 'notFound' };
            continue;
          }
          if (all().some((m) => m.parentId === id)) {
            notDestroyed[id] = { type: 'mailboxHasChild', description: 'Mailbox has at least one children.' };
            continue;
          }
          const inside = [...this.emails.values()].filter((e) => e.mailboxIds?.[id]);
          if (inside.length && !args.onDestroyRemoveEmails) {
            notDestroyed[id] = { type: 'mailboxHasEmail', description: 'Mailbox is not empty.' };
            continue;
          }
          for (const e of inside) {
            delete e.mailboxIds![id];
            if (!Object.keys(e.mailboxIds!).length) {
              this.emails.delete(e.id);
              this.bump({ destroyed: [e.id] });
            }
          }
          this.mailboxes.delete(id);
          destroyed.push(id);
        }

        const change = { created: Object.values(created).map((c) => c.id), updated: Object.keys(updated), destroyed };
        if (change.created.length || change.updated.length || change.destroyed.length) this.bumpMailbox(change);
        const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
        return [name, {
          accountId: 'a1', oldState, newState: `m${this.mailboxState}`,
          created: orNull(created), updated: orNull(updated), destroyed: destroyed.length ? destroyed : null,
          notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
        }];
      }
      case 'Email/set': {
        const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string }> = {};
        for (const [id, patch] of Object.entries(update)) {
          const e = this.emails.get(id);
          if (!e || this.rejectUpdates.has(id)) {
            notUpdated[id] = { type: e ? 'forbidden' : 'notFound' };
            continue;
          }
          for (const [path, v] of Object.entries(patch)) {
            const [prop, key] = path.split('/') as ['keywords' | 'mailboxIds', string | undefined];
            if (!key) (e as Record<string, unknown>)[prop] = v;
            else if (v === null) delete e[prop]![key];
            else (e[prop] as Record<string, true>)[key] = true;
          }
          updated[id] = null;
        }
        if (Object.keys(updated).length) this.bump({ updated: Object.keys(updated) });
        return [name, { accountId: 'a1', oldState: null, newState: `e${this.emailState}`, updated, notUpdated: Object.keys(notUpdated).length ? notUpdated : null }];
      }
    }
    return ['error', { type: 'unknownMethod' }];
  }

  /** Resolve back-references (RFC 8620 §3.7) including `*` path segments. */
  private resolve(args: Record<string, unknown>, done: Map<string, Invocation>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!k.startsWith('#')) {
        out[k] = v;
        continue;
      }
      const ref = v as { resultOf: string; path: string };
      const prior = done.get(ref.resultOf)!;
      let cur: unknown[] = [prior[1]];
      for (const seg of ref.path.split('/').slice(1)) {
        cur = cur.flatMap((c) => (seg === '*' ? (c as unknown[]) : [(c as Record<string, unknown>)[seg]]));
      }
      out[k.slice(1)] = cur.flat();
    }
    return out;
  }

  client(): JmapClient {
    const session: Session = {
      capabilities: {}, accounts: { a1: { name: 'alice', isPersonal: true, isReadOnly: false } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1', 'urn:ietf:params:jmap:calendars': 'a1' }, username: 'alice@example.test',
      apiUrl: 'http://fake/jmap', downloadUrl: '', uploadUrl: '', eventSourceUrl: '', state: 's',
    };
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { methodCalls: Invocation[] };
      const done = new Map<string, Invocation>();
      const responses: Invocation[] = [];
      for (const [name, args, id] of body.methodCalls) {
        const [rname, result] = this.handle(name, this.resolve(args, done));
        const inv: Invocation = [rname, result as Record<string, unknown>, id];
        done.set(id, inv);
        responses.push(inv);
      }
      // Answer from the state at request time, but deliver when the test says so.
      const hold = this.holds.shift();
      if (hold) await hold;
      return new Response(JSON.stringify({ methodResponses: responses, sessionState: 's' }), { status: 200 });
    };
    const c = new JmapClient({ sessionUrl: 'http://fake/session', getToken: async () => 't', fetch: fetchImpl as typeof fetch });
    c.useSession(session);
    return c;
  }
}
