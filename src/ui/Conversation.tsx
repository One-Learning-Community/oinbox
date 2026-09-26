import { useNavigate } from '@solidjs/router';
import { createEffect, createMemo, createResource, createSignal, For, lazy, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { useApp, type App } from '../app/context';
import type { EmailAddress, EmailBodyPart, Id } from '../jmap/types';
import { avatarColor, fileSize, fullDate, listDate } from '../mail/format';
import { displayName } from '../mail/participants';
import type { EmailRec } from '../sync/engine';
import { hiddenMailboxIds, isHidden, type View } from '../sync/selectors';
import { Icon } from './icons';
import { MessageBody } from './MessageBody';

const ComposerView = lazy(() => import('./ComposerView').then((m) => ({ default: m.ComposerView })));

type Item = { kind: 'msg'; email: EmailRec } | { kind: 'older'; count: number };

export function Conversation(props: { view: View; threadId: Id }) {
  const { engine, toast, actions, nav, composers } = useApp();
  const navigate = useNavigate();

  createEffect(() => nav.setOpenThread(props.threadId));
  onCleanup(() => nav.setOpenThread(null));

  const [loaded] = createResource(
    () => props.threadId,
    (id) => engine.loadThread(id).then(() => true).catch((e) => {
      toast(`Couldn't open conversation: ${String(e)}`, 'error');
      return false;
    }),
  );

  const [showDeleted, setShowDeleted] = createSignal(false);
  const [showOlder, setShowOlder] = createSignal(false);
  const [expanded, setExpanded] = createSignal(new Set<Id>());
  let known = new Set<Id>();

  const all = createMemo(() => {
    const t = engine.state.threads[props.threadId];
    if (!t) return [];
    return t.emailIds
      .map((id) => engine.state.emails[id])
      .filter((e): e is EmailRec => !!e && !!engine.state.bodies[e.id])
      .sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''));
  });
  const hidden = createMemo(() => hiddenMailboxIds(engine.state.mailboxes, props.view.mailboxId));

  // Opening a conversation marks it read (Gmail), once per open.
  createEffect(on(() => [props.threadId, loaded()] as const, ([tid, ok]) => {
    if (!ok) return;
    const unread = engine.threadEmails([tid]).filter((e) => !e.keywords?.$seen && !isHidden(e, hidden()));
    if (unread.length) void actions.markRead([tid]);
  }));
  const deletedCount = createMemo(() => all().filter((e) => isHidden(e, hidden())).length);
  const messages = createMemo(() => (showDeleted() ? all() : all().filter((e) => !isHidden(e, hidden()))));

  // Reset per-thread UI state.
  createEffect(on(() => props.threadId, () => {
    known = new Set();
    setExpanded(new Set<Id>());
    setShowOlder(false);
    setShowDeleted(false);
  }));

  // Expand unread messages and the latest; auto-expand messages that arrive while open.
  createEffect(() => {
    const list = messages();
    if (!list.length) return;
    const next = new Set(expanded());
    const first = known.size === 0;
    for (const e of list) {
      if (known.has(e.id)) continue;
      known.add(e.id);
      if (!first || !e.keywords?.$seen) next.add(e.id);
    }
    if (first) next.add(list[list.length - 1]!.id);
    setExpanded(next);
  });

  const toggle = (id: Id) => {
    const next = new Set(expanded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  // Fold runs of 4+ collapsed messages into "N older messages", keeping the run's first message.
  const items = createMemo<Item[]>(() => {
    const list = messages();
    const out: Item[] = [];
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j < list.length && !expanded().has(list[j]!.id)) j++;
      const run = j - i;
      if (run >= 4 && !showOlder()) {
        out.push({ kind: 'msg', email: list[i]! });
        out.push({ kind: 'older', count: run - 2 });
        out.push({ kind: 'msg', email: list[j - 1]! });
      } else {
        for (let k = i; k < j; k++) out.push({ kind: 'msg', email: list[k]! });
      }
      if (j < list.length) out.push({ kind: 'msg', email: list[j]! });
      i = j + 1;
    }
    return out;
  });

  const inlineComposer = () => composers.list().find((c) => c.threadId === props.threadId && c.mode !== 'new');

  const subject = () => messages()[0]?.subject || all()[0]?.subject || '(no subject)';
  const labels = createMemo(() => {
    const ids = new Set<Id>();
    for (const e of messages()) for (const id of Object.keys(e.mailboxIds ?? {})) ids.add(id);
    return [...ids]
      .map((id) => engine.state.mailboxes[id])
      .filter((m) => m && (!m.role || m.role === 'inbox'))
      .map((m) => (m!.role === 'inbox' ? 'Inbox' : m!.name));
  });

  return (
    <section class="conv-pane" style={{ display: 'flex', 'flex-direction': 'column', flex: '1', 'min-height': '0' }}>
      <div class="toolbar">
        <button class="icon-btn" title="Back to list (u)" onClick={() => navigate(`/${props.view.slug}`)}>
          <Icon name="back" />
        </button>
        <Show when={props.view.role !== 'archive'}>
          <button class="icon-btn" title="Archive (e)" onClick={() => { actions.archive([props.threadId]); navigate(`/${props.view.slug}`); }}>
            <Icon name="archive" />
          </button>
        </Show>
        <button class="icon-btn" title="Report spam (!)" onClick={() => { actions.spam([props.threadId]); navigate(`/${props.view.slug}`); }}>
          <Icon name="junk" />
        </button>
        <button class="icon-btn" title="Delete (#)" onClick={() => { actions.trash([props.threadId]); navigate(`/${props.view.slug}`); }}>
          <Icon name="trash" />
        </button>
        <button class="icon-btn" title="Mark as unread (Shift+U)" onClick={() => { void actions.markUnread([props.threadId]); navigate(`/${props.view.slug}`); }}>
          <Icon name="unread" />
        </button>
        <button class="icon-btn" title="Move to (v)" onClick={() => nav.setPicker({ kind: 'move', threadIds: [props.threadId] })}>
          <Icon name="move" />
        </button>
        <button class="icon-btn" title="Label (l)" onClick={() => nav.setPicker({ kind: 'label', threadIds: [props.threadId] })}>
          <Icon name="label" />
        </button>
      </div>
      <div class="conv">
        <Switch>
          <Match when={!messages().length && loaded.loading}>
            <div class="list-empty">Loading…</div>
          </Match>
          <Match when={!messages().length && !deletedCount()}>
            <div class="list-empty">This conversation is no longer available.</div>
          </Match>
          <Match when={true}>
            <div class="conv-head">
              <h1>
                {subject()}
                <For each={labels()}>{(l) => <span class="chip">{l}</span>}</For>
              </h1>
            </div>
            <For each={items()}>
              {(item) =>
                item.kind === 'older' ? (
                  <div class="older-pill" role="button" tabindex="0" onClick={() => setShowOlder(true)} onKeyDown={(e) => e.key === 'Enter' && setShowOlder(true)}>
                    <span>{item.count}</span> older messages
                  </div>
                ) : (
                  <Message email={item.email} expanded={expanded().has(item.email.id)} onToggle={() => toggle(item.email.id)} />
                )
              }
            </For>
            <Show when={deletedCount() > 0 && !showDeleted()}>
              <div class="deleted-link">
                {deletedCount()} deleted message{deletedCount() === 1 ? '' : 's'} in this conversation.{' '}
                <button type="button" onClick={() => setShowDeleted(true)}>
                  View
                </button>
              </div>
            </Show>
            <Show when={inlineComposer()} fallback={<ReplyBar threadId={props.threadId} />}>
              {(c) => <ComposerView composer={c()} inline />}
            </Show>
          </Match>
        </Switch>
      </div>
    </section>
  );
}

