import { A, useLocation, useNavigate, useParams, type RouteSectionProps } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, lazy, on, onCleanup, Show, type JSX } from 'solid-js';
import { branding } from '../app/branding';
import { useApp } from '../app/context';
import { createNotifier, notifications, tabTitle } from '../app/notify';
import type { Mailbox } from '../jmap/types';
import { isLabel, labelPath, mailboxSlug, resolveView, searchSlug, sidebarMailboxes } from '../sync/selectors';
import { bannerText, vacationStatus } from '../mail/settings';
import { AccountSwitcher } from './AccountSwitcher';
import { BrandMark } from './Brand';
import { now } from './clock';
import { ConnectionBanner } from './ConnectionBanner';
import { Conversation } from './Conversation';
import { Icon, type IconName } from './icons';
import { installShortcuts } from './keyboard';
import { LabelDialog } from './LabelDialog';
import { LabelMenu } from './LabelMenu';
import { missingViewText } from './nav';
import { PaneBoundary } from './PaneBoundary';
import { HelpDialog, MailboxPicker } from './Overlays';
import { latestReplyable } from './Conversation';
import { ThreadList } from './ThreadList';

// The editor (TipTap/ProseMirror) is most of the bundle: load it on first compose.
const ComposeDock = lazy(() => import('./ComposerView').then((m) => ({ default: m.ComposeDock })));

const ROLE_ICONS: Record<string, IconName> = {
  inbox: 'inbox', drafts: 'draft', sent: 'send', archive: 'archive', junk: 'junk', trash: 'trash',
};

export function Shell(props: RouteSectionProps & { toasts: () => JSX.Element; confirmHost: () => JSX.Element }) {
  const app = useApp();
  const vacationBanner = createMemo(() => bannerText(vacationStatus(app.engine.state.vacation, now())));
  const [navOpen, setNavOpen] = createSignal(false);
  const location = useLocation();
  const navigate = useNavigate();
  createEffect(() => (document.title = tabTitle(app.spaces.totalUnread(), branding().name)));
  for (const space of app.spaces.list()) {
    space.engine.onArrived = createNotifier({
      api: notifications.api,
      enabled: notifications.prefs.enabled,
      away: () => document.visibilityState === 'hidden' || !document.hasFocus(),
      inboxId: () => Object.values(space.engine.state.mailboxes).find((mb) => mb.role === 'inbox')?.id,
      account: () => space.info,
      open: (path) => {
        window.focus();
        // A full path, base included, and perhaps another mailbox's: go through the browser, so
        // that the right account is mounted before its router reads the address.
        history.pushState(null, '', path);
        app.spaces.show(space.info.id);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
    });
  }
  onCleanup(() => app.spaces.list().forEach((s) => (s.engine.onArrived = null)));
  const dispose = installShortcuts(app, app.nav, navigate, {
    compose: () => app.composers.open('new'),
    reply: (mode) => {
      const latest = latestReplyable(app, app.nav.openThread());
      if (latest) app.composers.open(mode, latest);
    },
  });
  onCleanup(dispose);

  return (
    <div class="shell">
      <header class="topbar">
        <button class="icon-btn only-mobile" aria-label="Menu" onClick={() => setNavOpen(!navOpen())}>
          <Icon name="menu" />
        </button>
        <div class="brand">
          <BrandMark />
        </div>
        <SearchBox />
        <div class="spacer" />
        <span class="status-dot" classList={{ online: app.engine.state.online }} title={app.engine.state.online ? 'Live updates connected' : 'Reconnecting…'} />
        <A href="/settings" class="icon-btn" aria-label="Settings" title="Settings">
          <Icon name="settings" />
        </A>
        <button
          class="icon-btn"
          title="Toggle theme"
          onClick={() => app.setTheme(app.isDark() ? 'light' : 'dark')}
        >
          <Icon name="theme" />
        </button>
        <button class="icon-btn hide-mobile" title="Keyboard shortcuts (?)" onClick={() => app.nav.setHelpOpen(true)}>
          <Icon name="keyboard" />
        </button>
        <button class="icon-btn" title={`Sign out ${app.client.session.username}`} onClick={() => app.signOut()}>
          <Icon name="logout" />
        </button>
      </header>
      <Show when={navOpen()}>
        <div class="scrim" onClick={() => setNavOpen(false)} />
      </Show>
      <nav class="sidebar" classList={{ open: navOpen() }} onClick={(e) => (e.target as Element).closest('a, .compose-fab') && setNavOpen(false)}>
        <AccountSwitcher
          spaces={app.spaces}
          onSwitch={(space) => {
            // Through the browser, not the router: the other account's router does not exist yet.
            history.pushState(null, '', `${space.info.base}/inbox`);
            app.spaces.show(space.info.id);
          }}
        />
        <button class="compose-fab" onClick={() => app.composers.open('new')} title="Compose (c)">
          <Icon name="edit" /> Compose
        </button>
        <PaneBoundary name="sidebar">
          <Sidebar current={location.pathname} />
        </PaneBoundary>
      </nav>
      <main class="main">
        <ConnectionBanner connection={app.connection} onSignIn={app.signIn} />
        <Show when={vacationBanner()}>
          {(text) => <p class="vacation-banner">{text()} <A href="/settings">Settings</A></p>}
        </Show>
        {props.children}
      </main>
      <props.toasts />
      <Show when={app.composers.list().length}>
        <PaneBoundary name="composer">
          <ComposeDock />
        </PaneBoundary>
      </Show>
      <MailboxPicker />
      <HelpDialog />
      <LabelDialog />
      <props.confirmHost />
    </div>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  // Mirror the current search route into the box (back/forward, deep links).
  const routeQuery = () => {
    const m = /^\/search\/([^/]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]!) : '';
  };
  const [text, setText] = createSignal(routeQuery());
  createEffect(on(routeQuery, (q) => setText(q)));

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const q = text().trim();
    navigate(q ? `/${searchSlug(q)}` : '/inbox');
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <form class="search-box" role="search" onSubmit={submit}>
      <button class="icon-btn" type="submit" aria-label="Search" style={{ width: '36px', height: '36px' }}>
        <Icon name="search" />
      </button>
      <input
        id="search-input"
        type="search"
        placeholder="Search mail"
        aria-label="Search mail"
        autocomplete="off"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
      />
      <Show when={text()}>
        <button class="icon-btn" type="button" aria-label="Clear search" style={{ width: '36px', height: '36px' }} onClick={() => { setText(''); if (routeQuery()) navigate('/inbox'); }}>
          <Icon name="close" />
        </button>
      </Show>
    </form>
  );
}

