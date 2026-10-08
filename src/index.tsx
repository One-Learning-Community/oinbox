/* @refresh reload */
import { Navigate, Route, Router } from '@solidjs/router';
import { ErrorBoundary, lazy, Suspense, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { createActions } from './app/actions';
import { createComposers } from './app/composer';
import { createErrorReporter } from './app/errors';
import { startBranding } from './app/branding';
import { AppContext, createImagePrefs, createTheme, type App } from './app/context';
import { createLabels } from './app/labels';
import { createRecipients } from './app/recipients';
import { clearRescue, saveRescue, takeRescue } from './app/rescue';
import { createSettings } from './app/settings';
import { NotSignedInError, OAuth } from './auth/oauth';
import { CalendarStore } from './calendar/store';
import { clearCache, loadCachedSession, loadSnapshot, saveCachedSession, saveSnapshot } from './cache/persist';
import { JmapClient, UnauthorizedError } from './jmap/client';
import { openPushStream, type PushStream } from './jmap/sse';
import { CALENDARS } from './jmap/types';
import { DEFAULT_LIMITS, labelLimits } from './mail/labels';
import { createConnection, isTransportFailure, logUnexpected } from './sync/connection';
import { MailEngine } from './sync/engine';
import { createConfirmDialog } from './ui/ConfirmDialog';
import { SettingsView } from './ui/SettingsView';
import { PaneBoundary } from './ui/PaneBoundary';
import { RootFallback } from './ui/RootFallback';
import { MailView, Shell } from './ui/Shell';
import { SignIn } from './ui/SignIn';
import { createNav } from './ui/nav';
import { createToasts } from './ui/Toasts';
import './ui/styles.css';

// FullCalendar is large: load it on first visit to /calendar.
const CalendarView = lazy(() => import('./ui/CalendarView').then((m) => ({ default: m.CalendarView })));

const root = document.getElementById('root')!;
/** Put a screen in the page, in place of whatever is there (first, index.html's "Loading…"). */
const mount = (ui: () => JSX.Element) => {
  root.textContent = '';
  render(ui, root);
};
const origin = location.origin;
const auth = new OAuth({
  origin,
  clientId: import.meta.env.VITE_OAUTH_CLIENT_ID ?? 'oinbox',
  scope: import.meta.env.VITE_OAUTH_SCOPE ?? 'openid offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:calendars',
});

async function boot() {
  const theme = createTheme();
  await startBranding((url) => fetch(url, { cache: 'no-cache' }), localStorage, document);

  if (location.pathname === '/auth/callback') {
    try {
      const returnTo = await auth.handleCallback(new URL(location.href));
      history.replaceState(null, '', returnTo);
    } catch (e) {
      mount(() => <SignIn auth={auth} error={String((e as Error).message)} />);
      return;
    }
  }

  if (!auth.isSignedIn()) {
    mount(() => <SignIn auth={auth} />);
    return;
  }

  const connection = createConnection();
  const client = new JmapClient({
    sessionUrl: `${origin}/.well-known/jmap`,
    // A token refresh can fail on the network too, before any request is made.
    getToken: () =>
      auth.getToken().catch((e) => {
        // The usual way a session ends: the token is renewed ahead of expiry and the server refuses
        // (password changed, refresh token expired, signed out in another tab). No request is made,
        // so no 401 comes back to say so.
        if (e instanceof NotSignedInError && !auth.isSignedIn()) {
          if (rendered) sessionLost();
          throw new UnauthorizedError();
        }
        connection.reportFailure('request', e);
        throw e;
      }),
    onUnauthorized: async () => {
      const renewed = await auth.renew();
      // A refresh the server refused drops the tokens: the session is over, whoever catches the error
      // (an autosave swallows it). A refresh that failed on the network keeps them, and is not a sign-out.
      if (!renewed && !auth.isSignedIn()) sessionLost();
      return renewed;
    },
    onOutcome: (e) => (e === null ? connection.reportSuccess('request') : connection.reportFailure('request', e)),
  });
  let push: PushStream | undefined;
  let assumedOpen = false;
  const engine = new MailEngine(client);
  // Before the warm-start snapshot is applied, so it sees every email.
  const recipients = createRecipients(engine);
  const calendar = new CalendarStore(client, (m, t, a) => toasts.toast(m, t, a));
  const toasts = createToasts();
  const confirmDialog = createConfirmDialog();
  const errors = createErrorReporter(toasts.toast);

  /** Drop the session and go to the sign-in card. */
  const leave = () => {
    const user = client.hasSession ? client.session.username : null;
    auth.signOut();
    recipients.stop();
    void (user ? clearCache(user) : Promise.resolve()).finally(() => location.assign('/'));
  };
  const signOut = () => {
    // A deliberate sign-out leaves no draft text behind in this browser. (An involuntary one must
    // not: a rescued draft is waiting for exactly the sign-in that follows it.)
    clearRescue(localStorage);
    leave();
  };
  const rescueDrafts = () => {
    if (client.hasSession) saveRescue(localStorage, client.accountId, app.composers.snapshot());
  };
  /** The server no longer accepts our tokens. Stay on the page, so nothing the user was writing is lost. */
  const sessionLost = () => {
    if (connection.state() === 'signed-out') return;
    // What the server doesn't have yet comes back after signing in again (same account, within 7 days).
    rescueDrafts();
    const user = client.hasSession ? client.session.username : null;
    auth.signOut();
    recipients.stop();
    push?.close();
    engine.setOnline(false);
    if (user) void clearCache(user);
    connection.signedOut();
  };
  const signIn = () => {
    // The page stays usable while signed out; keep what was typed since the banner appeared.
    rescueDrafts();
    void auth.authorizationUrl(location.pathname + location.search).then((url) => location.assign(url));
  };
  window.addEventListener('pagehide', () => {
    if (connection.state() === 'signed-out') rescueDrafts();
  });
  let rendered = false;
  const onAuthError = (e: unknown) => {
    if (e instanceof UnauthorizedError || e instanceof NotSignedInError) {
      // Still holding tokens means the refresh failed on the network, not that the server refused us.
      if (auth.isSignedIn() && rendered) return true;
      // Before the app is on screen there is nothing to keep: go to the sign-in card.
      if (rendered) sessionLost();
      else leave();
      return true;
    }
    return false;
  };
  // Event handlers and rejected promises are out of reach of the error boundaries below.
  errors.install(window, onAuthError);

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
    errors,
    connection,
    signIn,
    actions: createActions(engine, toasts.toast, confirmDialog.confirm),
    labels: createLabels(engine, toasts.toast, confirmDialog.confirm, () => (client.hasSession ? labelLimits(client.session) : DEFAULT_LIMITS)),
    settings: createSettings(engine, toasts.toast, confirmDialog.confirm),
    nav: createNav(),
    composers: createComposers(engine, client, toasts.toast, confirmDialog.confirm, recipients.recordSent, (fn) => connection.onRecovered(fn)),
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
    const rescued = takeRescue(localStorage, client.accountId);
    if (rescued.length) {
      app.composers.restore(rescued);
      // After a cold start the toast host isn't on screen until this function has returned.
      setTimeout(() => app.toast(rescued.length === 1 ? 'Your unsent draft was restored.' : 'Your unsent drafts were restored.'), 0);
    }
    void calendar.loadCalendars().catch((e) => onAuthError(e));
    // Suggestions are a convenience: a failed scan is dropped unless it is an auth failure.
    void recipients.scanSent().catch((e) => onAuthError(e));
    push?.close();
    push = openPushStream(client, {
      onStateChange: (c) => {
        engine.onStateChange(c);
        calendar.onStateChange(c);
      },
      onConnected: (confirmed) => {
        // Only an answer from the server is evidence for the banner; an open request is not.
        if (confirmed) connection.reportSuccess('push');
        // Confirmation of a stream already taken as open: the catch-up below has been done.
        const again = confirmed && assumedOpen;
        assumedOpen = !confirmed;
        if (again) return;
        engine.setOnline(true);
        void engine.catchUp().catch(logUnexpected);
        void engine.refreshSettings().catch(logUnexpected);
        calendar.onConnected();
      },
      onDisconnected: (e) => {
        assumedOpen = false;
        engine.setOnline(false);
        connection.reportFailure('push', e);
      },
      onUnauthorized: () => {
        // A 401 whose renewal failed on the network leaves the tokens in place: not a sign-out.
        if (auth.isSignedIn()) return false;
        sessionLost();
        return true;
      },
    });
  };
  let started = false;
  connection.onRetry((manual) => {
    // The push stream has its own backoff; only a person asking cuts it short.
    if (manual) push?.wake();
    if (started) void engine.catchUp().catch(logUnexpected);
  });
  // The browser's word that the network is back is a hint to try, never proof of a connection.
  window.addEventListener('online', () => connection.retryNow());
  // An idle tab makes no requests, and a dropped network leaves the push stream open: find out now.
  window.addEventListener('offline', () => {
    push?.restart();
    if (started) void engine.catchUp().catch(logUnexpected);
  });

  if (!cachedSession) {
    try {
      await start();
      started = true;
    } catch (e) {
      if (!onAuthError(e)) mount(() => <SignIn auth={auth} error={`Couldn't reach the mail server: ${String(e)}`} />);
      return;
    }
  } else {
    // Warm start: the snapshot is on screen. If the server can't be reached, the banner says so
    // and the session, the catch-up and the push stream come up when it can.
    const tryStart = (): Promise<void> =>
      start().then(
        () => void (started = true),
        async (e) => {
          if (e instanceof UnauthorizedError || e instanceof NotSignedInError) {
            // Stalwart answers a session request it doesn't recognise with 200 and no accounts.
            if (!auth.isSignedIn() || (!(await auth.renew()) && !auth.isSignedIn())) return sessionLost();
          } else if (!isTransportFailure(e) && !startFailureShown) {
            startFailureShown = true;
            app.toast(`Couldn't reach the mail server: ${String(e)}`, 'error');
          }
          // Until it works: without a session there is no push and no catch-up, only a stale snapshot.
          setTimeout(() => void tryStart(), Math.min(30_000, 2000 * 2 ** startAttempt++));
        },
      );
    let startAttempt = 0;
    let startFailureShown = false;
    void tryStart();
  }

  rendered = true;
  mount(
    () => (
      <ErrorBoundary
        fallback={(e) => {
          console.error(e);
          return <RootFallback error={e} />;
        }}
      >
        <AppContext.Provider value={app}>
          <Router root={(p) => <Shell {...p} toasts={toasts.Host} confirmHost={confirmDialog.Host} />}>
            <Route path="/" component={() => <Navigate href="/inbox" />} />
            <Route path="/auth/callback" component={() => <Navigate href="/inbox" />} />
            <Route
              path="/calendar"
              component={() => (
                <PaneBoundary name="calendar">
                  {/* The calendar is its own download; say so while it arrives. */}
                  <Suspense fallback={<div class="list-empty" role="status">Loading calendar…</div>}>
                    {app.hasCalendars() ? <CalendarView /> : <Navigate href="/inbox" />}
                  </Suspense>
                </PaneBoundary>
              )}
            />
            <Route path="/search/:q" component={MailView} />
            <Route path="/search/:q/t/:threadId" component={MailView} />
            <Route path="/label/:id" component={MailView} />
            <Route path="/label/:id/t/:threadId" component={MailView} />
            <Route path="/settings" component={() => <PaneBoundary name="settings"><SettingsView /></PaneBoundary>} />
            <Route path="/:slug" component={MailView} />
            <Route path="/:slug/t/:threadId" component={MailView} />
          </Router>
        </AppContext.Provider>
      </ErrorBoundary>
    ),
  );
}

void boot().catch((e) => {
  console.error(e);
  mount(() => <RootFallback error={e} />);
});
