// A tiny in-memory JMAP server for engine and calendar tests: enough of RFC 8620/8621 to
// exercise paging, back-references, /changes, /queryChanges and Email/set.
import { JmapClient } from '../jmap/client';
import type { Invocation } from '../jmap/request';
import { CALENDARS_PARSE, VACATION, type Calendar, type CalendarEvent, type Email, type EmailBodyPart, type EmailBodyStructure, type Identity, type Mailbox, type Session, type VacationResponse } from '../jmap/types';

type Rec = Partial<Email> & { id: string; threadId: string; receivedAt: string };

export class FakeJmap {
  /** This fake's account, as a session built by fakeClient() names it. */
  accountId = 'a1';
  accountName = 'alice@example.test';
  mailboxes = new Map<string, Mailbox>();
  emails = new Map<string, Rec>();
  emailState = 0;
  log: { state: number; created: string[]; updated: string[]; destroyed: string[] }[] = [];
  /** Email ids whose updates the server rejects. */
  rejectUpdates = new Set<string>();
  /** Email ids whose destroy the server rejects. */
  rejectDestroys = new Set<string>();
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
  /** Parsed invitations served by CalendarEvent/parse, keyed by blob id. */
  parsedBlobs = new Map<string, CalendarEvent[]>();
  /** Whether the session advertises the calendars:parse capability. */
  parseSupported = true;
  failCalendarQueries = false;
  /** The arguments of every CalendarEvent/set received. */
  calendarSets: Record<string, unknown>[] = [];
  failCalendarSets = false;
  private nextCalendarEventId = 0;
  /** Each request's response waits for the next promise here, if any (for race tests). */
  holds: Promise<void>[] = [];
  identities = new Map<string, Identity>([['id1', identityRec('id1', 'Alice', 'alice@example.test')]]);
  identityState = 1;
  identityLog: { state: number; created: string[]; updated: string[]; destroyed: string[] }[] = [];
  /** Addresses Identity/set create accepts (Stalwart: the account's own addresses). */
  ownAddresses = ['alice@example.test'];
  private nextIdentityId = 2;
  vacation: VacationResponse = { id: 'singleton', isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null };
  vacationState = 1;
  /** Whether the account advertises urn:ietf:params:jmap:vacationresponse. */
  vacationSupported = true;
  /** Each request's `using`. */
  usings: string[][] = [];

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

  private createdEmails = 0;

  /** Blob ids of uploads (tests add them). Stalwart keeps an upload usable after a message has used it. */
  uploads = new Set<string>();

  /** A blob a new message may refer to: an upload, or a part of a message that still exists. */
  private blobExists(id: string): boolean {
    if (this.uploads.has(id)) return true;
    for (const e of this.emails.values()) if ((e.attachments ?? []).some((p) => p.blobId === id)) return true;
    return false;
  }

