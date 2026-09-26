import { A, useLocation, useParams, type RouteSectionProps } from '@solidjs/router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { Toaster, type ToasterHandle } from '@rozie-ui/toast-solid';
import { useApp } from '../app/context';
import type { Mailbox } from '../jmap/types';
import { labelPath, mailboxSlug, resolveView, sidebarMailboxes } from '../sync/selectors';
import { Conversation } from './Conversation';
import { Icon, type IconName } from './icons';
import { ThreadList } from './ThreadList';

const ROLE_ICONS: Record<string, IconName> = {
  inbox: 'inbox', drafts: 'draft', sent: 'send', archive: 'archive', junk: 'junk', trash: 'trash',
};

export function Shell(props: RouteSectionProps & { onToaster: (h: ToasterHandle) => void }) {
  const app = useApp();
  const [navOpen, setNavOpen] = createSignal(false);
  const location = useLocation();

  return (
    <div class="shell">
      <header class="topbar">
        <button class="icon-btn only-mobile" aria-label="Menu" onClick={() => setNavOpen(!navOpen())}>
          <Icon name="menu" />
        </button>
        <div class="brand">
          <b>o</b><span>inbox</span>
        </div>
        <label class="search-box">
          <Icon name="search" style={{ width: '20px', height: '20px', margin: '0 8px', color: 'var(--text-3)' }} />
          <input type="search" placeholder="Search mail" aria-label="Search mail" disabled title="Search arrives in M2" />
        </label>
        <div class="spacer" />
        <span class="status-dot" classList={{ online: app.engine.state.online }} title={app.engine.state.online ? 'Live updates connected' : 'Reconnecting…'} />
        <button
          class="icon-btn"
          title="Toggle theme"
          onClick={() => app.setTheme(app.isDark() ? 'light' : 'dark')}
        >
          <Icon name="theme" />
        </button>
        <button class="icon-btn" title={`Sign out ${app.client.session.username}`} onClick={() => app.signOut()}>
          <Icon name="logout" />
        </button>
      </header>
      <Show when={navOpen()}>
        <div class="scrim" onClick={() => setNavOpen(false)} />
      </Show>
      <nav class="sidebar" classList={{ open: navOpen() }} onClick={(e) => (e.target as Element).closest('a') && setNavOpen(false)}>
        <Sidebar current={location.pathname} />
      </nav>
      <main class="main">{props.children}</main>
      <Toaster ref={props.onToaster} position="bottom-left" duration={5000} />
    </div>
  );
}

function Sidebar(props: { current: string }) {
  const { engine } = useApp();
  const groups = createMemo(() => sidebarMailboxes(engine.state.mailboxes));
  const isActive = (slug: string) => props.current === `/${slug}` || props.current.startsWith(`/${slug}/t/`);

  const item = (mb: Mailbox | null, slug: string, name: string, icon: IconName, count: number) => (
    <A href={`/${slug}`} class="nav-item" classList={{ active: isActive(slug) }}>
      <Icon name={icon} />
      <span class="name">{name}</span>
      <Show when={count > 0 && mb?.role !== 'sent' && mb?.role !== 'trash'}>
        <span class="count">{count.toLocaleString()}</span>
      </Show>
    </A>
  );

  return (
    <>
      <For each={groups().system}>
        {(mb) => (
          <>
            {item(mb, mailboxSlug(mb), mb.role === 'inbox' ? 'Inbox' : mb.name, ROLE_ICONS[mb.role!] ?? 'label', mb.role === 'drafts' ? mb.totalEmails : mb.unreadThreads)}
            {mb.role === 'inbox' ? item(null, 'starred', 'Starred', 'star', 0) : null}
          </>
        )}
      </For>
      <Show when={groups().labels.length}>
        <div class="nav-section">Labels</div>
        <For each={groups().labels}>
          {(mb) => item(mb, mailboxSlug(mb), labelPath(mb, engine.state.mailboxes), 'label', mb.unreadThreads)}
        </For>
      </Show>
    </>
  );
}

/** Route component for /:slug, /:slug/t/:threadId and /label/:id[/t/:threadId]. */
export function MailView() {
  const params = useParams<{ slug?: string; id?: string; threadId?: string }>();
  const { engine } = useApp();
  const slug = () => (params.id ? `label/${params.id}` : (params.slug ?? 'inbox'));
  // Only a different mailbox counts as a new view; count updates must not remount the list.
  const view = createMemo(() => resolveView(slug(), engine.state.mailboxes), undefined, {
    equals: (a, b) => a?.slug === b?.slug && a?.mailboxId === b?.mailboxId && a?.title === b?.title,
  });

  return (
    <Show when={view()} fallback={<div class="list-empty">{engine.state.ready ? 'Mailbox not found.' : 'Loading…'}</div>} keyed>
      {(v) => (
        <>
          <ThreadList view={v} hidden={!!params.threadId} />
          <Show when={params.threadId}>{(tid) => <Conversation view={v} threadId={tid()} />}</Show>
        </>
      )}
    </Show>
  );
}