function recipients(e: EmailRec, me: Set<string>): string {
  const addrs: EmailAddress[] = [...(e.to ?? []), ...(e.cc ?? [])];
  if (!addrs.length) return '';
  return 'to ' + addrs.map((a) => (me.has(a.email.toLowerCase()) ? 'me' : displayName(a, addrs.length > 1))).join(', ');
}

/** The message r/a/f act on: the newest non-draft message that isn't in Trash/Junk. */
export function latestReplyable(app: App, threadId: Id | null): EmailRec | null {
  if (!threadId) return null;
  const hidden = hiddenMailboxIds(app.engine.state.mailboxes, null);
  const list = app.engine
    .threadEmails([threadId])
    .filter((e) => app.engine.state.bodies[e.id] && !e.keywords?.$draft && !isHidden(e, hidden))
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
  return list[0] ?? null;
}

function ReplyBar(props: { threadId: Id }) {
  const app = useApp();
  const open = (mode: 'reply' | 'replyAll' | 'forward') => {
    const latest = latestReplyable(app, props.threadId);
    if (latest) app.composers.open(mode, latest);
  };
  const multiple = () => {
    const e = latestReplyable(app, props.threadId);
    return !!e && (e.to?.length ?? 0) + (e.cc?.length ?? 0) > 1;
  };
  return (
    <div class="reply-bar">
      <button class="btn" onClick={() => open('reply')}><Icon name="reply" /> Reply</button>
      <Show when={multiple()}>
        <button class="btn" onClick={() => open('replyAll')}><Icon name="replyAll" /> Reply all</button>
      </Show>
      <button class="btn" onClick={() => open('forward')}><Icon name="forward" /> Forward</button>
    </div>
  );
}