function Sidebar(props: { current: string }) {
  const { engine, hasCalendars, nav } = useApp();
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
      <div class="nav-section">
        <span>Labels</span>
        <button class="icon-btn nav-add" type="button" aria-label="New label" title="New label" onClick={() => nav.setLabelDialog({ kind: 'create' })}>
          <Icon name="add" />
        </button>
      </div>
      <For each={groups().labels}>
        {(mb) => (
          <div class="nav-row">
            {item(mb, mailboxSlug(mb), labelPath(mb, engine.state.mailboxes), 'label', mb.unreadThreads)}
            <Show when={isLabel(mb)}>
              <LabelMenu mailbox={mb} />
            </Show>
          </div>
        )}
      </For>
      <Show when={hasCalendars()}>
        <A href="/calendar" class="nav-item" classList={{ active: props.current === '/calendar' }}>
          <Icon name="calendar" />
          <span class="name">Calendar</span>
        </A>
        <Show when={props.current === '/calendar'}>
          <CalendarList />
        </Show>
      </Show>
    </>
  );
}

/** The calendars, each with a show/hide checkbox (a per-browser preference). */
function CalendarList() {
  const { calendar } = useApp();
  const calendars = createMemo(() =>
    Object.values(calendar.state.calendars).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  );
  return (
    <For each={calendars()}>
      {(c) => (
        <label class="nav-item cal-toggle">
          <input type="checkbox" checked={!calendar.hidden().has(c.id)} onChange={() => calendar.toggleHidden(c.id)} />
          <span class="cal-dot" style={{ background: c.color ?? 'var(--cal-default)' }} />
          <span class="name">{c.name}</span>
        </label>
      )}
    </For>
  );
}

/** Route params may arrive still percent-encoded; decode once, tolerating stray '%'. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Route component for /:slug, /:slug/t/:threadId and /label/:id[/t/:threadId]. */
export function MailView() {
  const params = useParams<{ slug?: string; id?: string; q?: string; threadId?: string }>();
  const { engine, labels, toast } = useApp();
  const navigate = useNavigate();
  const slug = () =>
    params.q !== undefined
      ? `search/${encodeURIComponent(safeDecode(params.q))}`
      : params.id
        ? `label/${params.id}`
        : (params.slug ?? 'inbox');
  // Only a different mailbox counts as a new view; count updates must not remount the list.
  const view = createMemo(() => resolveView(slug(), engine.state.mailboxes), undefined, {
    equals: (a, b) => a?.slug === b?.slug && a?.mailboxId === b?.mailboxId && a?.title === b?.title,
  });

  // A label that is gone (deleted here or elsewhere, or a stale link) has no view: go to the Inbox.
  // Only once the store has been reconciled; a warm-start snapshot may not know a new label yet.
  // `on` keeps the toast and the navigation from adding dependencies that would run this twice.
  createEffect(on([() => params.id, view, () => engine.state.synced], ([id, v, synced]) => {
    if (!id || v || !synced) return;
    if (!labels.deletedHere(id)) toast('That label no longer exists.', 'info');
    navigate('/inbox', { replace: true });
  }));

  return (
    <Show when={view()} fallback={<div class="list-empty">{missingViewText(!!params.id, engine.state.ready)}</div>} keyed>
      {(v) => (
        <>
          <PaneBoundary name="thread list">
            <ThreadList view={v} hidden={!!params.threadId} />
          </PaneBoundary>
          <Show when={params.threadId}>
            {(tid) => (
              <PaneBoundary name="conversation">
                <Conversation view={v} threadId={tid()} />
              </PaneBoundary>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
