import { Navigate, useLocation } from '@solidjs/router';
import { createEffect, createRoot, untrack } from 'solid-js';
import { useApp, type App } from '../app/context';
import { fieldsFromSearch, type MailtoFields } from '../app/mailto';

/**
 * A new message with these fields, once the account is loaded. An email link often starts the app,
 * and a composer opened before the identities are known has no From: it would never save.
 */
export function openWhenReady(app: Pick<App, 'engine' | 'composers'>, fields: MailtoFields): void {
  const filled = !!(fields.to.length || fields.cc.length || fields.bcc.length || fields.subject || fields.bodyHtml);
  // Its own root: the route that asks goes away at once, and this must outlive it.
  createRoot((dispose) => {
    let done = false;
    createEffect(() => {
      if (done || !app.engine.state.ready) return;
      done = true;
      untrack(() => {
        const composer = app.composers.open('new');
        // Nothing to fill in: leave it untouched, so an empty draft is not saved.
        if (filled) composer.update(fields);
      });
      queueMicrotask(dispose);
    });
  });
}

/**
 * /compose: a new message, filled in from an email link when there is one (?mailto=…, see
 * MAILTO_HANDLER), over the Inbox. The app icon's "Compose" shortcut comes here too.
 */
export function ComposeLink() {
  const app = useApp();
  openWhenReady(app, fieldsFromSearch(useLocation().search));
  return <Navigate href="/inbox" />;
}
