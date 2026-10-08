import { A, useNavigate } from '@solidjs/router';
import { createEffect, createMemo, For, on, onCleanup, Show } from 'solid-js';
import { useApp } from '../app/context';
import { listDate } from '../mail/format';
import { snippetHtml } from '../mail/sanitize';
import { queryKey } from '../sync/engine';
import { resolveView, threadRow, type View } from '../sync/selectors';
import { Icon } from './icons';
import { createMediaQuery, createVirtualList } from './virtual';
import { logUnexpected } from '../sync/connection';

export function ThreadList(props: { view: View; hidden: boolean }) {
  const { engine, toast, actions, nav, composers } = useApp();
  const navigate = useNavigate();
  const key = createMemo(() => engine.openQuery(props.view.spec));
  const query = () => engine.state.queries[key()];

  // Keep the inbox query live (and cached) when navigating elsewhere; drop others.
  const inboxKey = () => {
    const v = resolveView('inbox', engine.state.mailboxes);
    return v ? queryKey(v.spec) : '';
  };
  createEffect(on(key, (k, prev) => {
    if (prev && prev !== k) engine.closeQuery(prev, (x) => x === inboxKey());
    nav.setCursor(0);
    nav.clearSelection();
  }));

  let scrollEl: HTMLDivElement | undefined;
  const mobile = createMediaQuery('(max-width: 800px)');
  const rowHeight = () => (mobile() ? 76 : 40);
  const { items, totalSize, virtualizer } = createVirtualList({
    count: () => query()?.total ?? 0,
    scrollElement: () => scrollEl,
    rowHeight,
  });

  // Reset scroll when switching mailboxes.
  createEffect(on(key, () => virtualizer.scrollToOffset(0)));

  // Load whatever the viewport needs (plus half a page of lookahead).
  createEffect(() => {
    const k = key();
    const list = items();
    const first = list[0]?.index ?? 0;
    const last = (list[list.length - 1]?.index ?? 0) + 1;
    void query()?.total; // re-run once the total is known
    engine.ensureRange(k, first, last + 25).catch((e) => toast(`Couldn't load messages: ${String(e)}`, 'error'));
  });

  const threadIdAt = (i: number) => {
    const id = query()?.slots[i];
    return id ? (engine.state.emails[id]?.threadId ?? null) : null;
  };

  // Expose the list to keyboard shortcuts.
  createEffect(() => {
    nav.setList({
      view: props.view,
      count: () => query()?.total ?? 0,
      threadIdAt,
      indexOfThread: (tid) => (query()?.slots ?? []).findIndex((id) => !!id && engine.state.emails[id]?.threadId === tid),
      scrollToIndex: (i) => virtualizer.scrollToIndex(i, { align: 'auto' }),
    });
  });
  onCleanup(() => nav.setList(null));

  // Keep the cursor inside the list as rows disappear (archive, delete).
  createEffect(() => {
    const total = query()?.total ?? 0;
    if (nav.cursor() >= total && total > 0) nav.setCursor(total - 1);
  });

  const me = createMemo(() => engine.myAddresses());

  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const prefetch = (threadId: string) => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => void engine.loadThread(threadId).catch(logUnexpected), 80);
  };
  onCleanup(() => clearTimeout(hoverTimer));
  // Prefetch the cursor row so "o" opens instantly.
  createEffect(() => {
    const tid = threadIdAt(nav.cursor());
    if (tid && !props.hidden) prefetch(tid);
  });

  /** Drafts-only threads open in the composer (Gmail); everything else opens the conversation. */
  const openRow = async (threadId: string) => {
    if (props.view.role === 'drafts') {
      await engine.loadThread(threadId).catch(logUnexpected);
      const emails = engine.threadEmails([threadId]);
      if (emails.length && emails.every((e) => e.keywords?.$draft)) {
        const latest = emails.sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))[0]!;
        composers.openDraft(latest);
        return;
      }
    }
    navigate(`/${props.view.slug}/t/${threadId}`);
  };

  const selection = () => [...nav.selected()];
  const loadedThreadIds = () =>
    (query()?.slots ?? []).map((id) => (id ? engine.state.emails[id]?.threadId : undefined)).filter((x): x is string => !!x);
  const allSelected = () => nav.selected().size > 0 && nav.selected().size >= loadedThreadIds().length;

  const rangeLabel = () => {
    const total = query()?.total;
    return total ? `${total.toLocaleString()} conversation${total === 1 ? '' : 's'}` : '';
  };

  return (
    <section class="list-pane" style={{ display: props.hidden ? 'none' : 'flex', 'flex-direction': 'column', flex: '1', 'min-height': '0' }}>
      <div class="toolbar">
        <label class="icon-btn" title="Select all loaded">
          <input
            type="checkbox"
            checked={allSelected()}
            ref={(el) => createEffect(() => (el.indeterminate = nav.selected().size > 0 && !allSelected()))}
            onChange={(e) => nav.setSelected(new Set(e.currentTarget.checked ? loadedThreadIds() : []))}
          />
        </label>
        <Show
          when={nav.selected().size}
          fallback={
            <button class="icon-btn" title="Refresh" onClick={() => void engine.catchUp()}>
              <Icon name="refresh" />
            </button>
          }
        >
          <Show when={props.view.role !== 'archive'}>
            <button class="icon-btn" title="Archive (e)" onClick={() => { void actions.archive(selection()).then((ok) => ok && nav.clearSelection()); }}>
              <Icon name="archive" />
            </button>
          </Show>
          <button class="icon-btn" title="Report spam (!)" onClick={() => { void actions.spam(selection()).then((ok) => ok && nav.clearSelection()); }}>
            <Icon name="junk" />
          </button>
          <button class="icon-btn" title="Delete (#)" onClick={() => { void actions.trash(selection()).then((ok) => ok && nav.clearSelection()); }}>
            <Icon name="trash" />
          </button>
          <button class="icon-btn" title="Mark as read (Shift+I)" onClick={() => { void actions.markRead(selection()); nav.clearSelection(); }}>
            <Icon name="read" />
          </button>
          <button class="icon-btn" title="Mark as unread (Shift+U)" onClick={() => { void actions.markUnread(selection()); nav.clearSelection(); }}>
            <Icon name="unread" />
          </button>
          <button class="icon-btn" title="Move to (v)" onClick={() => nav.setPicker({ kind: 'move', threadIds: selection() })}>
            <Icon name="move" />
          </button>
          <button class="icon-btn" title="Label (l)" onClick={() => nav.setPicker({ kind: 'label', threadIds: selection() })}>
            <Icon name="label" />
          </button>
        </Show>
        <Show when={props.view.search?.errors.length}>
          <span class="error" style={{ 'font-size': '13px' }}>{props.view.search!.errors.join('; ')}</span>
        </Show>
        <span class="range">{rangeLabel()}</span>
      </div>
      <div class="list-scroll" ref={scrollEl} role="list" aria-label={props.view.title}>
        <Show when={query()?.total === 0}>
          <div class="list-empty">
            {props.view.search ? 'No messages matched your search.' : `No conversations in ${props.view.title}.`}
          </div>
        </Show>
        <Show when={query()?.error && !query()?.total}>
          <div class="list-empty error">Couldn't load this mailbox. {query()?.error}</div>
        </Show>
        <div style={{ height: `${totalSize()}px`, position: 'relative' }}>
          <For each={items()}>
            {(item) => {
              const id = () => query()?.slots[item.index] ?? null;
              const row = createMemo(() => {
                const eid = id();
                return eid ? threadRow(engine.state, eid, { viewing: props.view.mailboxId, me: me() }) : null;
              });
              return (
                <Show
                  when={row()}
                  fallback={
                    <div class="row placeholder" style={{ transform: `translateY(${item.start}px)` }}>
                      <span class="line" />
                    </div>
                  }
                >
                  {(r) => (
                    <A
                      href={`/${props.view.slug}/t/${r().threadId}`}
                      class="row"
                      classList={{ unread: r().unread, cursor: nav.cursor() === item.index, selected: nav.selected().has(r().threadId) }}
                      style={{ transform: `translateY(${item.start}px)` }}
                      role="listitem"
                      data-thread-id={r().threadId}
                      onMouseEnter={() => prefetch(r().threadId)}
                      onFocus={() => prefetch(r().threadId)}
                      onClick={(e) => {
                        nav.setCursor(item.index);
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        void openRow(r().threadId);
                      }}
                    >
                      <span
                        class="row-check"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          nav.toggleSelected(r().threadId);
                        }}
                      >
                        <input type="checkbox" tabindex="-1" checked={nav.selected().has(r().threadId)} aria-label="Select conversation" />
                      </span>
                      <button
                        type="button"
                        class="icon-btn star"
                        classList={{ on: r().starred }}
                        aria-label={r().starred ? 'Unstar' : 'Star'}
                        aria-pressed={r().starred}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void actions.toggleStar([r().threadId]);
                        }}
                      >
                        <Icon name={r().starred ? 'starFilled' : 'star'} />
                      </button>
                      <span class="who">
                        <For each={r().participants}>
                          {(p, i) => (
                            <>
                              {i() > 0 && !p.gap && !r().participants[i() - 1]?.gap ? ', ' : ' '}
                              <span classList={{ u: p.unread, draft: p.draft }}>{p.label}</span>
                            </>
                          )}
                        </For>
                        <Show when={r().count > 1}>
                          <span class="n">{r().count}</span>
                        </Show>
                      </span>
                      <span class="line">
                        <For each={r().labels}>{(l) => <span class="chip">{l.name}</span>}</For>
                        <Show
                          when={query()?.snippetMap[r().emailId]}
                          fallback={
                            <>
                              <span class="subject">{r().subject}</span>
                              <Show when={r().preview}> — {r().preview}</Show>
                            </>
                          }
                        >
                          {(sn) => (
                            <>
                              <span class="subject" innerHTML={sn().subject ? snippetHtml(sn().subject!) : r().subject} />
                              {' — '}
                              <span innerHTML={sn().preview ? snippetHtml(sn().preview!) : r().preview} />
                            </>
                          )}
                        </Show>
                      </span>
                      <Show when={r().hasAttachment}>
                        <Icon name="clip" class="clip" />
                      </Show>
                      <span class="date">{listDate(r().date)}</span>
                    </A>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </div>
    </section>
  );
}
