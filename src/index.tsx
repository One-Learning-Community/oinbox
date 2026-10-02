/* @refresh reload */
import { Navigate, Route, Router } from '@solidjs/router';
import { lazy } from 'solid-js';
import { render } from 'solid-js/web';
import { createActions } from './app/actions';
import { createComposers } from './app/composer';
import { AppContext, createImagePrefs, createTheme, type App } from './app/context';
import { createRecipients } from './app/recipients';
import { NotSignedInError, OAuth } from './auth/oauth';
import { CalendarStore } from './calendar/store';
import { clearCache, loadCachedSession, loadSnapshot, saveCachedSession, saveSnapshot } from './cache/persist';
import { JmapClient, UnauthorizedError } from './jmap/client';
import { openPushStream } from './jmap/sse';
import { CALENDARS } from './jmap/types';
import { MailEngine } from './sync/engine';
import { createConfirmDialog } from './ui/ConfirmDialog';
import { MailView, Shell } from './ui/Shell';
import { SignIn } from './ui/SignIn';
import { createNav } from './ui/nav';
import { createToasts } from './ui/Toasts';
import './ui/styles.css';

// FullCalendar is large: load it on first visit to /calendar.
const CalendarView = lazy(() => import('./ui/CalendarView').then((m) => ({ default: m.CalendarView })));

const root = document.getElementById('root')!;
const origin = location.origin;
const auth = new OAuth({
  origin,
  clientId: import.meta.env.VITE_OAUTH_CLIENT_ID ?? 'oinbox',
  scope: import.meta.env.VITE_OAUTH_SCOPE ?? 'openid offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:calendars',
});

async function boot() {
  const theme = createTheme();

  if (location.pathname === '/auth/callback') {
    try {
      const returnTo = await auth.handleCallback(new URL(location.href));
      history.replaceState(null, '', returnTo);
    } catch (e) {
      render(() => <SignIn auth={auth} error={String((e as Error).message)} />, root);
      return;
    }
  }

  if (!auth.isSignedIn()) {
    render(() => <SignIn auth={auth} />, root);
    return;
  }

  const client = new JmapClient({
    sessionUrl: `${origin}/.well-known/jmap`,
    getToken: () => auth.getToken(),
    onUnauthorized: () => auth.renew(),
  });
  const engine = new MailEngine(client);
  // Before the warm-start snapshot is applied, so it sees every email.
  const recipients = createRecipients(engine);
  const calendar = new CalendarStore(client, (m, t, a) => toasts.toast(m, t, a));
  const toasts = createToasts();
  const confirmDialog = createConfirmDialog();

  const signOut = () => {
    const user = client.hasSession ? client.session.username : null;
    auth.signOut();
    recipients.stop();
    void (user ? clearCache(user) : Promise.resolve()).finally(() => location.assign('/'));
  };
  const onAuthError = (e: unknown) => {
    if (e instanceof UnauthorizedError || e instanceof NotSignedInError) {
      signOut();
      return true;
    }
    return false;
  };
  window.addEventListener('unhandledrejection', (ev) => {
    if (onAuthError(ev.reason)) ev.preventDefault();
  });

  // Warm start: render from the cached session + snapshot, then reconcile.
  const cachedSession = loadCachedSession();
  if (cachedSession) {
    client.useSession(cachedSession);
    const snap = await loadSnapshot(cachedSession.username);
    if (snap) engine.hydrate(snap);
  }

  const app: App = {
    client,
    engine,
    calendar,
    hasCalendars: () => client.hasSession && !!client.session.primaryAccounts[CALENDARS],
    auth,
    toast: toasts.toast,
    actions: createActions(engine, toasts.toast, confirmDialog.confirm),
    nav: createNav(),
    composers: createComposers(engine, client, toasts.toast, confirmDialog.confirm, recipients.recordSent),
    recipients,
    images: await createImagePrefs(),
    ...theme,
    signOut,
  };

  const start = async () => {
    const session = await client.loadSession();
    saveCachedSession(session);
    if (cachedSession && cachedSession.username !== session.username) location.reload();
    engine.onPersist = (snap) => void saveSnapshot(session.username, snap);
    void recipients.start(session.username);
    await engine.start();
    void calendar.loadCalendars().catch((e) => onAuthError(e));
    // Suggestions are a convenience: a failed scan is dropped unless it is an auth failure.
    void recipients.scanSent().catch((e) => onAuthError(e));
    openPushStream(client, {
      onStateChange: (c) => {
        engine.onStateChange(c);
        calendar.onStateChange(c);
      },
      onConnected: () => {
        engine.setOnline(true);
        void engine.catchUp().catch(() => undefined);
        calendar.onConnected();
      },
      onUnauthorized: () => signOut(),
    });
  };

  if (!cachedSession) {
    try {
      await start();
    } catch (e) {
      if (!onAuthError(e)) render(() => <SignIn auth={auth} error={`Couldn't reach the mail server: ${String(e)}`} />, root);
      return;
    }
  } else {
    start().catch((e) => {
      if (!onAuthError(e)) app.toast(`Couldn't reach the mail server: ${String(e)}`, 'error');
    });
  }

  render(
    () => (
      <AppContext.Provider value={app}>
        <Router root={(p) => <Shell {...p} toasts={toasts.Host} confirmHost={confirmDialog.Host} />}>
          <Route path="/" component={() => <Navigate href="/inbox" />} />
          <Route path="/auth/callback" component={() => <Navigate href="/inbox" />} />
          <Route path="/calendar" component={() => (app.hasCalendars() ? <CalendarView /> : <Navigate href="/inbox" />)} />
          <Route path="/search/:q" component={MailView} />
          <Route path="/search/:q/t/:threadId" component={MailView} />
          <Route path="/label/:id" component={MailView} />
          <Route path="/label/:id/t/:threadId" component={MailView} />
          <Route path="/:slug" component={MailView} />
          <Route path="/:slug/t/:threadId" component={MailView} />
        </Router>
      </AppContext.Provider>
    ),
    root,
  );
}

void boot();
