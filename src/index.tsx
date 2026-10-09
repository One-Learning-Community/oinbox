/* @refresh reload */
import { Navigate, Route, Router } from '@solidjs/router';
import { ErrorBoundary, lazy, Show, Suspense, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { accountForPath, createSpaces, homePath, lostAccounts, mailAccounts, startAll, storageKey, type AccountInfo, type AccountSpace, type Spaces } from './app/accounts';
import { createActions } from './app/actions';
import { createComposers } from './app/composer';
import { createDrive } from './app/drive';
import { createErrorReporter } from './app/errors';
import { startBranding } from './app/branding';
import { AppContext, createImagePrefs, createTheme, type App } from './app/context';
import { createLabels } from './app/labels';
import { createRecipients } from './app/recipients';
import { clearRescue, saveRescue, takeRescue } from './app/rescue';
import { createPassword, notePasswordChanged, takePasswordNotice } from './app/password';
import { createSettings } from './app/settings';
import { NotSignedInError, OAuth } from './auth/oauth';
import { CalendarStore } from './calendar/store';
import { clearCache, clearSnapshots, loadCachedSession, loadSnapshot, saveCachedSession, saveSnapshot } from './cache/persist';
import { DriveClient } from './drive/client';
import { loadDriveConfig } from './drive/config';
import { JmapClient, UnauthorizedError } from './jmap/client';
import { openPushStream, type PushStream } from './jmap/sse';
import { CALENDARS, type Session } from './jmap/types';
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
    const notice = takePasswordNotice(sessionStorage);
    mount(() => <SignIn auth={auth} notice={notice} />);
    return;
  }

  const connection = createConnection();
  // A token refresh can fail on the network too, before any request is made.
  const getToken = () =>
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
    });
  const renewSession = async () => {
    const renewed = await auth.renew();
    // A refresh the server refused drops the tokens: the session is over, whoever catches the error
    // (an autosave swallows it). A refresh that failed on the network keeps them, and is not a sign-out.
    if (!renewed && !auth.isSignedIn()) sessionLost();
    return renewed;
  };
  const client = new JmapClient({
    sessionUrl: `${origin}/.well-known/jmap`,
    getToken,
    onUnauthorized: renewSession,
    onOutcome: (e) => (e === null ? connection.reportSuccess('request') : connection.reportFailure('request', e)),
  });
  let push: PushStream | undefined;
  let assumedOpen = false;
  /** One per mail account in the session; null until the session is known. */
  let spaces: Spaces | null = null;
  const each = (fn: (s: AccountSpace) => void) => spaces?.list().forEach(fn);
  /** What an account's snapshot and recipient cache are stored under. */
  const key = (info: AccountInfo) => storageKey(client.session.username, info);
  /** Every key this user's caches may be under, the one from before shared mailboxes included. */
  const cacheKeys = () => (client.hasSession ? [client.session.username, ...(spaces?.list().map((s) => key(s.info)) ?? [])] : []);
  const clearCaches = () => Promise.all(cacheKeys().map((k) => clearCache(k)));
  const calendar = new CalendarStore(client, (m, t, a) => toasts.toast(m, t, a));
  const toasts = createToasts();
  const confirmDialog = createConfirmDialog();
  const errors = createErrorReporter(toasts.toast);
  // Drive shares the mail token. Its failures are its own: they never reach the connection banner.
  const drive = createDrive({ client: new DriveClient({ getToken, onUnauthorized: renewSession }), toast: toasts.toast });
  // Not awaited: mail does not wait to learn whether there is a Drive.
  void loadDriveConfig((url) => fetch(url, { cache: 'no-cache' })).then(drive.setConfig);

  /** Drop the session and go to the sign-in card. */
  const leave = () => {
    auth.signOut();
    each((s) => s.recipients.stop());
    void clearCaches().finally(() => location.assign('/'));
  };
  const signOut = () => {
    // A deliberate sign-out leaves no draft text behind in this browser. (An involuntary one must
    // not: a rescued draft is waiting for exactly the sign-in that follows it.)
    clearRescue(localStorage);
    leave();
  };
  const rescueDrafts = () => {
    each((s) => saveRescue(localStorage, s.info.id, s.composers.snapshot()));
  };
  /** The server has just dropped every token of the account: go to the sign-in card, and say why. */
  const passwordChanged = () => {
    // The same person signs in again in a moment: what they were writing waits for them.
    rescueDrafts();
    notePasswordChanged(sessionStorage);
    leave();
  };
  /** The server no longer accepts our tokens. Stay on the page, so nothing the user was writing is lost. */
  const sessionLost = () => {
    if (connection.state() === 'signed-out') return;
    // What the server doesn't have yet comes back after signing in again (same account, within 7 days).
    rescueDrafts();
    auth.signOut();
    each((s) => s.recipients.stop());
    push?.close();
    each((s) => s.engine.setOnline(false));
    void clearCaches();
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

  // Warm start: render from the cached session + snapshot, then reconcile. A cold start has to ask
  // for the session first: which accounts there are decides what is built.
  const cachedSession = loadCachedSession();
  let freshSession: Session | null = null;
  if (cachedSession) client.useSession(cachedSession);
  else {
    try {
      freshSession = await client.loadSession();
    } catch (e) {
      if (!onAuthError(e)) mount(() => <SignIn auth={auth} error={`Couldn't reach the mail server: ${String(e)}`} />);
      return;
    }
  }

  const accounts = mailAccounts(client.session);
  /** A shared address for a mailbox that is no longer the user's goes to their own inbox. */
  const goHomeIfLost = () => {
    const home = homePath(location.pathname, accounts);
    if (home) history.replaceState(null, '', home);
  };
  goHomeIfLost();
  const all = createSpaces(
    accounts,
    (info) => {
      const engine = new MailEngine(client, { accountId: info.id });
      // Before the warm-start snapshot is applied, so it sees every email.
      const recipients = createRecipients(engine);
      return {
        engine,
        recipients,
        actions: createActions(engine, toasts.toast, confirmDialog.confirm),
        labels: createLabels(engine, toasts.toast, confirmDialog.confirm, () => (client.hasSession ? labelLimits(client.session, info.id) : DEFAULT_LIMITS)),
        settings: createSettings(engine, toasts.toast, confirmDialog.confirm),
        composers: createComposers(engine, toasts.toast, confirmDialog.confirm, recipients.recordSent, (fn) => connection.onRecovered(fn)),
        nav: createNav(),
      };
    },
    accountForPath(location.pathname, accounts).id,
  );
  spaces = all;
  if (cachedSession) {
    for (const s of all.list()) {
      const snap = await loadSnapshot(key(s.info));
      if (snap) s.engine.hydrate(snap);
    }
    // The snapshot from before shared mailboxes, under the user's name alone. (Not clearCache: that
    // forgets the session too, and the next load could not warm-start.)
    void clearSnapshots(cachedSession.username);
  }

  const cur = all.current;
  // The mail fields are those of the account on screen. Components read them once, when they
  // mount, and the shell is re-mounted on a switch (below). Never spread this object.
  const app: App = {
    client,
    spaces: all,
    get engine() {
      return cur().engine;
    },
    get actions() {
      return cur().actions;
    },
    get labels() {
      return cur().labels;
    },
    get settings() {
      return cur().settings;
    },
    get nav() {
      return cur().nav;
    },
    get composers() {
      return cur().composers;
    },
    get recipients() {
      return cur().recipients;
    },
    password: createPassword(client, passwordChanged),
    drive,
    calendar,
    // Calendars are the user's own: a shared mailbox has no Calendar link.
    hasCalendars: () => client.hasSession && !!client.session.primaryAccounts[CALENDARS] && cur().info.personal,
    auth,
    toast: toasts.toast,
    errors,
    connection,
    signIn,
    images: await createImagePrefs(),
    ...theme,
    signOut,
  };

  const start = async () => {
    const session = freshSession ?? (await client.loadSession());
    freshSession = null;
    saveCachedSession(session);
    // Another user, or other mailboxes (a shared one joined or left): what was built no longer fits.
    const ids = mailAccounts(session).map((a) => a.id);
    if (cachedSession && (cachedSession.username !== session.username || ids.join() !== accounts.map((a) => a.id).join())) {
      // What was remembered of a mailbox that is no longer the user's goes with it.
      await Promise.all(lostAccounts(accounts, session).map((a) => clearSnapshots(storageKey(cachedSession.username, a))));
      location.reload();
      return;
    }
    for (const s of all.list()) {
      s.engine.onPersist = (snap) => void saveSnapshot(key(s.info), snap);
      void s.recipients.start(key(s.info));
    }
    await startAll(all.list(), (s, e) => {
      // The network, not this mailbox: fail the whole start, which is tried again.
      if (isTransportFailure(e)) throw e;
      console.error(`Couldn't open ${s.info.address}`, e);
      app.toast(`Couldn't open ${s.info.label} (${s.info.address}).`, 'error');
    });
    let restored = 0;
    for (const s of all.list()) {
      const rescued = takeRescue(localStorage, s.info.id);
      if (rescued.length) s.composers.restore(rescued);
      restored += rescued.length;
    }
    // After a cold start the toast host isn't on screen until this function has returned.
    if (restored) setTimeout(() => app.toast(restored === 1 ? 'Your unsent draft was restored.' : 'Your unsent drafts were restored.'), 0);
    void calendar.loadCalendars().catch((e) => onAuthError(e));
    // Suggestions are a convenience: a failed scan is dropped unless it is an auth failure.
    for (const s of all.list()) void s.recipients.scanSent().catch((e) => onAuthError(e));
    push?.close();
    push = openPushStream(client, {
      onStateChange: (c) => {
        each((s) => s.engine.onStateChange(c));
        calendar.onStateChange(c);
      },
      onConnected: (confirmed) => {
        // Only an answer from the server is evidence for the banner; an open request is not.
        if (confirmed) connection.reportSuccess('push');
        // Confirmation of a stream already taken as open: the catch-up below has been done.
        const again = confirmed && assumedOpen;
        assumedOpen = !confirmed;
        if (again) return;
        each((s) => {
          s.engine.setOnline(true);
          void s.engine.catchUp().catch(logUnexpected);
          void s.engine.refreshSettings().catch(logUnexpected);
        });
        calendar.onConnected();
      },
      onDisconnected: (e) => {
        assumedOpen = false;
        each((s) => s.engine.setOnline(false));
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
    if (started) each((s) => void s.engine.catchUp().catch(logUnexpected));
  });
  // The browser's word that the network is back is a hint to try, never proof of a connection.
  window.addEventListener('online', () => connection.retryNow());
  // An idle tab makes no requests, and a dropped network leaves the push stream open: find out now.
  window.addEventListener('offline', () => {
    push?.restart();
    if (started) each((s) => void s.engine.catchUp().catch(logUnexpected));
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
  // Back and forward can cross from one mailbox to another.
  window.addEventListener('popstate', () => {
    goHomeIfLost();
    all.show(accountForPath(location.pathname, accounts).id);
  });
  mount(
    () => (
      <ErrorBoundary
        fallback={(e) => {
          console.error(e);
          return <RootFallback error={e} />;
        }}
      >
        <AppContext.Provider value={app}>
          {/* Keyed on the account: a switch re-mounts the shell under that account's base path. */}
          <Show when={cur()} keyed>
            {(space) => (
          <Router base={space.info.base} root={(p) => <Shell {...p} toasts={toasts.Host} confirmHost={confirmDialog.Host} />}>
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
            )}
          </Show>
        </AppContext.Provider>
      </ErrorBoundary>
    ),
  );
}

void boot().catch((e) => {
  console.error(e);
  mount(() => <RootFallback error={e} />);
});