  /** A created email's parts as Stalwart stores them: every part gets a blob id of this message's own. Null: a blob is missing. */
  private storeParts(id: string, email: Partial<Rec>): Partial<Rec> | null {
    const textBody: EmailBodyPart[] = [];
    const htmlBody: EmailBodyPart[] = [];
    const attachments: EmailBodyPart[] = [];
    let n = 0;
    let missing = false;
    const leaf = (p: EmailBodyStructure) => {
      const part: EmailBodyPart = { partId: p.partId ?? String(n + 1), blobId: `${id}.p${++n}`, size: 0, type: p.type, name: p.name ?? null, cid: p.cid ?? null, disposition: p.disposition ?? null };
      if (p.partId) (p.type === 'text/html' ? htmlBody : textBody).push(part);
      else {
        if (!p.blobId || !this.blobExists(p.blobId)) missing = true;
        attachments.push(part);
      }
    };
    const walk = (p: EmailBodyStructure): void => (p.subParts ? p.subParts.forEach(walk) : leaf(p));
    if (email.bodyStructure) walk(email.bodyStructure);
    else for (const p of [...(email.textBody ?? []), ...(email.htmlBody ?? []), ...(email.attachments ?? [])]) leaf(p as EmailBodyStructure);
    if (missing) return null;
    const rest = { ...email };
    delete rest.bodyStructure;
    return { ...rest, textBody, htmlBody, attachments };
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

  handle(name: string, args: Record<string, unknown>, using: string[] = [VACATION]): [string, unknown] {
    this.calls.push(name);
    this.sent.push([name, args]);
    this.onCall?.(name, args);
    if (name.startsWith('VacationResponse/') && !using.includes(VACATION)) {
      return ['error', { type: 'unknownMethod', description: `Method ${name} requires capability ${VACATION}.` }];
    }
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
      case 'Identity/get': {
        const all = [...this.identities.values()];
        const list = (ids ? all.filter((i) => ids.includes(i.id)) : all).map((i) => structuredClone(i));
        return [name, { accountId: 'a1', state: `i${this.identityState}`, list, notFound: ids ? ids.filter((id) => !this.identities.has(id)) : [] }];
      }
      case 'Identity/changes': {
        const since = Number(String(args.sinceState).slice(1));
        const entries = this.identityLog.filter((l) => l.state > since);
        const uniq = (xs: string[]) => [...new Set(xs)];
        const destroyed = uniq(entries.flatMap((l) => l.destroyed));
        const created = uniq(entries.flatMap((l) => l.created)).filter((id) => !destroyed.includes(id));
        const updated = uniq(entries.flatMap((l) => l.updated)).filter((id) => !created.includes(id) && !destroyed.includes(id));
        return [name, { accountId: 'a1', oldState: args.sinceState, newState: `i${this.identityState}`, hasMoreChanges: false, created, updated, destroyed }];
      }
      case 'Identity/set':
        return [name, this.identitySet(args)];
      case 'VacationResponse/get':
        return [name, { accountId: 'a1', state: `v${this.vacationState}`, list: ids && !ids.includes('singleton') ? [] : [structuredClone(this.vacation)], notFound: (ids ?? []).filter((id) => id !== 'singleton') }];
      case 'VacationResponse/set':
        return [name, this.vacationSet(args)];
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
        if (args.expandRecurrences !== true) {
          // Not expanded: base events, matched on their zone-naive start (the real server compares UTC instants and handles recurrence).
          const inWindow = (e: CalendarEvent) => (!f.after || `${e.start}Z` >= f.after) && (!f.before || `${e.start}Z` < f.before);
          const ids = [...this.baseEvents.values()].filter(inWindow).map((e) => e.id).slice((args.position as number | undefined) ?? 0).slice(0, (args.limit as number | undefined) ?? Infinity);
          return [name, { accountId: 'a1', queryState: `ce${this.calendarEventState}`, canCalculateChanges: false, position: 0, ids }];
        }
        return [name, { accountId: 'a1', queryState: `ce${this.calendarEventState}`, canCalculateChanges: false, position: 0, ids: this.occurrences.filter(inRange).map((o) => o.id) }];
      }
      case 'CalendarEvent/parse': {
        const parsed: Record<string, CalendarEvent[]> = {};
        const notFound: string[] = [];
        for (const id of (args.blobIds as string[] | undefined) ?? []) {
          const evs = this.parsedBlobs.get(id);
          if (evs) parsed[id] = structuredClone(evs);
          else notFound.push(id);
        }
        return [name, { accountId: 'a1', parsed, notParsable: null, notFound: notFound.length ? notFound : null }];
      }
      case 'CalendarEvent/get': {
        const all = new Map<string, CalendarEvent>([...this.baseEvents, ...this.occurrences.map((o) => [o.id, o] as const)]);
        const list = [...new Set(ids ?? [])].map((id) => all.get(id)).filter((e): e is CalendarEvent => !!e).map((e) => structuredClone(e));
        return [name, { accountId: 'a1', state: `ce${this.calendarEventState}`, list, notFound: [] }];
      }
      case 'CalendarEvent/set': {
        this.calendarSets.push(structuredClone(args));
        if (this.failCalendarSets) return ['error', { type: 'serverFail', description: 'calendar store unavailable' }];
        const a = args as { create?: Record<string, CalendarEvent>; update?: Record<string, Record<string, unknown>>; destroy?: string[] };
        const created: Record<string, { id: string }> = {};
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string }> = {};
        const destroyed: string[] = [];
        const notDestroyed: Record<string, { type: string }> = {};
        for (const [key, ev] of Object.entries(a.create ?? {})) {
          const id = `n${++this.nextCalendarEventId}`;
          this.baseEvents.set(id, { ...structuredClone(ev), id });
          this.occurrences.push({ id: `${id}o`, baseEventId: id, calendarIds: ev.calendarIds, start: ev.start, utcStart: `${ev.start}Z` });
          created[key] = { id };
        }
        for (const [id, patch] of Object.entries(a.update ?? {})) {
          const base = this.baseEvents.get(id);
          if (!base) {
            notUpdated[id] = { type: 'notFound' };
            continue;
          }
          const next: Record<string, unknown> = { ...base, calendarIds: { ...base.calendarIds } };
          for (const [k, v] of Object.entries(patch)) {
            if (k.startsWith('calendarIds/')) {
              const calId = k.slice('calendarIds/'.length);
              if (v) (next.calendarIds as Record<string, boolean>)[calId] = true;
              else delete (next.calendarIds as Record<string, boolean>)[calId];
            } else next[k] = v;
          }
          this.baseEvents.set(id, next as unknown as CalendarEvent);
          for (const o of this.occurrences) {
            if (o.baseEventId !== id) continue;
            o.calendarIds = (next as unknown as CalendarEvent).calendarIds;
            if (typeof patch.start === 'string') {
              o.start = patch.start;
              o.utcStart = `${patch.start}Z`;
            }
          }
          updated[id] = null;
        }
        for (const id of a.destroy ?? []) {
          if (!this.baseEvents.delete(id)) {
            notDestroyed[id] = { type: 'notFound' };
            continue;
          }
          this.occurrences = this.occurrences.filter((o) => o.baseEventId !== id);
          destroyed.push(id);
        }
        this.calendarEventState++;
        const some = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
        return [name, {
          accountId: 'a1', oldState: null, newState: `ce${this.calendarEventState}`,
          created: some(created), updated: some(updated), destroyed: destroyed.length ? destroyed : null,
          notCreated: null, notUpdated: some(notUpdated), notDestroyed: some(notDestroyed),
        }];
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
        // Drafts: the composer saves by creating a new email, then destroying the ones it replaces.
        const created: Record<string, { id: string; threadId: string }> = {};
        const notCreated: Record<string, { type: string; description: string }> = {};
        for (const [cid, email] of Object.entries((args.create ?? {}) as Record<string, Partial<Rec>>)) {
          const id = `n${this.createdEmails + 1}`;
          const stored = this.storeParts(id, email);
          if (!stored) {
            notCreated[cid] = { type: 'blobNotFound', description: 'blobId does not exist on this server.' };
            continue;
          }
          this.createdEmails++;
          this.addEmail({ receivedAt: new Date().toISOString(), ...stored, id, threadId: `t-${id}` } as Rec);
          created[cid] = { id, threadId: `t-${id}` };
        }
        // As Stalwart: a failed create does not stop the destroy.
        const destroyed: string[] = [];
        const notDestroyed: Record<string, { type: string }> = {};
        for (const id of (args.destroy ?? []) as string[]) {
          if (!this.emails.has(id)) notDestroyed[id] = { type: 'notFound' };
          else if (this.rejectDestroys.has(id)) notDestroyed[id] = { type: 'forbidden' };
          else {
            this.emails.delete(id);
            destroyed.push(id);
          }
        }
        if (destroyed.length) this.bump({ destroyed });
        return [name, {
          accountId: 'a1', oldState: null, newState: `e${this.emailState}`, created, destroyed, updated,
          notCreated: Object.keys(notCreated).length ? notCreated : null,
          notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
          notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
        }];
      }
    }
    return ['error', { type: 'unknownMethod' }];
  }

  private identitySet(args: Record<string, unknown>) {
    const bytes = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : '').length;
    const invalid = (prop: string, description = 'Field could not be set.') => ({ type: 'invalidProperties', description, properties: [prop] });
    const limits: [keyof Identity, number][] = [['name', 254], ['textSignature', 2047], ['htmlSignature', 2047]];
    const tooLong = (p: Partial<Identity>) => limits.find(([k, max]) => bytes(p[k]) > max)?.[0];
    const created: Record<string, { id: string }> = {};
    const notCreated: Record<string, unknown> = {};
    for (const [cid, p] of Object.entries((args.create ?? {}) as Record<string, Partial<Identity>>)) {
      const email = typeof p.email === 'string' ? p.email.toLowerCase() : '';
      const long = tooLong(p);
      if (!p.email) notCreated[cid] = invalid('email', 'Missing e-mail address.');
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !email.endsWith('@example.test')) notCreated[cid] = invalid('email', 'Invalid e-mail address.');
      else if (!this.ownAddresses.includes(email)) notCreated[cid] = invalid('email', 'E-mail address not configured for this account.');
      else if (long) notCreated[cid] = invalid(long);
      else if (this.identities.size >= 20) notCreated[cid] = { type: 'overQuota', description: 'There are too many identities, please delete some before adding a new one.' };
      else {
        const id = `id${this.nextIdentityId++}`;
        this.identities.set(id, { ...identityRec(id, p.name ?? '', email), textSignature: p.textSignature ?? '', htmlSignature: p.htmlSignature ?? '' });
        created[cid] = { id };
      }
    }
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, unknown> = {};
    for (const [id, p] of Object.entries((args.update ?? {}) as Record<string, Partial<Identity>>)) {
      const cur = this.identities.get(id);
      const long = tooLong(p);
      const unknown = Object.keys(p).find((k) => !['name', 'textSignature', 'htmlSignature', 'replyTo', 'bcc', 'email'].includes(k));
      if (!cur) notUpdated[id] = { type: 'notFound' };
      else if (unknown) notUpdated[id] = invalid(unknown, unknown.includes('/') ? 'Field could not be set.' : 'Invalid property.');
      else if ('email' in p) notUpdated[id] = invalid('email');
      else if (long) notUpdated[id] = invalid(long);
      else {
        Object.assign(cur, p, { textSignature: p.textSignature === undefined ? cur.textSignature : (p.textSignature ?? '') });
        updated[id] = null;
      }
    }
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    for (const id of (args.destroy ?? []) as string[]) {
      if (this.identities.delete(id)) destroyed.push(id);
      else notDestroyed[id] = { type: 'notFound' };
    }
    const change = { created: Object.values(created).map((c) => c.id), updated: Object.keys(updated), destroyed };
    if (change.created.length || change.updated.length || change.destroyed.length) {
      this.identityState++;
      this.identityLog.push({ state: this.identityState, ...change });
    }
    const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : undefined);
    // Stalwart's Identity/set response has no oldState.
    return {
      accountId: 'a1', newState: `i${this.identityState}`,
      created: orNull(created), updated: orNull(updated), destroyed: destroyed.length ? destroyed : undefined,
      notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
    };
  }

  private vacationSet(args: Record<string, unknown>) {
    const oldState = `v${this.vacationState}`;
    const bytes = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : '').length;
    const invalid = (prop: string) => ({ type: 'invalidProperties', description: 'Field could not be set.', properties: [prop] });
    const singleton = { type: 'singleton', description: 'Singletons cannot be created or destroyed.' };
    const notCreated = Object.fromEntries(Object.keys((args.create ?? {}) as object).map((k) => [k, singleton]));
    const notDestroyed = Object.fromEntries(((args.destroy ?? []) as string[]).map((k) => [k, singleton]));
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, unknown> = {};
    const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    for (const [id, p] of Object.entries((args.update ?? {}) as Record<string, Partial<VacationResponse>>)) {
      if (id !== 'singleton') {
        notUpdated[id] = { type: 'notFound', description: 'ID not found.' };
        continue;
      }
      const next = { ...this.vacation, ...p };
      const unknown = Object.keys(p).find((k) => !['isEnabled', 'fromDate', 'toDate', 'subject', 'textBody', 'htmlBody'].includes(k));
      const badDate = (['fromDate', 'toDate'] as const).find((k) => typeof p[k] === 'string' && !DATE_TIME.test(p[k]!));
      // Without a text part the server derives one from the HTML; it counts against the budget.
      const text = next.textBody ?? next.htmlBody;
      const err = unknown ?? badDate
        ?? (bytes(next.subject) > 511 ? 'subject' : undefined)
        ?? (bytes(next.textBody) > 2047 ? 'textBody' : undefined)
        ?? (bytes(next.htmlBody) > 2047 || bytes(text) + bytes(next.htmlBody) > 3504 ? 'htmlBody' : undefined);
      if (err) {
        notUpdated[id] = invalid(err);
        continue;
      }
      for (const k of ['fromDate', 'toDate'] as const) if (typeof next[k] === 'string') next[k] = new Date(next[k]!).toISOString().replace(/\.\d{3}Z$/, 'Z');
      this.vacation = next;
      updated[id] = null;
    }
    if (Object.keys(updated).length) this.vacationState++;
    const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : undefined);
    return {
      accountId: 'a1', oldState, newState: `v${this.vacationState}`,
      updated: orNull(updated), notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
    };
  }

  /** Resolve back-references (RFC 8620 §3.7) including `*` path segments. */
  /** Resolve a call's back-references against earlier answers, then handle it. */
  dispatch(name: string, args: Record<string, unknown>, done: Map<string, Invocation>, using: string[]): [string, unknown] {
    return this.handle(name, this.resolve(args, done), using);
  }

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
    const fake = this;
    const session: Session = {
      get capabilities() {
        return fake.parseSupported ? { [CALENDARS_PARSE]: {} } : {};
      },
      accounts: { a1: { name: 'alice@example.test', isPersonal: true, isReadOnly: false, accountCapabilities: this.vacationSupported ? { [VACATION]: {} } : {} } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1', 'urn:ietf:params:jmap:calendars': 'a1' }, username: 'alice@example.test',
      apiUrl: 'http://fake/jmap', downloadUrl: '', uploadUrl: '', eventSourceUrl: '', state: 's',
    };
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { using: string[]; methodCalls: Invocation[] };
      this.usings.push(body.using);
      const done = new Map<string, Invocation>();
      const responses: Invocation[] = [];
      for (const [name, args, id] of body.methodCalls) {
        const [rname, result] = this.handle(name, this.resolve(args, done), body.using);
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

function identityRec(id: string, name: string, email: string): Identity {
  return { id, name, email, replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: true };
}

/** One session over several fakes: the first is the user's own account, the rest are shared ones. */
export function fakeClient(fakes: FakeJmap[]): JmapClient {
  const first = fakes[0]!;
  const caps = (f: FakeJmap) => ({ 'urn:ietf:params:jmap:mail': {}, ...(f.vacationSupported ? { [VACATION]: {} } : {}) });
  const session: Session = {
    capabilities: {},
    accounts: Object.fromEntries(fakes.map((f, i) => [f.accountId, { name: f.accountName, isPersonal: i === 0, isReadOnly: false, accountCapabilities: caps(f) }])),
    primaryAccounts: { 'urn:ietf:params:jmap:mail': first.accountId, 'urn:ietf:params:jmap:calendars': first.accountId },
    username: first.accountName,
    apiUrl: 'http://fake/jmap', downloadUrl: '', uploadUrl: '', eventSourceUrl: '', state: 's',
  };
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { using: string[]; methodCalls: Invocation[] };
    const done = new Map<string, Invocation>();
    const responses: Invocation[] = [];
    for (const [name, args, id] of body.methodCalls) {
      const fake = fakes.find((f) => f.accountId === args.accountId) ?? first;
      fake.usings.push(body.using);
      const [rname, result] = fake.dispatch(name, args, done, body.using);
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
