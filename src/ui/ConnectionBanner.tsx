import { Match, Switch } from 'solid-js';
import type { Connection } from '../sync/connection';

export function ConnectionBanner(props: { connection: Connection; onSignIn: () => void }) {
  return (
    <Switch>
      <Match when={props.connection.state() === 'retrying'}>
        <p class="connection-banner" role="status">
          Can't reach the server. Retrying…
          <button type="button" onClick={() => props.connection.retryNow()}>Retry now</button>
        </p>
      </Match>
      <Match when={props.connection.state() === 'signed-out'}>
        <p class="connection-banner" role="status">
          You've been signed out.
          <button type="button" onClick={props.onSignIn}>Sign in again</button>
        </p>
      </Match>
    </Switch>
  );
}
