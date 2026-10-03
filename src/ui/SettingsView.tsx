import { createSignal, For, Show } from 'solid-js';
import { useApp } from '../app/context';
import { identityLabel } from '../app/settings';
import type { Id } from '../jmap/types';
import { signatureForCompose } from '../mail/settings';
import { IdentityDialog } from './IdentityDialog';
import { VacationForm } from './VacationForm';

export function SettingsView() {
  return (
    <div class="settings">
      <h1>Settings</h1>
      <IdentitiesSection />
      <VacationForm />
    </div>
  );
}

function IdentitiesSection() {
  const { engine, settings } = useApp();
  const [dialog, setDialog] = createSignal<{ id: Id | null } | null>(null);
  const only = () => engine.state.identities.length === 1;

  return (
    <section class="settings-section" aria-labelledby="identities-heading">
      <h2 id="identities-heading">Identities and signatures</h2>
      <Show
        when={engine.state.identities.length}
        fallback={<p class="settings-note">This account has no identity, so it can't send mail. Add one to send.</p>}
      >
        <ul class="identity-list">
          <For each={engine.state.identities}>
            {(i) => (
              <li class="identity-row">
                <div class="identity-main">
                  <div class="identity-name">{identityLabel(i)}</div>
                  <Show when={signatureForCompose(i)} fallback={<div class="signature-preview empty">No signature</div>}>
                    {(html) => <div class="signature-preview" innerHTML={html()} />}
                  </Show>
                </div>
                <div class="identity-actions">
                  <button type="button" class="btn tonal" aria-label={`Edit ${identityLabel(i)}`} onClick={() => setDialog({ id: i.id })}>Edit</button>
                  <button
                    type="button"
                    class="btn tonal"
                    aria-label={only() ? undefined : `Delete ${identityLabel(i)}`}
                    aria-disabled={only()}
                    onClick={() => !only() && void settings.removeIdentity(i.id)}
                  >
                    {only() ? 'Delete (your only identity)' : 'Delete'}
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>
        <p class="settings-note">New messages are sent from the first identity unless you choose another.</p>
      </Show>
      <button type="button" class="btn" onClick={() => setDialog({ id: null })}>Add identity</button>
      <Show when={dialog()} keyed>
        {(d) => <IdentityDialog id={d.id} onClose={() => setDialog(null)} />}
      </Show>
    </section>
  );
}
