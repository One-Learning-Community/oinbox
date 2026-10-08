import { createSignal, ErrorBoundary, Show, useContext, type JSX } from 'solid-js';
import { AppContext } from '../app/context';
import { errorDetails } from '../app/errors';

/**
 * Keeps a fault inside one pane, so the rest of the app stays usable.
 * A `silent` pane (the invite card) shows nothing: a card must never get in the way of the mail.
 */
export function PaneBoundary(props: { name: string; silent?: boolean; report?: (e: unknown, where: string) => void; children: JSX.Element }) {
  const app = useContext(AppContext);
  return (
    <ErrorBoundary
      fallback={(err, reset) => {
        (props.report ?? app?.errors.report)?.(err, props.name);
        return (
          <Show when={!props.silent}>
            <PaneFallback error={err} reset={reset} />
          </Show>
        );
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}

function PaneFallback(props: { error: unknown; reset: () => void }) {
  const [copied, setCopied] = createSignal(false);
  const details = errorDetails(props.error);
  return (
    <div class="pane-fallback" role="alert">
      <p>This part of oinbox hit a problem.</p>
      <button type="button" class="btn" onClick={() => props.reset()}>
        Try again
      </button>
      <details>
        <summary>Details</summary>
        <pre>{details}</pre>
        <button type="button" class="btn tonal" onClick={() => void navigator.clipboard?.writeText(details).then(() => setCopied(true))}>
          {copied() ? 'Copied' : 'Copy'}
        </button>
      </details>
    </div>
  );
}
