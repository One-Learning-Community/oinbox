import { createSignal, Show } from 'solid-js';
import type { OAuth } from '../auth/oauth';

export function SignIn(props: { auth: OAuth; error?: string }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(props.error ?? '');

  const signIn = async () => {
    setBusy(true);
    try {
      const returnTo = location.pathname === '/auth/callback' ? '/' : location.pathname;
      location.assign(await props.auth.authorizationUrl(returnTo));
    } catch (e) {
      setError(`Couldn't start sign-in: ${String((e as Error).message)}`);
      setBusy(false);
    }
  };

  return (
    <div class="center">
      <div class="card">
        <h1 style={{ 'font-weight': 400, margin: '0 0 8px' }}>
          <b style={{ color: 'var(--accent)' }}>o</b>inbox
        </h1>
        <p style={{ color: 'var(--text-2)', margin: '0 0 24px' }}>Sign in with your mail account.</p>
        <Show when={error()}>
          <p class="error" role="alert">{error()}</p>
        </Show>
        <button class="btn" onClick={() => void signIn()} disabled={busy()}>
          {busy() ? 'Redirecting…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
