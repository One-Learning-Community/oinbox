import { A } from '@solidjs/router';
import { createEffect, createMemo, For, on, onCleanup, Show } from 'solid-js';
import { useApp } from '../app/context';
import { listDate } from '../mail/format';
import { snippetHtml } from '../mail/sanitize';
import { queryKey } from '../sync/engine';
import { resolveView, threadRow, type View } from '../sync/selectors';
import { Icon } from './icons';
import { createMediaQuery, createVirtualList } from './virtual';

export function ThreadList(props: { view: View; hidden: boolean }) {
  const { engine, toast } = useApp();
  const key = createMemo(() => engine.openQuery(props.view.spec));
  const query = () => engine.state.queries[key()];
  // Keep the inbox query live (and cached) when navigating elsewhere; drop others.
  const inboxKey = () => {
    const v = resolveView('inbox', engine.state.mailboxes);
    return v ? queryKey(v.spec) : '';
  };
  createEffect(on(key, (k, prev) => {
    if (prev && prev !== k) engine.closeQuery(prev, (x) => x === inboxKey());
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

  // Load whatever the viewport needs (plus a page of lookahead).
  createEffect(() => {
    const k = key();
    const list = items();
    const first = list[0]?.index ?? 0;
    const last = (list[list.length - 1]?.index ?? 0) + 1;
    query()?.total; // re-run once the total is known
    engine.ensureRange(k, first, last + 25).catch((e) => toast(`Couldn't load messages: ${String(e)}`, 'error'));
  });

  const me = createMemo(() => engine.myAddresses());

  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const prefetch = (threadId: string) => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => void engine.loadThread(threadId).catch(() => undefined), 80);
  };
  onCleanup(() => clearTimeout(hoverTimer));

  const rangeLabel = () => {
    const total = query()?.total;
    return total ? `${total.toLocaleString()} conversation${total === 1 ? '' : 's'}` : '';
  };

  return (
    <section class="list-pane" style={{ display: props.hidden ? 'none' : 'flex', 'flex-direction': 'column', flex: '1', 'min-height': '0' }}>
      <div class="toolbar">
        <button class="icon-btn" title="Refresh" onClick={() => void engine.catchUp()}>
          <Icon name="refresh" />
        </button>
        <Show when={props.view.search?.errors.length}>
          <span class="error" style={{ 'font-size': '13px' }}>{props.view.search!.errors.join('; ')}</span>
        </Show>
        <span class="range">{rangeLabel()}</span>
      </div>
      <div class="list-scroll" ref={scrollEl} role="list" aria-label={props.view.title}>
        <Show when={query()?.total === 0}>
          <div class="list-empty">{props.view.search ? 'No messages matched your search.' : `No conversations in ${props.view.title}.`}</div>
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
                      classList={{ unread: r().unread }}
                      style={{ transform: `translateY(${item.start}px)` }}
                      role="listitem"
                      data-thread-id={r().threadId}
                      onMouseEnter={() => prefetch(r().threadId)}
                      onFocus={() => prefetch(r().threadId)}
                    >
                      <span class="icon-btn star" classList={{ on: r().starred }} aria-label={r().starred ? 'Starred' : 'Not starred'}>
                        <Icon name={r().starred ? 'starFilled' : 'star'} />
                      </span>
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