function Message(props: { email: EmailRec; expanded: boolean; onToggle: () => void }) {
  const { engine, composers } = useApp();
  const isDraft = () => !!props.email.keywords?.$draft;
  const from = () => props.email.from?.[0];
  const me = createMemo(() => engine.myAddresses());
  const name = () => (from() && me().has(from()!.email.toLowerCase()) ? 'me' : displayName(from()));

  return (
    <article class="msg" classList={{ collapsed: !props.expanded }} data-email-id={props.email.id}>
      <div class="msg-head" onClick={() => props.onToggle()} role="button" tabindex="0" onKeyDown={(e) => e.key === 'Enter' && props.onToggle()} aria-expanded={props.expanded}>
        <div class="avatar" style={{ background: avatarColor(from()?.email ?? '') }} aria-hidden="true">
          {(from()?.name || from()?.email || '?').trim()[0]?.toUpperCase()}
        </div>
        <div class="msg-meta">
          <div>
            <Show when={isDraft()}>
              <span class="draft-tag">Draft</span>{' '}
            </Show>
            <span class="from">{name()}</span>
            <Show when={props.expanded && from()}>
              <span class="addr">&lt;{from()!.email}&gt;</span>
            </Show>
          </div>
          <Show when={props.expanded} fallback={<div class="snippet">{props.email.preview}</div>}>
            <div class="to">{recipients(props.email, me())}</div>
          </Show>
        </div>
        <div class="msg-date" title={fullDate(props.email.receivedAt)}>
          {props.expanded ? fullDate(props.email.receivedAt) : listDate(props.email.receivedAt)}
        </div>
        <Show when={props.expanded && !isDraft()}>
          <button class="icon-btn" title="Reply" onClick={(e) => { e.stopPropagation(); composers.open('reply', props.email); }}>
            <Icon name="reply" />
          </button>
        </Show>
      </div>
      <Show when={props.expanded}>
        <div class="msg-body">
          <MessageBody email={props.email} />
          <Attachments email={props.email} />
          <Show when={isDraft()}>
            <button class="btn tonal" style={{ 'margin-top': '12px' }} onClick={() => composers.openDraft(props.email)}>
              Edit draft
            </button>
          </Show>
        </div>
      </Show>
    </article>
  );
}

function Attachments(props: { email: EmailRec }) {
  const { client, toast } = useApp();
  // Inline images referenced by the HTML body aren't listed as attachments.
  const list = () => (props.email.attachments ?? []).filter((a) => !(a.disposition === 'inline' && a.cid && a.type.startsWith('image/')));

  const download = async (a: EmailBodyPart) => {
    try {
      const blob = await client.fetchBlob(a.blobId!, a.name ?? 'attachment', a.type);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = a.name ?? 'attachment';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast(`Download failed: ${String(e)}`, 'error');
    }
  };

  return (
    <Show when={list().length}>
      <div class="attachments">
        <For each={list()}>
          {(a) => (
            <button type="button" class="attachment" onClick={() => void download(a)} title={a.name ?? ''}>
              <Icon name="file" style={{ width: '20px', height: '20px', flex: 'none' }} />
              <span>{a.name ?? 'attachment'}</span>
              <small>{fileSize(a.size)}</small>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
