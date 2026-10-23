import { createSignal, Show } from 'solid-js';
import { branding } from '../app/branding';
import { MAILTO_HANDLER } from '../app/mailto';

/** The part of navigator that makes a site the handler for a kind of link. */
export interface ProtocolApi {
  registerProtocolHandler?(scheme: string, url: string): void;
}

/** Make this app the one email links open in. Chrome, Edge and Firefox can; Safari can't. */
export function EmailLinksSection(props: { nav?: ProtocolApi }) {
  const nav = () => props.nav ?? (navigator as ProtocolApi);
  const [status, setStatus] = createSignal<'idle' | 'asked' | 'failed'>('idle');
  const ask = () => {
    try {
      nav().registerProtocolHandler!('mailto', `${location.origin}${MAILTO_HANDLER}`);
      setStatus('asked');
    } catch {
      setStatus('failed');
    }
  };
  return (
    <section class="settings-section" aria-labelledby="email-links-heading">
      <h2 id="email-links-heading">Email links</h2>
      <Show when={typeof nav().registerProtocolHandler === 'function'} fallback={<p class="settings-note">This browser can't open email links in {branding().name}.</p>}>
        <p>
          <button type="button" onClick={ask}>Open email links in {branding().name}</button>
        </p>
        <Show when={status() === 'asked'}>
          <p class="settings-note" role="status">Your browser should now ask you to allow it, in a bar at the top or an icon in the address bar. Once allowed, email links you click in this browser open a new message here.</p>
        </Show>
        <Show when={status() === 'failed'}>
          <p class="settings-note" role="alert">Your browser refused. It only allows this on a secure (https) connection.</p>
        </Show>
        <p class="settings-note">To go back to another mail app, change the handler for email links in your browser's settings. Installed as an app, {branding().name} may also offer to open email links the first time you click one.</p>
      </Show>
    </section>
  );
}
