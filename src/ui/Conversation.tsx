import { useNavigate } from '@solidjs/router';
import { createEffect, createMemo, createResource, createSignal, For, lazy, Match, on, onCleanup, Show, Switch, untrack } from 'solid-js';
import { useApp, type App } from '../app/context';
import type { EmailAddress, EmailBodyPart, Id, Mailbox } from '../jmap/types';
import { avatarColor, fileSize, fullDate, listDate } from '../mail/format';
import { displayName } from '../mail/participants';
import type { EmailRec } from '../sync/engine';
import { hiddenMailboxIds, isHidden, isLabel, type View } from '../sync/selectors';
import { Icon } from './icons';
import { InviteCard } from './InviteCard';
import { MessageBody } from './MessageBody';
import { PaneBoundary } from './PaneBoundary';
import { logUnexpected } from '../sync/connection';

const ComposerView = lazy(() => import('./ComposerView').then((m) => ({ default: m.ComposerView })));

/** Email ids, or `older:<count>` for the folded run. Strings keep <For> from recreating messages (and their iframes) on every store change. */
type Item = string;

export function Conversation(props: { view: View; threadId: Id }) {
  const { engine, toast, actions, nav, composers } = useApp();
  const navigate = useNavigate();

  createEffect(() => nav.setOpenThread(props.threadId));
  onCleanup(() => {
    nav.setOpenThread(null);
    // The heading that had the focus is going away: hand it to the list's cursor row, once the list
    // (a new one, when the route changed) has drawn its rows.
    setTimeout(() => nav.list()?.focusCursor(), 120);
  });

  const [loaded] = createResource(
    () => props.threadId,
    (id) => engine.loadThread(id).then(() => true).catch((e) => {
      toast(`Couldn't open conversation: ${String(e)}`, 'error');
      return false;
    }),
  );

  // Messages that join the thread while it's open (a reply sent or received) sync without
  // bodies: fetch them, or they'd stay invisible until the conversation is reopened.
  createEffect(() => {
    const t = engine.state.threads[props.threadId];
    if (loaded() && t?.emailIds.some((id) => !engine.state.bodies[id])) void engine.loadThread(props.threadId).catch(logUnexpected);
  });

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
  /** The draft behind an open composer shows as that composer, not also as a message. */
  const beingEdited = createMemo(() => new Set(composers.list().map((c) => c.draftId())));
  const messages = createMemo(() =>
    all().filter((e) => !beingEdited().has(e.id) && (showDeleted() || !isHidden(e, hidden()))),
  );

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
    // untrack: this effect writes `expanded`, so it must not also depend on it.
    const next = new Set(untrack(expanded));
    const first = known.size === 0;
    let changed = false;
    for (const e of list) {
      if (known.has(e.id)) continue;
      known.add(e.id);
      changed = true;
      if (!first || !untrack(() => e.keywords?.$seen)) next.add(e.id);
    }
    if (!changed) return;
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
        out.push(list[i]!.id, `older:${run - 2}`, list[j - 1]!.id);
      } else {
        for (let k = i; k < j; k++) out.push(list[k]!.id);
      }
      if (j < list.length) out.push(list[j]!.id);
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
      .filter((m): m is Mailbox => !!m && (!m.role || m.role === 'inbox'))
      .map((m) => ({ id: m.id, name: m.role === 'inbox' ? 'Inbox' : m.name, removable: isLabel(m) }));
  });

  const removeLabel = (id: Id) => {
    void actions.removeLabel([props.threadId], id);
    // Without the label the conversation no longer belongs to this view.
    if (props.view.mailboxId === id) navigate(`/${props.view.slug}`);
  };

  return (
    <section class="conv-pane" style={{ display: 'flex', 'flex-direction': 'column', flex: '1', 'min-height': '0' }}>
      <div class="toolbar">
        <button class="icon-btn" title="Back to list (u)" onClick={() => navigate(`/${props.view.slug}`)}>
          <Icon name="back" />
        </button>
        <Show when={props.view.role !== 'archive'}>
          <button class="icon-btn" title="Archive (e)" onClick={() => { void actions.archive([props.threadId]).then((ok) => ok && navigate(`/${props.view.slug}`)); }}>
            <Icon name="archive" />
          </button>
        </Show>
        <button class="icon-btn" title="Report spam (!)" onClick={() => { void actions.spam([props.threadId]).then((ok) => ok && navigate(`/${props.view.slug}`)); }}>
          <Icon name="junk" />
        </button>
        <button class="icon-btn" title="Delete (#)" onClick={() => { void actions.trash([props.threadId]).then((ok) => ok && navigate(`/${props.view.slug}`)); }}>
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
              {/* Opening a thread moves the keyboard here, unless the user is already in a control. */}
              <h1
                tabindex="-1"
                ref={(el) =>
                  queueMicrotask(() => {
                    const active = document.activeElement as HTMLElement | null;
                    if (!active || active === document.body || active.offsetParent === null) el.focus({ preventScroll: true });
                  })
                }
              >
                {subject()}
                <For each={labels()}>
                  {(l) => (
                    <span class="chip">
                      {l.name}
                      <Show when={l.removable}>
                        <button type="button" class="chip-x" aria-label={`Remove label ${l.name}`} title="Remove label" onClick={() => removeLabel(l.id)}>
                          ×
                        </button>
                      </Show>
                    </span>
                  )}
                </For>
              </h1>
            </div>
            <For each={items()}>
              {(item) =>
                item.startsWith('older:') ? (
                  <div class="older-pill" role="button" tabindex="0" onClick={() => setShowOlder(true)} onKeyDown={(e) => e.key === 'Enter' && setShowOlder(true)}>
                    <span>{item.slice(6)}</span> older messages
                  </div>
                ) : (
                  <Show when={engine.state.emails[item]}>
                    {(email) => <Message email={email()} expanded={expanded().has(item)} onToggle={() => toggle(item)} />}
                  </Show>
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
              {(c) => (
                <PaneBoundary name="composer">
                  <ComposerView composer={c()} inline />
                </PaneBoundary>
              )}
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
      {/* A click anywhere on the header toggles, for the pointer. The control itself is the sender's name:
          a header that was one big button swallowed the buttons inside it for screen readers. */}
      <div class="msg-head" onClick={() => props.onToggle()}>
        <div class="avatar" style={{ background: avatarColor(from()?.email ?? '') }} aria-hidden="true">
          {(from()?.name || from()?.email || '?').trim()[0]?.toUpperCase()}
        </div>
        <div class="msg-meta">
          <div>
            <Show when={isDraft()}>
              <span class="draft-tag">Draft</span>{' '}
            </Show>
            <button
              type="button"
              class="from msg-toggle"
              aria-expanded={props.expanded}
              title={props.expanded ? 'Collapse message' : 'Expand message'}
              onClick={(e) => {
                e.stopPropagation();
                props.onToggle();
              }}
            >
              {name()}
            </button>
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
          <PaneBoundary name="invite card" silent>
            <InviteCard email={props.email} />
          </PaneBoundary>
          {/* One malformed message must not hide the rest of its thread. */}
          <PaneBoundary name="message">
            <MessageBody email={props.email} />
          </PaneBoundary>
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
