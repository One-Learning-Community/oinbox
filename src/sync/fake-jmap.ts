// A tiny in-memory JMAP server for engine tests: enough of RFC 8620/8621 to
// exercise paging, back-references, /changes, /queryChanges and Email/set.
import { JmapClient } from '../jmap/client';
import type { Invocation } from '../jmap/request';
import type { Email, Mailbox, Session } from '../jmap/types';

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

  addMailbox(id: string, name: string, role: Mailbox['role'] = null) {
    this.mailboxes.set(id, {
      id, name, role, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
    });
  }

  addEmail(e: Rec, record = true) {
    this.emails.set(e.id, { keywords: {}, mailboxIds: {}, subject: `S ${e.id}`, preview: `P ${e.id}`, from: [{ name: 'X', email: 'x@x.test' }], ...e });
    if (record) this.bump({ created: [e.id] });
  }

  bump(c: Partial<{ created: string[]; updated: string[]; destroyed: string[] }>) {
    this.emailState++;
    this.log.push({ state: this.emailState, created: c.created ?? [], updated: c.updated ?? [], destroyed: c.destroyed ?? [] });
  }

  private queryIds(args: Record<string, unknown>): string[] {
    const filter = (args.filter ?? {}) as Record<string, unknown>;
    let list = [...this.emails.values()].filter((e) => !filter.inMailbox || e.mailboxIds?.[filter.inMailbox as string]);
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
    const ids = args.ids as string[] | null | undefined;
    const pick = (e: Rec) => {
      const props = args.properties as string[] | undefined;
      if (!props) return structuredClone(e);
      return Object.fromEntries(['id', ...props].filter((p) => p in e).map((p) => [p, structuredClone((e as Record<string, unknown>)[p])]));
    };
    switch (name) {
      case 'Mailbox/get':
        return [name, { accountId: 'a1', state: 'm1', list: [...this.mailboxes.values()], notFound: [] }];
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
        if (name === 'Mailbox/changes') return [name, { accountId: 'a1', oldState: args.sinceState, newState: 'm1', hasMoreChanges: false, created: [], updated: [], destroyed: [], updatedProperties: null }];
        const entries = this.log.filter((l) => l.state > since);
        const uniq = (xs: string[]) => [...new Set(xs)];
        const created = uniq(entries.flatMap((l) => l.created));
        const updated = uniq(entries.flatMap((l) => l.updated)).filter((id) => !created.includes(id));
        const destroyed = uniq(entries.flatMap((l) => l.destroyed));
        if (name === 'Thread/changes') {
          const tids = uniq([...created, ...updated].map((id) => this.emails.get(id)?.threadId).filter((x): x is string => !!x));
          return [name, { accountId: 'a1', oldState: args.sinceState, newState: `t${this.emailState}`, hasMoreChanges: false, created: [], updated: tids, destroyed: [] }];
        }
        return [name, { accountId: 'a1', oldState: args.sinceState, newState: `e${this.emailState}`, hasMoreChanges: false, created, updated, destroyed }];
      }
      case 'Email/set': {
        const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string }> = {};
        for (const [id, patch] of Object.entries(update)) {
          const e = this.emails.get(id);
          if (!e || this.rejectUpdates.has(id)) {
            notUpdated[id] = { type: 'forbidden' };
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
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' }, username: 'alice@example.test',
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
      return new Response(JSON.stringify({ methodResponses: responses, sessionState: 's' }), { status: 200 });
    };
    const c = new JmapClient({ sessionUrl: 'http://fake/session', getToken: async () => 't', fetch: fetchImpl as typeof fetch });
    c.useSession(session);
    return c;
  }
}
