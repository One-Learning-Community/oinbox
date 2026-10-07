import { createSignal, type Accessor } from 'solid-js';
import { createStore, reconcile, type SetStoreFunction } from 'solid-js/store';
import type { ToastFn } from '../app/actions';
import { UnauthorizedError, type JmapClient } from '../jmap/client';
import { CALENDARS, CORE, type Calendar, type CalendarEvent, type CalendarEventSetArgs, type Id, type StateChange } from '../jmap/types';
import { addRangeCalls, rangeKey, toDisplayEvents, type DisplayEvent, type Range } from './instances';
import { loadHidden, saveHidden } from './prefs';

export interface CalendarState {
  calendars: Record<Id, Calendar>;
  /** Events of the visible range (all calendars; hiding is applied by the view). */
  events: DisplayEvent[];
  range: Range | null;
  loading: boolean;
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/** Recently viewed ranges kept in memory, least recently used dropped first. */
const CACHE_SIZE = 8;

/**
 * Calendar data for the visible date range. No local mirror: the server expands recurrences,
 * and any CalendarEvent state change clears the cache and refetches what is on screen.
 */
export class CalendarStore {
  readonly state: CalendarState;
  private readonly set: SetStoreFunction<CalendarState>;
  private cache = new Map<string, DisplayEvent[]>();
  /** Bumped whenever the cache is cleared; responses from an older generation aren't cached. */
  private generation = 0;
  /** Bumped per show(); only the newest request may change what is on screen. */
  private seq = 0;
  private eventState: string | null = null;
  private calendarState: string | null = null;
  private failing = false;
  private readonly hiddenSignal = createSignal<ReadonlySet<Id>>(loadHidden());
  /** Calendars this browser hides (a display preference, not Calendar.isVisible). */
  readonly hidden: Accessor<ReadonlySet<Id>> = this.hiddenSignal[0];

  constructor(
    private readonly client: JmapClient,
    private readonly toast: ToastFn,
    private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {
    const [state, set] = createStore<CalendarState>({ calendars: {}, events: [], range: null, loading: false });
    this.state = state;
    this.set = set;
  }

  /** The primary calendars account, or undefined when the server has no JMAP Calendars. */
  get accountId(): Id | undefined {
    return this.client.hasSession ? this.client.session.primaryAccounts[CALENDARS] : undefined;
  }

  async loadCalendars(): Promise<void> {
    const accountId = this.accountId;
    if (!accountId) return;
    const b = this.client.batch();
    const get = b.call('Calendar/get', { accountId });
    const res = (await this.client.send(b, [CORE, CALENDARS])).get(get);
    this.calendarState = res.state;
    this.set('calendars', reconcile(Object.fromEntries(res.list.map((c) => [c.id, c]))));
  }

  show(range: Range): Promise<void> {
    if (!this.accountId) return Promise.resolve();
    // A copy: Solid's setter merges a new object into the one stored before, which would
    // otherwise be the caller's previous range object.
    this.set('range', { ...range });
    const key = rangeKey(range);
    const hit = this.cache.get(key);
    if (hit) {
      this.remember(key, hit);
      this.seq++; // a slower fetch for another range must not replace this
      this.set({ events: hit, loading: false });
      return Promise.resolve();
    }
    return this.fetch(range);
  }

  /** Drop the cache and refetch the visible range. */
  refresh(): Promise<void> {
    this.cache.clear();
    this.generation++;
    const range = this.state.range;
    return range ? this.fetch(range) : Promise.resolve();
  }

  onStateChange(change: StateChange): void {
    const accountId = this.accountId;
    if (!accountId) return;
    const types = change.changed[accountId];
    if (!types) return;
    if (types.Calendar && types.Calendar !== this.calendarState) void this.loadCalendars().catch(() => undefined);
    if (types.CalendarEvent && types.CalendarEvent !== this.eventState) void this.refresh();
  }

  /** After a push (re)connect, changes may have been missed. */
  onConnected(): void {
    if (!this.accountId) return;
    void this.loadCalendars().catch(() => undefined);
    void this.refresh();
  }

  /** Create one event. Never emails anyone: slice 2 has no way to add guests. */
  createEvent(event: Partial<CalendarEvent>): Promise<WriteResult> {
    return this.write({ create: { new: event } }, false, 'new');
  }

  /** `baseEventId` is the event's (or series') id, not an occurrence id. */
  updateEvent(baseEventId: Id, patch: Record<string, unknown>, notify: boolean): Promise<WriteResult> {
    return this.write({ update: { [baseEventId]: patch } }, notify, baseEventId);
  }

  deleteEvent(baseEventId: Id, notify: boolean): Promise<WriteResult> {
    return this.write({ destroy: [baseEventId] }, notify, baseEventId);
  }

  /** One CalendarEvent/set. The refetch starts here; the push event that follows is then a no-op. */
  private async write(args: Pick<CalendarEventSetArgs, 'create' | 'update' | 'destroy'>, notify: boolean, key: string): Promise<WriteResult> {
    const accountId = this.accountId;
    if (!accountId) return { ok: false, error: 'Calendars are not available.' };
    try {
      const b = this.client.batch();
      const call = b.call('CalendarEvent/set', { accountId, sendSchedulingMessages: notify, ...args });
      const res = (await this.client.send(b, [CORE, CALENDARS])).get(call);
      const err = res.notCreated?.[key] ?? res.notUpdated?.[key] ?? res.notDestroyed?.[key];
      void this.refresh();
      if (err) {
        return { ok: false, error: err.type === 'notFound' ? 'That event no longer exists.' : (err.description ?? `The server refused the change (${err.type}).`) };
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      return { ok: false, error: (e as Error).message };
    }
  }

  toggleHidden(id: Id): void {
    const next = new Set(this.hidden());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.hiddenSignal[1](next);
    saveHidden(next);
  }

  private async fetch(range: Range): Promise<void> {
    const accountId = this.accountId!;
    const my = ++this.seq;
    const generation = this.generation;
    this.set('loading', true);
    try {
      const b = this.client.batch();
      const calls = addRangeCalls(b, accountId, range, this.timeZone);
      const res = await this.client.send(b, [CORE, CALENDARS]);
      res.get(calls.query); // surfaces a failed query instead of a dangling back-reference
      const instances = res.get(calls.instances);
      const events = toDisplayEvents(instances.list, res.get(calls.bases).list);
      if (generation === this.generation) {
        // Every other cached range was fetched at an older state (e.g. an edit from another
        // device whose push hasn't arrived yet, and will then be ignored as already seen).
        if (this.eventState !== null && instances.state !== this.eventState) {
          this.cache.clear();
          this.generation++;
        }
        this.remember(rangeKey(range), events);
        this.eventState = instances.state;
      }
      if (my === this.seq) {
        this.set('events', events);
        this.failing = false;
      }
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      if (!this.failing) {
        this.failing = true;
        this.toast(`Couldn't load the calendar: ${(e as Error).message}`, 'error');
      }
    } finally {
      if (my === this.seq) this.set('loading', false);
    }
  }

  private remember(key: string, events: DisplayEvent[]): void {
    this.cache.delete(key);
    this.cache.set(key, events);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
  }
}
